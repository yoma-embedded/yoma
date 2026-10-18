# M2 datasheet v2 客户端对接(yoma-pi)

日期:2026-10-17。范围:`packages/kernel/src/host/tools/datasheet/**`、
`packages/kernel/src/host/domain/datasheet/**`、相关 datasheet 测试、本文件。
服务端(`../rag-codelib` 的 Java v2 实现)由另一会话进行;本文记录**客户端这一侧实际做的改动与证据**,
不宣称远程端到端已经验收。

## 1. 结果概览

| 项                                            | 状态                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| `search` 改调 `POST /api/v2/search`           | 完成                                                         |
| `query` 自然语言 + 新增 `keywords` 英文关键词 | 完成,工具描述要求每次都给并给例子                            |
| 模型给的 `chip` 原样进 `scope.targets`        | 完成(只 trim,不做家族 / 型号推断)                            |
| `rev` 原样进 `scope.docs`                     | 完成                                                         |
| 服务端范围解析 / 分卷 / GENERAL 回退          | 客户端不再重做;v2 分支没有 `resolveChip` / 分卷扇出          |
| 422 `scope_unresolved` + 候选                 | 原样呈现给模型                                               |
| `scope_resolved` / `degraded` / `generation`  | 原样呈现;`scope` / `degraded` / `generation` 也进 details    |
| 每条命中的 `reasons` / `chunk.text_truncated` | 引用下附加 `why:` 行;被 concise 截短时提示走 `read_section`  |
| `score` 跨请求比较                            | 工具描述明确禁止;v2 命中不在客户端排序 / 合并                |
| `chips` 改用 `GET /api/v2/docs`               | 完成;没有 v2 时回落到 `/api/manifest`                        |
| `targets/resolve`                             | 用于 chips 零文档时的候选补充                                |
| `read_section` / `view_figure`                | 代码不变;v2 的 `links.parsed_path` / `image_path` 直接沿用   |
| v1 旧服务器兼容                               | `auto` 只在明确 404/405 回落;422 / 429 / 503 不回落          |
| 显式选版本                                    | `apiVersion: "auto" \| "v1" \| "v2"` 或 `YOMA_DATASHEET_API` |
| 超时 / 取消                                   | 沿用 20 s API / 60 s 产物超时与工具的 abortSignal            |
| 手册库(桌面端)                                | 未改动(不在本任务可写范围;仍读 `/api/manifest`)              |

## 2. 接口版本与回落

```text
apiVersion 解析:显式 options.apiVersion > YOMA_DATASHEET_API > "auto"
```

接口版本只看显式选项与进程环境变量;`<configDir>/.env` 仍只负责服务器地址(地址解析在
`host/datasheet-server.ts`,本次未改)。

