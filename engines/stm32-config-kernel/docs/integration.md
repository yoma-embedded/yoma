# yoma / opencode 集成说明(内核侧契约)

内核是无状态 CLI(`stm32kernel`),JSON stdin/stdout。opencode 侧按 yoma-config 既有模式包装成自定义工具(参考 `yoma-config/tool/datasheet_search.ts` 与 `install.ts`):

## TS 工具包装层(后续放到 opencode 仓库,不在本仓库)

- 文件:`~/.config/opencode/tool/stm32_config.ts`,`install.ts` 负责复制内核二进制 + `data/*.irpack` + `data/fw/` 到配置目录。
- 工具 args:`command`(枚举:listMcus/describeMcu/candidates/solveClock/validate/generate)+ `config`(完整配置文档对象)+ 命令特有参数;execute 内用 `Bun.spawn`/`child_process` 调 `stm32kernel <cmd> --config <tmpfile>`,stdout JSON 原样返回给 LLM,`ctx.abort` 接 kill。
- 权限:`ctx.ask({permission: "stm32kernel"})`,agent.ts 的 yoma 权限表加 `stm32kernel: "allow"`(同 datasheet 先例)。
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
