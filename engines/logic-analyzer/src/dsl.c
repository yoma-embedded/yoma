#include "dsl.h"
#include <glib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <minizip/unzip.h>
#include <libsigrok.h>

#define LEAF_BLOCK_SAMPLES (1ULL << 24)

static int zip_has(unzFile z, const char *name) { return unzLocateFile(z, name, 0) == UNZ_OK; }

static int zip_read_all(unzFile z, const char *name, uint8_t **buf, uint64_t *len, char **err) {
	unz_file_info64 info;
	if (unzLocateFile(z, name, 0) != UNZ_OK) { *err = g_strdup_printf("缺少条目 %s", name); return 1; }
	if (unzGetCurrentFileInfo64(z, &info, NULL, 0, NULL, 0, NULL, 0) != UNZ_OK) { *err = g_strdup_printf("读不到条目信息 %s", name); return 1; }
	if (unzOpenCurrentFile(z) != UNZ_OK) { *err = g_strdup_printf("打不开条目 %s", name); return 1; }
	uint8_t *b = g_malloc(info.uncompressed_size + 1);
	int n = unzReadCurrentFile(z, b, (unsigned)info.uncompressed_size);
	unzCloseCurrentFile(z);
	if (n < 0 || (uint64_t)n != info.uncompressed_size) { g_free(b); *err = g_strdup_printf("条目 %s 读取不完整", name); return 1; }
	b[info.uncompressed_size] = 0;
	*buf = b; *len = info.uncompressed_size;
	return 0;
}

/* 同上,但直接解压进调用方的缓冲(unzReadCurrentFile 本来就收缓冲)。位面块一块 2 MiB、
 * 一个通道几十块,走 zip_read_all 就是每块一次 malloc + 一次全量 memcpy + 一次 free。
 * 放不下的尾巴丢掉(与旧的 memcpy 截断同义):.dsl 的块按 total samples 切,末块常有余量。 */
static int zip_read_into(unzFile z, const char *name, uint8_t *dst, uint64_t cap, uint64_t *len, char **err) {
	unz_file_info64 info;
	if (unzLocateFile(z, name, 0) != UNZ_OK) { *err = g_strdup_printf("缺少条目 %s", name); return 1; }
	if (unzGetCurrentFileInfo64(z, &info, NULL, 0, NULL, 0, NULL, 0) != UNZ_OK) { *err = g_strdup_printf("读不到条目信息 %s", name); return 1; }
	uint64_t take = info.uncompressed_size < cap ? info.uncompressed_size : cap;
	if (unzOpenCurrentFile(z) != UNZ_OK) { *err = g_strdup_printf("打不开条目 %s", name); return 1; }
	int n = unzReadCurrentFile(z, dst, (unsigned)take);
	unzCloseCurrentFile(z);
	if (n < 0 || (uint64_t)n != take) { *err = g_strdup_printf("条目 %s 读取不完整", name); return 1; }
	*len = take;
	return 0;
}

static int cmp_int(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }

int dsl_open(const char *path, dsl_file **out, char **err) {
	*err = NULL;
	unzFile z = unzOpen64(path);
	if (!z) { *err = g_strdup_printf("打不开 %s(不是 zip,或文件不存在)", path); return 1; }

	uint8_t *hdr; uint64_t hdr_len;
	if (zip_read_all(z, "header", &hdr, &hdr_len, err)) { unzClose(z); return 1; }

	GKeyFile *kf = g_key_file_new();
	GError *gerr = NULL;
	if (!g_key_file_load_from_data(kf, (const char *)hdr, hdr_len, G_KEY_FILE_NONE, &gerr)) {
		*err = g_strdup_printf("header 不是合法的 ini:%s", gerr ? gerr->message : "?");
		g_clear_error(&gerr); g_free(hdr); g_key_file_free(kf); unzClose(z);
		return 1;
	}
	g_free(hdr);

	dsl_file *f = g_new0(dsl_file, 1);
	f->path = g_strdup(path);
	f->zip = z;
	f->trigger_pos = -1;
	f->version = g_key_file_has_key(kf, "version", "version", NULL) ? g_key_file_get_integer(kf, "version", "version", NULL) : 1;
	if (f->version < 2) {
		*err = g_strdup_printf("这是 v%d 格式的 .dsl,DSView 自己也已不能回放它的逻辑数据;用较新的 DSView 重新保存一次", f->version);
		g_key_file_free(kf); dsl_close(f);
		return 1;
	}

	gsize nkeys = 0;
	char **keys = g_key_file_get_keys(kf, "header", &nkeys, NULL);
	int probe_idx[128]; int nprobes = 0;
	for (gsize i = 0; keys && i < nkeys; i++) {
		const char *k = keys[i];
		char *v = g_key_file_get_string(kf, "header", k, NULL);
		if (!v) continue;
		if (!strcmp(k, "device mode")) f->device_mode = atoi(v);
		else if (!strcmp(k, "samplerate")) { uint64_t sr = 0; if (sr_parse_sizestring(v, &sr) == SR_OK) f->samplerate = sr; }
		else if (!strcmp(k, "total samples")) f->total_samples = strtoull(v, NULL, 10);
		else if (!strcmp(k, "total blocks")) f->total_blocks = atoi(v);
		else if (!strcmp(k, "trigger pos")) f->trigger_pos = strtoll(v, NULL, 10);
		else if (!strncmp(k, "probe", 5) && g_ascii_isdigit(k[5]) && nprobes < 128) probe_idx[nprobes++] = atoi(k + 5);
		g_free(v);
	}
	if (f->device_mode != 0) {
		*err = g_strdup_printf("device mode=%d 不是逻辑分析仪数据(DSO/模拟暂不支持)", f->device_mode);
		g_strfreev(keys); g_key_file_free(kf); dsl_close(f);
		return 1;
	}
	if (f->total_blocks <= 0) f->total_blocks = (int)((f->total_samples + LEAF_BLOCK_SAMPLES - 1) / LEAF_BLOCK_SAMPLES);
	qsort(probe_idx, nprobes, sizeof(int), cmp_int);

	/* 存在的 L-<n>/0 目录,升序 */
	int dirs[128]; int ndirs = 0;
	for (int n = 0; n < 128; n++) {
		char name[32]; snprintf(name, sizeof name, "L-%d/0", n);
		if (zip_has(z, name)) dirs[ndirs++] = n;
	}

	f->nchannels = nprobes;
	f->ch = g_new0(dsl_channel, nprobes);
	int exact = 1;
	for (int i = 0; i < nprobes; i++) {
		char key[16]; snprintf(key, sizeof key, "probe%d", probe_idx[i]);
		f->ch[i].index = probe_idx[i];
		f->ch[i].name = g_key_file_get_string(kf, "header", key, NULL);
		f->ch[i].dir = -1;
		char name[32]; snprintf(name, sizeof name, "L-%d/0", probe_idx[i]);
		if (!zip_has(z, name)) exact = 0;
	}
	if (exact) {
		for (int i = 0; i < nprobes; i++) f->ch[i].dir = f->ch[i].index;
	} else {
		/* 上游 channel_dir_map 的读法:第 i 个 probe ↔ 第 i 个存在的目录 */
		for (int i = 0; i < nprobes && i < ndirs; i++) f->ch[i].dir = dirs[i];
	}
	g_strfreev(keys);
	g_key_file_free(kf);
	*out = f;
	return 0;
}

int dsl_load_channel(dsl_file *f, int i, char **err) {
	*err = NULL;
	if (i < 0 || i >= f->nchannels) { *err = g_strdup("通道下标越界"); return 1; }
	dsl_channel *c = &f->ch[i];
	if (c->bits) return 0;
	uint64_t need = (f->total_samples + 7) / 8;
	/* 多留 8 字节:解码器按 8 采样对齐往前读,末尾不越界 */
	c->bits = g_malloc0(need + 16);
	c->bits_len = need;
	if (c->dir < 0) return 0; /* 没有块:全 0 */
	uint64_t off = 0;
	for (int b = 0; b < f->total_blocks; b++) {
		char name[32]; snprintf(name, sizeof name, "L-%d/%d", c->dir, b);
		uint64_t len = 0;
		if (zip_read_into(f->zip, name, c->bits + off, off < need + 8 ? need + 8 - off : 0, &len, err)) {
			if (b > 0 && off >= need) { g_free(*err); *err = NULL; break; } /* 末块可能不存在 */
			return 1;
		}
		off += len;
	}
	return 0;
}

int dsl_find_channel(const dsl_file *f, const char *ref) {
	char *end = NULL;
	long n = strtol(ref, &end, 10);
	if (end && *end == 0 && end != ref) {
		for (int i = 0; i < f->nchannels; i++) if (f->ch[i].index == n) return i;
		return -1;
	}
	for (int i = 0; i < f->nchannels; i++) if (f->ch[i].name && g_ascii_strcasecmp(f->ch[i].name, ref) == 0) return i;
	/* 也接受 D3 这种写法 */
	if ((ref[0] == 'D' || ref[0] == 'd') && g_ascii_isdigit(ref[1])) return dsl_find_channel(f, ref + 1);
	return -1;
}

void dsl_close(dsl_file *f) {
	if (!f) return;
	for (int i = 0; i < f->nchannels; i++) { g_free(f->ch[i].name); g_free(f->ch[i].bits); }
	g_free(f->ch);
	if (f->zip) unzClose((unzFile)f->zip);
	g_free(f->path);
	g_free(f);
}