| 模式         | 行为                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`(缺省) | 先 `POST /api/v2/search`;只有 HTTP **404 / 405** 才用 `/api/search` 重试,并在回复第一行写明"服务器没有 v2、用了旧接口、keywords 未发送"。 |
| `v1`         | 只走旧接口,不探测 v2;带 `keywords` 时回复里说明它未被发送。                                                                               |
| `v2`         | 只走 v2;404/405 直接报"没有 v2 接口",并说明没有回落、怎么改回 auto。                                                                      |

**422 / 429 / 503 不回落**。它们在 v2 里是服务端在回答(范围解析不出来 / 限流 / 索引不可用)。
把 422 当旧接口会吞掉候选,把 503 当旧接口会拿旧索引的 GENERAL 噪声冒充答案。
`auto` 对旧服务器的代价是每次 search 多一次小的 404 探测;没有做跨调用的版本缓存(简单优先,
也避免服务器升级后进程内一直停在 v1)。

## 3. 请求映射

`POST /api/v2/search` 的请求体由 `domain/datasheet/v2.ts` 的 `buildV2SearchBody` 生成:

```jsonc
{
  "query": "USART 波特率分频怎么算", // 自然语言问题:向量 + 重排用
  "keywords": "USART baud rate USARTDIV BRR mantissa fraction", // 英文关键词:BM25 用
  "scope": { "targets": ["STM32F407VG"], "docs": ["RM0090"], "doc_types": [] },
  "top_k": 6,
  "detail": "concise",
}
```

- `chip` **原样**进 `scope.targets`,不拆分、不改写成家族名;型号 / 家族 / 分卷 / GENERAL 的解析归服务端。
- `rev` **原样**进 `scope.docs`;不传时 `docs: []`。
- `keywords` 为空(或全空白)时字段省略,不发空串。
- `top_k` 夹到 1..20;`detail` 固定 `concise`(要整节走 `read_section`)。
- `generation` / `rerank` 未暴露为工具参数,由服务端缺省策略决定。

## 4. 响应映射

`normalizeV2SearchResponse` / `normalizeV2Hit` 把 v2 命中映射回工具既有的 `SearchHit` 11 个字段,
引用格式、`read_section`、`view_figure` 都不需要改:

| 现有字段      | v2 来源                                                        | 说明                                                                 |
| ------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `text`        | `chunk.text`                                                   |                                                                      |
| `manual_name` | `doc.legacy_name` → `doc.title` → `doc.doc_id` → `doc.doc_uid` | 引用里显示的手册名                                                   |
| `chip`        | `doc.legacy_chip` → `doc.targets[0]`                           | `[GENERAL]` 标签靠它                                                 |
| `rev`         | `doc.doc_id` → `chunk.legacy_rev`                              | **v2 的 `rev` 就是 `scope.docs` 的文档号**,可以原样传回下一次 search |
| `page`        | `chunk.page`                                                   |                                                                      |
| `headings`    | `chunk.heading_path` → `chunk.section_id`                      |                                                                      |
| `score`       | 命中 `score`                                                   | 只在单次响应内可比                                                   |
| `kind`        | `chunk.kind`                                                   |                                                                      |
| `source_pdf`  | —                                                              | v2 的 `doc` 没有这个字段,留空,不拿别的字段冒充                       |
| `parsed_path` | `links.parsed_path`                                            | 与 v1 同义                                                           |
| `image_path`  | `links.image_path`                                             | 与 v1 同义                                                           |

附加到 details 的 v2 字段:`rank`、`reasons`、`doc_id`、`doc_uid`、`targets`、
`legacyRev`(分片的旧卷名,如 `RM0390_p401-800`)。正文引用在 v1 格式后追加
`why: <reasons>`。

`scope_resolved` 的服务端真实形状是 `{targets, ladder, matched, vendors}`(没有 `docs`):

```text
Scope actually used by the server: targets: stm32f407, stm32f4, stm32; ladder: family; matched: stm32f407; vendors: st. ...
```

`degraded` 已知值(`rerank` / `dense` / `sparse` / `ident`)附一句人话解释,未知值原样列出。
全部命中都是 GENERAL 时另有一条提醒(可能降级到了跨芯片范围)。
`chunk.text_truncated`(服务端 `detail:"concise"` 截短正文)会在该条引用下提示
`action "read_section"`;details 的命中摘要带 `textTruncated`。
**v2 的命中顺序不在客户端重排**,`mergeHits` 只属于 v1 的分卷路径。

## 5. 错误体

`parseV2Error` 按服务端真实形状解码:

- v2:`{"error":{"code","message","hint"}}`;`scope_unresolved` 的候选与 `unresolved`
  在**顶层**:`{"candidates":[{"code","level","vendor","title","pattern","matched_by","ancestors"}],
"unresolved":["STM99"]}`(见 `V2ErrorAdvice` / `V2Error.scopeUnresolved`);
- 候选也接受 `error.details.candidates` / `error.data.candidates` / 顶层 `candidates` / `suggestions`;
  候选元素可以是字符串或对象,**对象的 `code` 是服务端的真实字段**(`asStringArray` 已支持);
- v1 风格:`{ "detail": "..." }`(只作为 message 兜底);
- 非 JSON:原文进 `detail`,不抛;先对完整 body 做 `JSON.parse`,再截断展示用 detail,
  超过 2 KB 的候选列表不会因此丢失。

给模型的话按状态分开:

- 422 + `scope_unresolved`: `NO SEARCH PERFORMED … Candidates: …`,并说明服务端自己解析型号 / 家族,
  下一次拿候选当 `chip` 重试;
- 422 其它:`rejected the search request … 服务器本身没问题`;
- 429:限流,等一会儿重试;服务端给了 `Retry-After` 时一并写进回复;
- 413:请求体过大,缩短 query / keywords,服务器本身没问题;
- 503: v2 索引不可用(不是旧服务器、不是名字问题),不要编造;
- 其它非 2xx:沿用 `DATASHEET LOOKUP UNAVAILABLE`。

## 6. chips / docs

- v2:`GET /api/v2/docs`(可带 `?target=`)。服务端真实响应是
  `{docs:[docWithCounts...], total, generation, target_resolved}`;`target_resolved` 为
  `{input, matched, level, matched_by, ancestors}` 或 null。文档按 `legacy_chip` 分组,没有就按
  第一个 `target`,再没有就 `UNFILED`;每个文档的 `doc_id`(其次 `doc_uid`)作为下次 search 的 `rev`。
- `target_resolved` 优先用于判断"解析到了哪一族";列表为空但 `target_resolved` 有值时直接说明,
  不再多打一枪 resolve。
- 文档数就是手册数(v2 迁移把同一本手册的分卷合成一个文档),不再有"分卷算几本"的问题。
- `target` 解析不出来时服务端回 **422** `scope_unresolved`(不是 200 空列表),候选在顶层
  `candidates`;工具直接列候选。
- `docs` 返回 404/405 时 `auto` 回落到 `/api/manifest` 的旧 chips;422/503 同样不回落。
- `/api/v2/docs` 的解码同时容错数组、`{docs:[]}`、`{items:[]}`、`{results:[]}`、`{data:{docs:[]}}`。
- `/api/v2/targets/resolve` 的真实响应是
  `{query, normalized, resolved: boolean, matches:[{code,...}], ancestors, docs, candidates}`;
  解码出 `resolved`(matches[].code + ancestors)、候选 code、文档数。
- **resolve 解析失败仍是 200**:`resolved:false` + `candidates`,不是 422;
  只有 `search` / `docs` 的 scope 解析失败才回 422 `scope_unresolved`。

## 7. 保持不变

- `read_section`:仍读 `/artifacts/<parsed_path>`,本机 markdown 章节抽取。
- `view_figure`:仍读 `/artifacts/<image_path>`,经 `domain/image` 压缩后作为 ImageContent 附上。
- 手册库页(desktop main)与内核 datasheet 地址解析(`host/datasheet-server.ts`)未改。
- v1 的四件客户端补丁完整保留在 `auto → v1` / 显式 `v1` 路径:型号 → 家族解析、分卷展开与合并、
  GENERAL 兜底重查、精确 rev 落空说明。

## 8. 证据(本地)

执行(Windows,Node 24):

```text
npx tsgo --noEmit -p packages/kernel/tsconfig.json
  通过(源码 + test)

