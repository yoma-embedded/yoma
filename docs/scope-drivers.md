# 示波器驱动层:接口、注册表与非目标

2026-09-17。这一版把示波器工具从"只认 SDS824X HD 走 USB"改成"工具层只认一个驱动接口,厂商驱动各自实现"。
思路来自 ngscopeclient(libscopehal 的 `Oscilloscope` 纯虚接口 + 驱动注册表 + 传输层分离 + 能力向驱动查询),
但**没有**把 libscopehal 搬进来:它的每个波形都要一个活的 Vulkan 设备,USBTMC 只在 Linux 编译,上游声明只收人写的代码,
所以是永久 fork。yoma 的 TS 驱动层保留,借它的形状和 Siglent 驱动里的经验。对照分析的全文在会话记录里,本文只写结论与约定。

## 分层

```
tools/scope/contract.ts   给模型看的菜单(动作、参数、结果形状,含 capabilities)
tools/scope/session.ts    租约、队列、arm/collect 状态机、连接与地址;只认 ScopeDriver
tools/scope/evidence.ts   波形 → 磁盘证据(capture.json + cN.i16)+ 文本摘要
domain/scope/driver.ts    ScopeDriver 接口、ScopeDriverSpec、地址 driver@transport、能力枚举的形状
domain/scope/registry.ts  驱动表(siglent,加 YOMA_SCOPE_DEMO=1 时的 demo)、按 *IDN? 自动识别、USB 发现
domain/scope/siglent.ts   Siglent SDS ':' 命令树驱动(SDS800X HD / 1000X HD / 2000X HD / 2000X+ / 3000X HD)
domain/scope/limits.ts    Siglent 型号表:带宽、通道数、命令间隔、按已开通道数分档的存储深度与采样率
domain/scope/demo.ts      无硬件的合成仪器(不进缺省注册表)
domain/scope/scpi.ts      ScpiTransport(TCP 5025 / node-usb USBTMC)+ ScpiClient(单飞、超时残留 drain)
domain/scope/preamble.ts  Siglent WAVEDESC 解析(驱动私有)+ 中性的 VoltScale / TimeScale
domain/scope/analyze.ts   统计与边沿(中性)
domain/scope/store.ts     不可变采集目录(中性)
```

## 五件定死的事(以后改会伤筋动骨)

1. **驱动接口只有中性类型**:通道号、伏/安、秒、int16 码。`Waveform` 不带厂商描述块;Siglent 的 `SiglentWaveform` 是它的子类型,
   `desc` 只给测试和诊断看,`evidence.ts` 不读。接口按工具的 13 个动作反推,不抄 libscopehal 的 150 个虚函数。
2. **设了就读回**:每个 setter 返回 `Applied<T> = { state, mismatches }`,mismatch 是给模型看的整句人话。
   模型看不见屏幕,仪器静默改值(触发源落到 LINE、深度被吃掉)只有这条路能被它知道。
3. **地址 `[driver@]transport`**:`siglent@usb:SN`、`rigol@192.168.1.5:5555`、独立驱动用裸名字(`demo`)。
   裸地址按 `*IDN?` 自动识别。**租约按传输部分算**(`scopeAddressKey`),带不带前缀是同一台仪器。
   config.json 存带前缀的形式(下次直连不用识别);旧的不带前缀的地址照样能读。
4. **capture.json 只加字段、不改语义、不放厂商私有字段**:这一版加了 `driver`、`acquiredAt`(仪器自己的采集时间,
   SDS824X HD 固件 4.8.12.1.1.6.5 的 WAVEDESC 296..309 实测全零,所以现在拿不到)、每通道 `clipped`。
5. **合法取值向驱动问**:`capabilities(status)` 给存储深度、采样率、耦合、探头档位、触发源、量测类型。
   空数组 = 不支持或不知道,不是错误;列表随状态变(深度随已开通道数缩),开关通道后要重读。
   触发 `TriggerSpec` 从一开始就带 `type` 与 `params`(今天只有 edge),以后加脉宽/欠幅不改模型看到的形状。

## 加一个厂商

1. `domain/scope/<vendor>.ts`:`class XScope implements ScopeDriver`,`static open(address, options)`、
   `static attach(client, address, idn)`,以及 `export const X_DRIVER: ScopeDriverSpec`(名字、USB VID、`supports(idn)`、`models()`)。
2. `registry.ts` 的 `scopeDrivers()` 里加一行。
3. `test/scope-drivers.test.ts` 里用 `describeScopeDriver()` 对着一个假仪器跑一遍一致性套件;
   `YOMA_SCOPE_HARDWARE=<address>` 时同一套断言对真机再跑一遍,这就是及格线。
4. 型号真机验过之前,`ScopeModelInfo.verified` 写 `untested`,`warnings` 里说"未验证,读回是唯一真相"。

## Siglent 驱动这一版从 ngscopeclient 移植的经验

- 存储深度**和时基**都放在 AUTO 触发模式的窗口里改(Stop 态下会被仪器吃掉),改完把模式放回去;读回读到连续两次一致为止。
  这是 docs/scope-usb.md 里"设置后读回反复超时、只有断电能恢复"那次事故最可能的线索,**是假设不是结论**,待真机验证。
- 存储深度表:200 MHz 的 SDS800X HD 单通道到 100M、双通道 50M、三四通道 25M;70/100 MHz 各降一档。
  表只用于提示与能力枚举,设置以读回为准。
