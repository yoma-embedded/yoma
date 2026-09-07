/**
 * 文件可见性策略 —— **浏览器安全**,host 与 renderer 共用这一份。
 *
 * 分两张名单,因为树和提及是两个不同的问题:
 *
 * - `TREE_HIDDEN_NAMES` —— 文件树的隐藏名单,等于 VS Code `files.exclude` 的默认值。
 *   其余一律显示:node_modules、点文件都显示,被 gitignore 的条目带 `ignored` 标记交给
 *   前端灰显。树回答的是"我要看见项目的全貌"。
 *
 * - `MENTION_HIDDEN_NAMES` —— @提及候选的排除名单,在前者之上再加各语言的产物与缓存目录。
 *   提及回答的是"我要挑一个喂给模型",而候选框只有十个槽位,node_modules 能占掉一半。
 *
 * 名单放在这里(而不是 host 里)是因为**两侧都要用**:host 的 `searchFiles` 搜索时据此
 * 不下钻不产出,app 的 @ popover 列一层目录时据此过滤 `file.list` 的结果。各写一份的代价是
 * "搜不到的东西却列得出来",而这种不一致恰恰是本文件要消灭的那一类。
 */

/** 文件树的隐藏名单 = VS Code `files.exclude` 的默认值。 */
export const TREE_HIDDEN_NAMES: ReadonlySet<string> = new Set([".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"])

/**
 * @提及候选的排除名单。
 *
 * **不按"点开头"一刀切**(2026-09-07):从前 `searchFiles` 里那条 `name.startsWith(".")`
 * 顺手把 `.github/workflows/*`、`.gitignore`、`.vscode/*` 也埋了 —— 而文件树是显示点文件的,
 * 于是同一个文件在树里看得见、@ 却搜不到。要挡的从来不是"点开头",是"体量大且没人想提及",
 * 所以逐个列名。`.yoma` 是我们自己在用户工程里的运行产物目录。
 */
export const MENTION_HIDDEN_NAMES: ReadonlySet<string> = new Set([
  ...TREE_HIDDEN_NAMES,
  "node_modules",
  "bower_components",
  ".venv",
  "target",
  "dist",
  "out",
  ".turbo",
  ".next",
  ".cache",
  ".gradle",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".yoma",
])
