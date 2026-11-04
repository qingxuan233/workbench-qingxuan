---
name: webai
description: 【场景：网页AI】网页AI 场景的工作技能：负责调度外部免费网页 AI（DeepSeek、豆包、通义千问、智谱清言、Kimi）、运行顾问团交叉评审、AI生图，把产物与结论写回场景记忆与 _webai产物。触发词：「网页AI」。
---

# 网页AI

1. 先读 `引擎数据\.dsh\场景记忆\网页AI\场景私有记忆.md` 的 §〇 接手。
2. 调用各网页版 AI 的入口：
   - 单站快速问询：`node 外壳\scripts\webai.mjs ask <deepseek|doubao|tongyi|chatglm|kimi> "问题" [--save-image] [--timeout 240]`
   - 多站顾问团交叉汇总：`node 工具\顾问团.mjs "问题" --n 3 --round2 --from 网页AI`
3. 产物落盘在 `_webai产物\` 目录下，在中间预览面板即可直接查看。
4. 机密闸：严禁向网页版 AI 发送密码、Token、API Key、身份证、银行卡等敏感信息（脚本会自动拦截）。
5. 干完把结论写回 §〇 / §五。
6. 给别的场景留言：`node 工具\发消息.mjs --to <场景目录> "内容"`。
