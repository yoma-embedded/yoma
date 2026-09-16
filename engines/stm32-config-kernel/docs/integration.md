# Yoma 集成说明(内核侧契约)

内核是无状态 CLI(`stm32kernel`),JSON stdin/stdout。Yoma 的桌面端和调试台共用 kernel host 的工具包装与本地资源模块。

## TS 工具包装层

- `packages/kernel/src/host/tools/stm32config/{contract.ts,session.ts}` 定义工具契约和执行流程,通过 `runEngine` 调用原生程序并传递取消信号。
- `packages/kernel/src/host/domain/stm32/` 统一准备本机资源。`netlist board_ir` 和 `stm32config` 都从这里取资源,不直接读取安装包的 `data/stm32`。
- 安装包只交付 `stm32kernel` 与 `stm32ck-import`。转换器的 `--probe` 是 CubeMX 数据库位置/版本/家族探测的唯一实现;器件缓存按源数据库与引擎版本生成,HAL/CMSIS 来自用户已下载的本机固件仓库。
- CubeMX 数据库、irpack 与固件数据不上传、不随 Yoma 分发。构建和 staging 不读取它们来决定应用支持哪些芯片族;运行时查询的是用户本机资源。
- **工具描述必须写明**:内核输出是权威;LLM 不得改写 `generate` 产出的任何文件内容;修改配置 = 修改配置文档重新 generate(USER CODE 区段内允许 LLM 写业务代码)。这与 datasheet_search 描述中"确定性寄存器查询为权威"的边界声明互为呼应。

## 供 LLM 的最小工作流

1. `describe-mcu STM32F103C8Tx` → 引脚/外设清单
2. 写配置文档(`schema` 命令可给出 JSON Schema)
3. `validate` → 诊断驱动迭代(诊断带 JSON Pointer path + suggestion,可直接喂给 LLM 修正)
4. `solve-clock`(可选,目标式)→ assignments 补丁合并进文档
5. `generate --out <dir>` → 完整 CMake 工程;`cmake + ninja + arm-none-eabi-gcc` 编译
6. 业务代码写在 USER CODE 区段;重新 generate 会保留(v1.x 落地该特性前:重生成到新目录)

## 确定性承诺

同版本内核 + 同 IR 包 + 同配置文档 → 生成文件字节级相同(无时间戳;文件头只含内核版本与 db 版本)。