npx vitest run --project kernel-domain \
  packages/kernel/test/tools-datasheet.test.ts \
  packages/kernel/test/datasheet-domain.test.ts \
  packages/kernel/test/datasheet-v2.test.ts \
  packages/kernel/test/tools-datasheet-v2.test.ts
  4 files passed / 137 passed / 5 skipped
```

新增用例覆盖:

- `datasheet-v2.test.ts`(25):请求体(原样 scope、空 keywords)、响应映射(含缺字段 / 怪类型 / data 包裹 /
  真实 `scope_resolved`)、`chunk.text_truncated`、scope / degraded(含 `ident`)/ reasons / GENERAL 判定、
  错误体与候选(真实顶层 `candidates[].code`、超过 2 KB 的候选列表)、真实 docs 包裹层与
  `target_resolved`、真实 resolve 形状、docs 分组 / 去重 / 渲染。
- `tools-datasheet-v2.test.ts`(20):真实工具调用经假 v2 服务器验证请求体、引用与 details;
  真实 `V2Error.scopeUnresolved` 形状下的 10 个候选完整显示;422 / 429(带 Retry-After)/ 503 不回落;
  404 自动回落并明说;强制 v1 / v2;`YOMA_DATASHEET_API`;chips v2(含真实 `target_resolved`)/
  回落 / resolve 候选;v2 超时与中止;`read_section` / `view_figure` 沿用 v2 links。
- 原有 `tools-datasheet.test.ts` / `datasheet-domain.test.ts` 全部保留,旧 v1 行为不回归;
  该文件的 `makeTool` 显式 `apiVersion: "v1"`,钉的就是旧接口。
- 真服务器用例仍是 `YOMA_DATASHEET_LIVE=1` 才跑(本次未跑);v2 远程端到端**未验收**。

## 9. 风险 / 已知限制

1. **服务端 v2 代码已在本机工作区写出(未提交),但尚未真联调**(`/api/v2/search`、`docs`、
   `targets/resolve`、错误体已在 `../rag-codelib/src/main` 读到并据此对齐)。客户端解码与假服务器
   已按真实 JSON 形状写好;真实 8309 / 生产环境上的 search / chips / resolve 仍需一次实测。
   `docs` / `targets/resolve` 的包裹层仍保留宽松容错,最终实现若有字段变化不至于炸掉整次调用。
2. **旧服务器每次 search 多一次 404 探测**:没有版本缓存。若在意延迟,可显式
   `YOMA_DATASHEET_API=v1`。
3. **`rev` 的语义变了**:v2 命中里的 `rev` 是 `doc_id`(可以传回 `scope.docs`),
   分片旧卷名只在 details 的 `legacyRev` 里。依赖旧卷名做引用的下游(如果有)要按这个字段调整。
4. **`source_pdf` 在 v2 下为空**:v2 `doc` 不带该字段,没有伪造。
5. **`generation` / `rerank` 未暴露**:客户端不传,使用服务端缺省。
6. **docs 详情 / neighbors 未接入**:客户端目前只用到 search / docs / targets-resolve;
   `/api/v2/docs/{doc_uid}` 与 `/api/v2/chunks/{id}/neighbors` 留给后续(不影响本次四个动作)。
7. **关键词质量未量**:工具描述已强制要求并给例子,但实际检索收益要在 M2 评测里量。
8. **score 语义**:v2 可能来自融合分或重排分,只保证单次响应内可比;工具输出已明确提示。
9. **`text_truncated`**:`detail:"concise"` 下服务端会截短正文;客户端在引用下提示走
   `read_section`,但不会自动再读整节。

## 10. 本轮审查修复(2026-10-17,fix round 1)

- `asStringArray` 支持服务端候选 / 词表项对象的 `code` 字段:此前真实 422 的
  `candidates` 会显示成空,现在 10 个候选 code 完整到模型。
- 工具层 422 回归改用真实 `V2Error.scopeUnresolved` 形状(`error` 对象 + 顶层
  `candidates` / `unresolved`),不再用自编的 `error.candidates` 字符串数组。
- 按服务端真实 JSON 核对并更新三个形状:
  - `scope_resolved = {targets, ladder, matched, vendors}`
  - `docs = {docs, total, generation, target_resolved}`
  - `resolve = {query, normalized, resolved, matches[].code, ancestors, docs, candidates}`
    测试夹具改成这些形状。
- 补充 `degraded: "ident"` 的人话解释与 `chunk.text_truncated` 提示。
- 清理临时复现文件;未读取新题、未改其他分工文件。

## 11. 真实联调用例(默认跳过,2026-10-18 准备)

文件:`packages/kernel/test/datasheet-v2-live.test.ts`。默认 **skip**,只有同时设置两个环境变量
才会发网络请求:

```bash
# 未来先建 SSH 本地隧道(本轮不执行):
ssh -N -L 18309:127.0.0.1:8309 <yoma1>

