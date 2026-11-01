# autostart_mcp.py —— 启动 Blender 时顺手把 MCP 插件服务拉起来（Blender 侧脚本）
#
# 谁在用它：外壳\main.js 启动 Blender 时带 `--python 这个文件`（只在文件存在时带）。
# 它的职责只有一件：**如果有装 BlenderMCP 这类插件，就替用户点一次"启动服务"**，
# 省得每次都要人去 Blender 侧栏里点。端口固定 9876（跟 main.js 的 BLENDER_MCP_PORT 一致），
# AI 助手靠这个 socket 操作 Blender。
#
# ⚠ 这个脚本本身**不实现**任何协议：它只调用已安装插件自己的入口。插件不在，就只写一行日志、
#   什么都不做（绝不弹错 —— Blender 里 `--python` 抛异常会弹一个吓人的红色报错窗）。
#
# 日志：外壳\data\blender-mcp.log（UTF-8，一行一条）
#
# 注意：文件名保持 ASCII（autostart_mcp.py）—— 中文路径会被 Blender 当成 .blend 文件去加载。

import os
import sys
import time

LOG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'blender-mcp.log')
PORT = int(os.environ.get('DSH_BLENDER_MCP_PORT') or 9876)


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(time.strftime('%H:%M:%S ') + str(msg) + '\n')
    except Exception:
        pass


def main():
    try:
        import bpy  # noqa: F401  —— 不在 Blender 里就没这个东西
    except Exception:
        log('不在 Blender 里运行（import bpy 失败），什么都不做')
        return

    try:
        ver = bpy.app.version_string
    except Exception:
        ver = '?'
    log('Blender %s · 尝试自动启动 MCP 服务（端口 %d）' % (ver, PORT))

    # ① 先看插件是否已经启用（不同来源的插件 module 名不一样，都试一遍）
    mod_names = ['blender_mcp', 'blendermcp', 'blender_mcp_addon', 'mcp_blender']
    mod = None
    for name in mod_names:
        try:
            __import__(name)
            mod = sys.modules.get(name)
            log('找到插件模块：%s' % name)
            break
        except Exception:
            continue

    # ② 没 import 到就直接用 operator 试（有些插件只在 register 后暴露操作符）
    ops_tried = []
    for op_name in ('blendermcp.start_server', 'blender_mcp.start_server', 'mcp.start_server'):
        try:
            parts = op_name.split('.')
            op = getattr(bpy.ops, parts[0])
            fn = getattr(op, parts[1])
            fn()
            log('已通过 bpy.ops.%s 启动服务' % op_name)
            return
        except Exception as e:
            ops_tried.append('%s(%s)' % (op_name, type(e).__name__))

    # ③ 模块里直接有 start_server 函数也试一次
    if mod is not None:
        for fn_name in ('start_server', 'start', 'run_server'):
            fn = getattr(mod, fn_name, None)
            if callable(fn):
                try:
                    fn()
                    log('已通过 %s.%s() 启动服务' % (mod.__name__, fn_name))
                    return
                except Exception as e:
                    log('%s.%s() 失败：%s' % (mod.__name__, fn_name, e))

    log('没找到可用的 BlenderMCP 插件（试过：%s）。'
        '要用 AI 操作 Blender：先在 Blender 里装好该插件并启用，再重启一次。' % ', '.join(ops_tried))


try:
    main()
except Exception as e:      # 绝不让 --python 抛出去（会弹红色报错窗，吓人且没用）
    log('未预期的错误（已忽略）：%r' % (e,))