- 连接时发 `CHDR OFF`,免得别的客户端留下长应答头(`C1:VDIV 1.00E+00`)把数字读坏;固件不认就只在错误队列留一条,顺手吃掉。
- 一窗少给几点不当错(SDS2000X HD 1.2.3.1 不遵守 MAXPoint),按实际交付数推进;总数不对才是错。
- 触发状态词表 Arm/Ready/Auto/Trig'd/Stop/Roll/FStop 之外的回答是失步,立刻报错而不是空转到超时。
- 关着的通道直接拒绝读波形。

## analyze.ts 这一版的算法修正

- **边沿在阈值处插值**:原来在滞回带被穿越的样本处插值,过渡跨多个样本时整条边沿偏晚一个滞回宽度;频率抵消,占空比不抵消。
- **base/top 用直方图众数**(最低/最高四分之一各取一峰,峰内取样本均值),阈值取 `(top+base)/2`,10/90 参考电平也用它们;
  有过冲的方波不再把 90% 线抬到稳态顶之上。分布平坦的信号(三角、噪声)退回 min/max。
- **频率过一致性门后按整段跨度平均**(首末上升沿 / 间隔数),中位数只做门。1234.5 Hz 正弦 20 个周期实测误差 < 1e-4。
- 新字段:`acRms`(纹波)、`top`/`base`/`overshoot`/`undershoot`、`clipped`(贴 ADC 轨 1% 以内的样本数)。
  `details.channels[].units` 逐字段给单位;`duty` 是 0..1,仪器的 DUTY 量测是百分比,两边都标明。

## 不照搬的部分(yoma 反而更强,写下来防止以后"为了像 scopehal"回退)

- 读回 + mismatch 文案。scopehal 盲发 `SendCommandQueued`,headless 下不手动 flush 命令根本发不出去。
- `quality` / `stride` / `recordPoints` 强制不变量。scopehal 波形头没有任何抽样来源信息。
- capture.json 每通道自描述、存原始 int16 加转换参数、读时校验文件大小。scopehal 的 .bin 没有长度和校验,样本数由文件大小推,截断静默变短。
- 从描述块读 WAVE_ARRAY_COUNT、COMM_TYPE、CODE_PER_DIV。scopehal 写死 30 码/格且不读 COMM_TYPE;它自己的 SDS6000A 特例证明常量不可移植。
- 超时残留的 dirty/drain。scopehal 的 USBTMC `FlushRXBuffer` 是空桩。
- 时间轴用 `:TIMebase:SCALe?` 推 t0。scopehal 用 `:ACQUIRE:MDEPTH?`,而它自己注释说这返回的是上限;亚样本触发相位在它那里是死代码。
- 边沿滞回 + 频率一致性门。scopehal 两个边沿就报频率。
- 配置缓存(`FlushConfigCache`)不抄:前面板和 EasyScopeX 在租约外,读通才对。

## 验证状态

- 一致性套件 18 项,对 FakeSds(Siglent)、DemoScope、真机各跑一遍;scope 四个测试文件对假仪器 176 项通过;
  typecheck 11/11 + 根;lint 0 错误。
- **真机已跑(2026-09-17,SDS824X HD 固件 4.8.12.1.1.6.5,USB,C1 悬空、C2 接校准信号)**:
  `YOMA_SCOPE_HARDWARE=usb:SDS08A0D910802 YOMA_SCOPE_HARDWARE_CHANNEL=2 npx vitest run --config vitest.domain.config.ts test/scope-drivers.test.ts`
  54/54(套件跑完把通道、时基、深度、触发放回开始时的状态)。工具层端到端(devices → connect → setup → status → capture →
  measure → screenshot → 单次 capture → samples → 削顶 capture)记录在 `.yoma/scope/acceptance-20260917/`:capture.json 带 `driver`
  与每通道 `clipped`,削顶那次报 `high: 5001` 并在文本里给 CLIPPED 行;connect/status 带 capabilities。AUTO 窗口包时基与深度、
  CHDR OFF、短窗容忍、深度表都在真机上过了。
- 真机上新发现、已进驱动与假仪器(FakeSds)并有测试的四条规矩(细节见 docs/scope-usb.md 的 2026-09-17 补记):
  1. SINGle 模式下没触发就 STOP(或 SINGle 模式下 RUN 再 STOP),preamble 数值全零 —— 驱动报 "no completed acquisition",
     不再是 "invalid verticalGain";`isEmptyWaveDesc()` 在 preamble.ts。
  2. 触发电平按源通道 vdiv/60 量化,mismatch 容差改为 vdiv/20(`LEVEL_TOLERANCE_DIV`)。
  3. 关着的通道上 SCALe/OFFSet 静默丢掉(探头、耦合、带宽、单位、标签照收)—— `setChannel` 先开、设完再关。
  4. `:CHANnel:PROBe VALue,7` 这种菜单外系数照收 —— 能力枚举加 `customProbe`,SDS800X HD 为 true。
- `acquiredAt` 在这台固件上拿不到(WAVEDESC 时间戳全零),字段保留给别的型号。
- 第二个厂商(Rigol DHO 是最自然的下一个)未做:没有仪器就不写驱动,未测的驱动比没有驱动更糟。
- 界面未动:分道、Y 轴固定、游标排序与 1/Δt、标记、密度着色都在后面;`ScopeCaptureInfo` 已经带 `driver` / `acquiredAt` / `clipped`。

## 来源与许可

存储深度/采样率表、直方图 base/top、跨度估频、AUTO 窗口与限速数值来自 ngscopeclient / libscopehal(BSD-3-Clause,
Andrew D. Zonenberg and contributors),以思路与算法移植,未拷贝源码;见 NOTICE。上游声明只接受人写的代码,不要向它提交这里的改动。
