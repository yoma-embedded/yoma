import { copyIcons } from "./copy-icons"
import { writeMetainfo } from "./copy-metainfo"
import { describeLicenseBuild, resolveLicenseBuild } from "./license-build.ts"
import { resolveChannel } from "./utils"

// 授权策略先解析:可信公钥给了但不对(格式、编号、测试前缀、两个来源同时给),在这里**非零退出**。
// 没给 = 开发构建,照常往下走(它打不成安装包,那一道在 package:* 的产物检查里)。
// 拦在最前面是为了让错误话术只出现一次、而且在任何产物落盘之前 —— electron-vite 的配置
// 里还有第二道同源的解析,那一道的报错裹在 vite 的堆栈里,不适合给人看。
const licenseBuild = (() => {
  try {
    return resolveLicenseBuild(process.env)
  } catch (error) {
    console.error(`✗ 授权构建配置有问题,构建中止:\n${(error as Error).message}`)
    process.exit(1)
  }
})()
console.log(describeLicenseBuild(licenseBuild))

const channel = resolveChannel()
copyIcons(channel)
writeMetainfo(channel)

// 后端内核是 ../yoma 的源码,由 electron-vite 在构建期 inline 进 out/main/kernel.js
// (见 electron.vite.config.ts)。这里不需要准备任何后端产物。
