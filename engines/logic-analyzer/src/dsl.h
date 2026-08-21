/* .dsl 读取器 —— DSView 的会话文件,也是本引擎采集的输出格式。
 *
 * 文件就是一个 zip:`header`(GKeyFile ini)、`decoders` / `session`(DSView 自己的 JSON,
 * 我们不读)、以及每个逻辑通道一组位面块 `L-<通道>/<块号>`:1 bit/采样、字节内 LSB 优先、
 * 每块 16,777,216 采样(2 MiB),末块按余数截短。格式版本 3(DSView/pv/dsvdef.h)。
 *
 * 不经 libsigrok4DSL 的 session_driver 回放去读,理由:那条路要 ds_lib_init()(起 hotplug
 * 线程、扫 USB),而且把数据重新交织成 LA_CROSS_DATA(布局见 capture.c)再发回调 —— 解码恰恰
 * 要的是每通道独立位面,直接从 zip 读出来就是最终形态,零拷贝喂给 srd_session_send。
 *
 * 两个上游的坑,这里按 session_driver.c 的读法处理:
 *  - 被禁用 / 无数据的通道不写块,`L-<n>/` 有空洞;通道表按 header 的 probe<N> 建,
 *    块目录优先取 `L-<N>/`,不存在时退回"第 i 个 probe ↔ 第 i 个存在的目录"(上游的
 *    channel_dir_map 就是这么做的)。
 *  - v1 格式(单条目 `data`)上游自己已不能回放逻辑数据(assert),这里直接拒绝。 */
#pragma once
#include <stdint.h>

typedef struct {
	int index;      /* header 里的 probe<N>,即物理通道号 */
	char *name;
	int dir;        /* 实际读的 L-<dir>,-1 = 没有块(常量/未采) */
	uint8_t *bits;  /* 位面,dsl_load_channel 之后有效;长度 = bits_len */
	uint64_t bits_len;
} dsl_channel;

typedef struct {
	char *path;
	int version;
	int device_mode;        /* 0 = LOGIC */
	uint64_t samplerate;    /* Hz */
	uint64_t total_samples;
	int total_blocks;
	int64_t trigger_pos;    /* 采样号;header 没写时 -1 */
	int nchannels;
	dsl_channel *ch;
	void *zip;              /* unzFile */
} dsl_file;

/* 打开并解析 header;不读位面。失败返回非 0 并在 *err 给出人话(g_free 释放)。 */
int dsl_open(const char *path, dsl_file **out, char **err);
/* 把第 i 个通道的全部块读进内存(幂等)。 */
int dsl_load_channel(dsl_file *f, int i, char **err);
/* 按物理通道号或名字找通道,返回 ch[] 下标,找不到 -1。 */
int dsl_find_channel(const dsl_file *f, const char *ref);
void dsl_close(dsl_file *f);