YOMA_DATASHEET_V2_LIVE=1 \
YOMA_DATASHEET_V2_LIVE_URL=http://127.0.0.1:18309 \
npx vitest run --project kernel-domain packages/kernel/test/datasheet-v2-live.test.ts
```

用例显式 `server: <LIVE_URL>` + `apiVersion:"v2"` + `env: {}`,**不会**回落到内置公共服务或
`YOMA_DATASHEET_SERVER`。

覆盖:

1. `targets/resolve` 真实成功(`STM32F407VG` → resolved/ancestors/docs)。
2. `targets/resolve` 失败的真实形状:**200 + `resolved:false` + candidates**,不是 422。
3. 具体型号 + 英文 keywords 的 search:scope / generation / reasons / parsed_path / 命中顺序。
4. search 的真实 422 `scope_unresolved`:候选 `{code,...}` 完整显示,且不回落 v1。
5. `scope.docs` + `scope.targets` 冲突(`STM32F1` + `RM0390`):真实 422 `scope_conflict`,
   不回落;语料缺夹具时显式 skip 并写明原因。
6. chips:`/api/v2/docs` 列某型号文档、全家族列表;未知 target 的 422 候选完整显示。
7. `read_section` 使用命中自带的 `parsed_path`;artifact 不在时显式 skip。
8. `view_figure` 只在命中带真实 `image_path` 时验证 content type / 字节数;
   没有图或图不可用时显式 skip,不算通过;从不打印 base64。
9. 已中止 AbortSignal 的取消,确定性验证,不依赖慢网络。
10. 最后两个 **raw HTTP 探针**(不是工具调用):64 KiB 以上的 413;有界 14 次无效空 query
    触发 429 + `Retry-After`。这两条不声称"真工具经历过这些码"。

限速纪律:普通 search 至少间隔 1.05 s(默认 60/min、burst 10);GET docs/resolve 不扣搜索桶;
429 探针放在文件最后,只发空 query,不触发 embedding/检索。

日志:按需加 `--reporter=json --outputFile=reports/<日期>-datasheet-v2-live.json`(仓外或
`rag-codelib/reports` 均可);不得写入凭据、请求头或图片数据。

**2026-10-18 15:25 真实执行结果(stage,非生产)**:经 SSH 本地隧道
`127.0.0.1:18309 → yoma1:8309`,12/12 通过(14.74 s),无 skip;覆盖上述全部 10 项(含真实
`scope_conflict`、真实 `view_figure` content type、413 与 429 + `Retry-After`)。日志:
`../rag-codelib/reports/m2-client-live-20261018.log`。429 探针在最后故意耗尽本机来源的搜索桶;
按 1 token/s 回填,约 10 s 恢复。未读取新验收题,未改服务端配置。

**2026-10-18 21:50 正式公网执行结果**：`http://47.122.110.137:8301`，10 passed / 2 skipped，39.86秒。仅用testNamePattern主动排除两个raw HTTP探针，未运行公网429压力测试；section与image实际读取均通过，无缺夹具跳过。服务端已于21:47部署v2。日志`../rag-codelib/reports/m2-client-production-live-20261018.log`；stage的12/12与公网的10/12口径分别保留。没有重启桌面、内核或硬件。
