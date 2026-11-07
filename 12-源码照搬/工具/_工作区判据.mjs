// 工作区判据（体检 A16 的第 ③ 条）：**每一张登记过的工作区**都必须有效。
//
// 为什么单独成文件：体检.mjs 是「存量超大文件」，代码红线规定存量只许变短（≤887 行），
// 新增判据不能把它撑大（2026-11-07 踩过一次：+21 行直接红）。
//
// 判据同 A16 的 ①：路径存在，且落在 $APP 内或有 外壳\main.js —— 只判可修、可证伪的登记项。
/**
 * @param {{tables: Record<string, {path?: string}>, wsFile: string, defId: string,
 *          exists: (p: string) => boolean, valid: (p: string) => boolean}} a
 * @returns {Array<{path: string, msg: string}>}
 */
export function staleWorkspaceFindings({ tables, wsFile, defId, exists, valid }) {
  const f = [];
  for (const [id, rec] of Object.entries(tables)) {
    const p = String((rec && rec.path) || '');
    if (id === defId || !p) continue;                    // 默认工作区由 A16 ① 判过
    if (!exists(p)) f.push({ path: wsFile, msg: `登记工作区路径不存在：${id} ⇒ ${p}` });
    else if (!valid(p)) f.push({ path: wsFile, msg: `登记工作区路径已失效（不在本工作台内、也没有 外壳\\main.js）：${id} ⇒ ${p}` });
  }
  return f;
}
