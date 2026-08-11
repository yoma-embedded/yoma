/**
 * 工具链清单子系统的桶文件:把 schema / locations / ledger / version / resolve
 * 五个模块的公共导出汇总成一个入口。kernel 要 import 这些东西,而深引用要改 4
 * 处别名表才能生效(见根 CLAUDE.md「内核接缝」);中间隔这一层桶文件、再从
 * coding-agent 的主入口整体导出,kernel 只需要认 coding-agent 这一个包名,不用
 * 知道 toolchain 内部按模块拆成了几个文件、以后拆合也不影响它。
 *
 * 五个模块的导出名字互不相撞(没有两个模块导出同名的类型或函数),`export *`
 * 可以放心全量转发,不需要逐个具名。
 */
export * from "./ledger.ts";
export * from "./locations.ts";
export * from "./resolve.ts";
export * from "./schema.ts";
export * from "./version.ts";
