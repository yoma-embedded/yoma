/* yoma-la devices / capture —— libsigrok4DSL 的 ds_* 门面。参数一览见 main.c 的 usage()。
 *
 * 进程模型(与 DSView 的 SigSession 同构):ds_lib_init() 起 hotplug 线程并扫 USB;ds_start_collect()
 * 再起一条采集线程,数据与事件都在**库的线程**上回调;主线程只等一个条件变量。一次采集一个进程,
 * 进程退出 = 全部清理(探针租约、gdb 会话表那套"模块级全局"的老问题在这里不存在)。
 *
 * LA_CROSS_DATA:硬件、文件回放、demo 三条路发的都是同一种布局 —— 64 位字按通道轮转:
 *   word[0]=ch0 的采样 0..63,word[1]=ch1 的 0..63,…,word[N-1],word[N]=ch0 的 64..127,…
 * 每个字内 LSB 是最早的采样。唯一的规范是 DSView/pv/data/logicsnapshot.cpp 的 append_cross_payload
 * (chans_read_addr[i] = src + i;*write++ = *read; read += N)。这里按"全局字序号 g:通道 = g % N、
 * 字位置 = g / N"还原(用进位计数器,见 put_word),跨包的不足 8 字节用一个小 carry 续上。
 * 写错不报错、表现像噪声,所以有 `--device file:<.dsl>` 这条路:session_driver 把每通道块按同样
 * 规则交织后发回来,采到的 .dsl 必须与输入逐块字节相同 —— 那是这段代码的闸门。
 *
 * 输出:<out>/<name>.dsl(格式见 dsl.h,DSView GUI 可直接打开)+ stdout 一行 JSON 报告。先写
 * <name>.dsl.partial 再 rename,被 killTree 硬杀时留下的是一个明显作废的文件,不是一个看起来
 * 合法、实际截断的 .dsl。 */
#include "engine.h"
#include "jsonw.h"
#include <glib.h>
#include <glib/gstdio.h>
#include <libsigrok.h>
#include <libsigrok-internal.h>
#include <hardware/DSL/dsl.h>
#include <minizip/zip.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

SR_PRIV int dsl_hdl_version(const struct sr_dev_inst *sdi, uint8_t *value);

#define HEADER_FORMAT_VERSION 3
#define LEAF_BLOCK_SAMPLES (1ULL << 24)
#define MAX_CH 64

/* ---------------------------------------------------------------- 采集状态 */
typedef struct {
	int nch;                       /* 使能通道数 = LA_CROSS_DATA 的轮转周期 */
	int phys[MAX_CH];              /* 第 i 个使能通道的物理编号 */
	char *names[MAX_CH];
	uint8_t *bits[MAX_CH];         /* 每通道位面,cap_bytes 字节 */
	uint64_t cap_samples;          /* 容量(= limit,向上对齐到 64)*/
	uint64_t cap_bytes;
	uint64_t words;                /* 收到的 64 位字总数(跨通道)*/
	int wch; uint64_t wk;          /* 下一个字落在哪:通道 / 该通道的第几个字 */
	uint8_t carry[8]; int carry_len;
	uint64_t bytes_in;
	int packets;
	int trig_fired; uint64_t trig_pos;
	int overflow; int data_error;
	GMutex lock; GCond cond;
	int ended;                     /* 收到 SR_DF_END */
	int finished;                  /* 采集线程结束(任何原因)*/
	int finished_event;
} cap_state;

static cap_state *G;               /* 回调没有 user data 参数,只能全局 */

static void on_event(int ev) {
	if (!G) return;
	if (ev == DS_EV_COLLECT_TASK_END || ev == DS_EV_COLLECT_TASK_END_BY_ERROR || ev == DS_EV_COLLECT_TASK_END_BY_DETACHED) {
		g_mutex_lock(&G->lock);
		G->finished = 1; G->finished_event = ev;
		g_cond_broadcast(&G->cond);
		g_mutex_unlock(&G->lock);
	}
}

static inline void put_word(cap_state *s, uint64_t w) {
	/* 位置用进位计数器推进:一次采集有上亿个字,g % nch / g / nch 是两次真的 64 位除法 */
	int ch = s->wch;
	uint64_t k = s->wk;
	s->words++;
	if (++s->wch == s->nch) { s->wch = 0; s->wk++; }
	if (k * 64 >= s->cap_samples) return;
	memcpy(s->bits[ch] + k * 8, &w, 8);  /* 小端:字节 j 的位 b = 采样 j*8+b,与 .dsl 位面一致 */
}

static void on_data(const struct sr_dev_inst *sdi, const struct sr_datafeed_packet *pkt) {
	(void)sdi;
	cap_state *s = G;
	if (!s) return;
	switch (pkt->type) {
	case SR_DF_LOGIC: {
		const struct sr_datafeed_logic *l = pkt->payload;
		if (pkt->status != SR_PKT_OK) s->data_error = 1;
		if (l->format != LA_CROSS_DATA) { s->data_error = 2; return; }
		const uint8_t *p = l->data; uint64_t n = l->length;
		s->bytes_in += n; s->packets++;
		/* 续上上一包的零头 */
		while (s->carry_len && n) { s->carry[s->carry_len++] = *p++; n--; if (s->carry_len == 8) { uint64_t w; memcpy(&w, s->carry, 8); put_word(s, w); s->carry_len = 0; } }
		while (n >= 8) { uint64_t w; memcpy(&w, p, 8); put_word(s, w); p += 8; n -= 8; }
		while (n) { s->carry[s->carry_len++] = *p++; n--; }
		break;
	}
	case SR_DF_TRIGGER: {
		const struct ds_trigger_pos *t = pkt->payload;
		if (t->status & 0x01) { s->trig_fired = 1; s->trig_pos = t->real_pos; }
		break;
	}
	case SR_DF_OVERFLOW: s->overflow = 1; break;
	case SR_DF_END:
		g_mutex_lock(&s->lock); s->ended = 1; g_cond_broadcast(&s->cond); g_mutex_unlock(&s->lock);
		break;
	default: break;
	}
}

/* ---------------------------------------------------------------- 库起停 */
static int lib_up(const char *res_cli, char **err) {
	char *res = resolve_res_dir(res_cli);
	if (!res) { *err = g_strdup("找不到固件目录 res/(传 --res,或设 YOMA_LA_RES,或放在 <exe>/../data/la/res)"); return 1; }
	ds_set_firmware_resource_dir(res);
	/* demo 驱动在 <user dir>/demo/logic/ 下找 .demo 样例;我们的布局里 demo/ 与 res/ 是兄弟 */
	char *usr = g_path_get_dirname(res);
	ds_set_user_data_dir(usr);
	g_free(usr);
	g_free(res);
	ds_log_level(g_getenv("YOMA_LA_SRLOG") ? atoi(g_getenv("YOMA_LA_SRLOG")) : 1);
	ds_set_event_callback(on_event);
	ds_set_datafeed_callback(on_data);
	int r = ds_lib_init();
	if (r != SR_OK) { *err = g_strdup_printf("ds_lib_init 失败(%d)", r); return 1; }
	return 0;
}

static void lib_down(void) {
	if (ds_have_actived_device()) ds_release_actived_device();
	ds_lib_exit();
}

static const struct DSL_profile *profile_of(const struct sr_dev_inst *di) {
	if (!di || di->dev_type != DEV_TYPE_USB || !di->priv) return NULL;
	const struct DSL_context *devc = di->priv;
	return devc->profile;
}

static int is_demo_name(const char *n) { return n && (g_str_has_prefix(n, "Demo") || g_str_has_prefix(n, "demo") || g_str_has_prefix(n, "virtual")); }

/* 把当前激活设备的信息写成 JSON 对象 */
static void device_json(FILE *f) {
	struct ds_device_full_info info; memset(&info, 0, sizeof info);
	ds_get_actived_device_info(&info);
	const struct sr_dev_inst *di = info.di;
	const struct DSL_profile *pf = profile_of(di);
	int first = 1;
	fputc('{', f);
	jw_kv_str(f, &first, "name", info.name);
	jw_kv_str(f, &first, "driver", info.driver_name);
	jw_kv_str(f, &first, "type", info.dev_type == DEV_TYPE_USB ? "usb" : info.dev_type == DEV_TYPE_FILELOG ? "file" : "demo");
	if (pf) {
		jw_kv_str(f, &first, "vendor", pf->vendor);
		jw_kv_str(f, &first, "model", pf->model);
		jw_kv_key(f, &first, "vid"); fprintf(f, "\"%04X\"", pf->vid);
		jw_kv_key(f, &first, "pid"); fprintf(f, "\"%04X\"", pf->pid);
		jw_kv_str(f, &first, "usb_speed", pf->usb_speed == LIBUSB_SPEED_SUPER ? "super" : "high");
		jw_kv_str(f, &first, "fpga_bitstream", pf->fpga_bit33);
		jw_kv_u64(f, &first, "hw_depth_bits", pf->dev_caps.hw_depth);
		jw_kv_i64(f, &first, "channels", pf->dev_caps.total_ch_num);
		jw_kv_key(f, &first, "features"); fputc('[', f);
		int ffeat = 1;
		#define FEAT(bit, name) if (pf->dev_caps.feature_caps & (bit)) { if (!ffeat) fputc(',', f); jw_str(f, name); ffeat = 0; }
		FEAT(CAPS_FEATURE_VTH, "vth"); FEAT(CAPS_FEATURE_BUF, "buffer"); FEAT(CAPS_FEATURE_SEEP, "seep");
		FEAT(CAPS_FEATURE_MAX25_VTH, "max25_vth"); FEAT(CAPS_FEATURE_SECURITY, "security"); FEAT(CAPS_FEATURE_USB30, "usb30");
		#undef FEAT
		fputc(']', f);
		uint8_t hdl = 0;
		if (dsl_hdl_version(di, &hdl) == SR_OK) {
			jw_kv_i64(f, &first, "hdl_version", hdl);
			jw_kv_i64(f, &first, "hdl_expected", DSL_HDL_VERSION);
		}
		jw_kv_key(f, &first, "channel_modes"); fputc('[', f);
		int fmode = 1;
		for (unsigned i = 0; i < G_N_ELEMENTS(channel_modes); i++) {
			if (channel_modes[i].mode != LOGIC || !(pf->dev_caps.channels & (1u << i))) continue;
			if (!fmode) fputc(',', f);
			fmode = 0;
			int fm = 1;
			fputc('{', f);
			jw_kv_i64(f, &fm, "id", channel_modes[i].id);
			jw_kv_bool(f, &fm, "stream", channel_modes[i].stream);
			jw_kv_i64(f, &fm, "channels", channel_modes[i].num);
			jw_kv_u64(f, &fm, "max_samplerate", channel_modes[i].max_samplerate);
			jw_kv_str(f, &fm, "desc", channel_modes[i].descr);
			fputc('}', f);
		}
		fputc(']', f);
	}
	GVariant *gv = NULL;
	if (ds_get_actived_device_config_list(NULL, SR_CONF_SAMPLERATE, &gv) == SR_OK && gv) {
		GVariant *arr = g_variant_lookup_value(gv, "samplerates", G_VARIANT_TYPE("at"));
		if (arr) {
			gsize n = 0; const uint64_t *rates = g_variant_get_fixed_array(arr, &n, sizeof(uint64_t));
			jw_kv_key(f, &first, "samplerates"); fputc('[', f);
			for (gsize i = 0; i < n; i++) { if (i) fputc(',', f); jw_u64(f, rates[i]); }
			fputc(']', f);
			g_variant_unref(arr);
		}
		g_variant_unref(gv);
	}
	gv = NULL;
	if (ds_get_actived_device_config(NULL, NULL, SR_CONF_HW_DEPTH, &gv) == SR_OK && gv) { jw_kv_u64(f, &first, "depth_per_channel", g_variant_get_uint64(gv)); g_variant_unref(gv); }
	gv = NULL;
	if (ds_get_actived_device_config(NULL, NULL, SR_CONF_SAMPLERATE, &gv) == SR_OK && gv) { jw_kv_u64(f, &first, "samplerate", g_variant_get_uint64(gv)); g_variant_unref(gv); }
	gv = NULL;
	if (ds_get_actived_device_config(NULL, NULL, SR_CONF_VTH, &gv) == SR_OK && gv) { jw_kv_double(f, &first, "vth", g_variant_get_double(gv)); g_variant_unref(gv); }
	jw_kv_key(f, &first, "channel_names"); fputc('[', f);
	int fname = 1;
	for (GSList *l = ds_get_actived_device_channels(); l; l = l->next) {
		struct sr_channel *ch = l->data;
		if (ch->type != SR_CHANNEL_LOGIC) continue;
		if (!fname) fputc(',', f);
		fname = 0;
		int fc = 1;
		fputc('{', f);
		jw_kv_i64(f, &fc, "index", ch->index);
		jw_kv_str(f, &fc, "name", ch->name);
		jw_kv_bool(f, &fc, "enabled", ch->enabled);
		fputc('}', f);
	}
	fputc(']', f);
	fputc('}', f);
}

int cmd_devices(int argc, char **argv) {
	const char *res = NULL;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--json")) continue;
		if (!strcmp(argv[i], "--res") && i + 1 < argc) { res = argv[++i]; continue; }
		note("devices:不认识的参数 %s", argv[i]); return 2;
	}
	char *err = NULL;
	if (lib_up(res, &err)) { note("%s", err); g_free(err); return 1; }
	struct ds_device_base_info *list = NULL; int n = 0;
	ds_get_device_list(&list, &n);
	fputs("{\"devices\":[", stdout);
	int printed = 0;
	for (int i = 0; i < n; i++) {
		if (is_demo_name(list[i].name)) continue;
		if (ds_active_device(list[i].handle) != SR_OK) {
			if (printed) fputc(',', stdout);
			fputs("{\"name\":", stdout); jw_str(stdout, list[i].name);
			fputs(",\"error\":\"打不开(被 DSView 或别的进程占着?固件/位流缺失?用 YOMA_LA_SRLOG=4 看库日志)\"}", stdout);
			printed++;
			continue;
		}
		if (printed) fputc(',', stdout);
		device_json(stdout);
		printed++;
		ds_release_actived_device();
	}
	fputs("],\"count\":", stdout); jw_i64(stdout, printed);
	fputs("}\n", stdout);
	g_free(list);
	lib_down();
	return 0;
}

/* ---------------------------------------------------------------- capture */
static int parse_size(const char *s, uint64_t *out) { return sr_parse_sizestring(s, out) == SR_OK && *out > 0; }

static int pick_channel_mode(const struct DSL_profile *pf, int stream, int need_channels, uint64_t rate, int *mode_id) {
	/* 在该型号支持的模式里,挑"通道数够 & 采样率够"且通道数最多的那个 */
	int best = -1; int best_num = 0;
	for (unsigned i = 0; i < G_N_ELEMENTS(channel_modes); i++) {
		const struct DSL_channels *m = &channel_modes[i];
		if (m->mode != LOGIC || (m->stream ? 1 : 0) != stream || !(pf->dev_caps.channels & (1u << i))) continue;
		if (m->num < need_channels || m->max_samplerate < rate || m->min_samplerate > rate) continue;
		if (m->num > best_num) { best = (int)m->id; best_num = m->num; }
	}
	*mode_id = best;
	return best >= 0;
}

static int write_dsl(const char *path, cap_state *s, uint64_t samplerate, uint64_t samples, const char *driver, char **err) {
	zipFile z = zipOpen64(path, APPEND_STATUS_CREATE);
	if (!z) { *err = g_strdup_printf("创建不了 %s", path); return 1; }
	zip_fileinfo zi; memset(&zi, 0, sizeof zi);
	GString *h = g_string_new("");
	g_string_append_printf(h, "[version]\nversion = %d\n[header]\n", HEADER_FORMAT_VERSION);
	g_string_append_printf(h, "driver = %s\ndevice mode = 0\ncapturefile = data\n", driver);
	g_string_append_printf(h, "total samples = %" G_GUINT64_FORMAT "\n", samples);
	int blocks = (int)((samples + LEAF_BLOCK_SAMPLES - 1) / LEAF_BLOCK_SAMPLES);
	if (blocks == 0) blocks = 1;
	g_string_append_printf(h, "total probes = %d\ntotal blocks = %d\n", s->nch, blocks);
	char *rs = sr_samplerate_string(samplerate);
	g_string_append_printf(h, "samplerate = %s\n", rs); g_free(rs);
	g_string_append_printf(h, "trigger time = %" G_GINT64_FORMAT "\n", (gint64)(g_get_real_time() / 1000));
	g_string_append_printf(h, "trigger pos = %" G_GUINT64_FORMAT "\n", s->trig_fired ? s->trig_pos : 0);
	for (int i = 0; i < s->nch; i++) g_string_append_printf(h, "probe%d = %s\n", s->phys[i], s->names[i] ? s->names[i] : "");
	for (int i = 0; i < s->nch; i++) g_string_append_printf(h, " enable%d = 1\n", i);
	int rc = 0;
	#define ADD(name, buf, len) do { \
		if (zipOpenNewFileInZip64(z, name, &zi, NULL, 0, NULL, 0, NULL, Z_DEFLATED, 1, 1) != ZIP_OK || \
		    zipWriteInFileInZip(z, buf, (unsigned)(len)) != ZIP_OK || zipCloseFileInZip(z) != ZIP_OK) { *err = g_strdup_printf("写 zip 条目 %s 失败", name); rc = 1; goto out; } } while (0)
	ADD("header", h->str, h->len);
	ADD("decoders", "[]", 2);
	for (int c = 0; c < s->nch && rc == 0; c++) {
		for (int b = 0; b < blocks; b++) {
			uint64_t first = (uint64_t)b * LEAF_BLOCK_SAMPLES;
			uint64_t count = samples - first; if (count > LEAF_BLOCK_SAMPLES) count = LEAF_BLOCK_SAMPLES;
			char name[32]; snprintf(name, sizeof name, "L-%d/%d", s->phys[c], b);
			ADD(name, s->bits[c] + first / 8, count / 8);
		}
	}
	#undef ADD
out:
	g_string_free(h, TRUE);
	zipClose(z, NULL);
	return rc;
}

int cmd_capture(int argc, char **argv) {
	const char *out_dir = NULL, *name = "capture", *res = NULL, *device = "auto", *ch_spec = NULL, *trig_spec = NULL, *mode = "buffer";
	const char *rate_s = NULL, *samples_s = NULL;
	double vth = -1; int pos = -1; long duration_ms = 0; long timeout_ms = 0;
	for (int i = 1; i < argc; i++) {
		#define ARG(flag, var) if (!strcmp(argv[i], flag) && i + 1 < argc) { var = argv[++i]; continue; }
		ARG("--out", out_dir) ARG("--name", name) ARG("--res", res) ARG("--device", device) ARG("--ch", ch_spec)
		ARG("--trigger", trig_spec) ARG("--mode", mode) ARG("--rate", rate_s) ARG("--samples", samples_s)
		#undef ARG
		if (!strcmp(argv[i], "--vth") && i + 1 < argc) { vth = g_ascii_strtod(argv[++i], NULL); continue; }
		if (!strcmp(argv[i], "--pos") && i + 1 < argc) { pos = atoi(argv[++i]); continue; }
		if (!strcmp(argv[i], "--duration-ms") && i + 1 < argc) { duration_ms = atol(argv[++i]); continue; }
		if (!strcmp(argv[i], "--timeout-ms") && i + 1 < argc) { timeout_ms = atol(argv[++i]); continue; }
		note("capture:不认识的参数 %s", argv[i]); return 2;
	}
	if (!out_dir) { note("capture:缺 --out <dir>"); return 2; }
	int stream = !strcmp(mode, "stream");
	if (!stream && strcmp(mode, "buffer")) { note("capture:--mode 只能是 buffer 或 stream"); return 2; }
	uint64_t rate = 0, samples = 0;
	if (rate_s && !parse_size(rate_s, &rate)) { note("capture:--rate '%s' 看不懂(写 25M / 100M / 500k)", rate_s); return 2; }
	if (samples_s && !parse_size(samples_s, &samples)) { note("capture:--samples '%s' 看不懂(写 4M / 100k;十进制,4M = 4,000,000)", samples_s); return 2; }
	if (!samples && !duration_ms && !g_str_has_prefix(device, "file:")) { note("capture:--samples 与 --duration-ms 二选一"); return 2; }
	if (g_mkdir_with_parents(out_dir, 0755) != 0) { note("capture:建不了目录 %s", out_dir); return 1; }

	char *err = NULL;
	if (lib_up(res, &err)) { note("%s", err); g_free(err); return 1; }

	/* 选设备 */
	int r;
	if (g_str_has_prefix(device, "file:")) {
		if ((r = ds_device_from_file(device + 5)) != SR_OK) { note("打不开文件设备 %s(%d)", device + 5, r); lib_down(); return 1; }
		r = ds_active_device_by_index(-1);
	} else {
		struct ds_device_base_info *list = NULL; int n = 0;
		ds_get_device_list(&list, &n);
		ds_device_handle pick = NULL_HANDLE;
		if (!strcmp(device, "demo")) { for (int i = 0; i < n; i++) if (is_demo_name(list[i].name)) pick = list[i].handle; }
		else if (!strcmp(device, "auto")) { for (int i = 0; i < n; i++) if (!is_demo_name(list[i].name)) { pick = list[i].handle; break; } }
		else { int k = atoi(device), seen = 0; for (int i = 0; i < n; i++) if (!is_demo_name(list[i].name)) { if (seen++ == k) pick = list[i].handle; } }
		g_free(list);
		if (pick == NULL_HANDLE) { note("没有可用的 DSLogic(插了吗?被 DSView 占着吗?`yoma-la devices` 看一眼;无硬件调试用 --device demo)"); lib_down(); return 1; }
		r = ds_active_device(pick);
	}
	if (r != SR_OK) { note("打开设备失败(%d):被 DSView 或别的进程占着、固件/位流缺失、或 FPGA HDL 版本不匹配 —— YOMA_LA_SRLOG=4 看库日志", r); lib_down(); return 1; }

	struct ds_device_full_info info; memset(&info, 0, sizeof info);
	ds_get_actived_device_info(&info);
	const struct DSL_profile *pf = profile_of(info.di);
	int is_usb = info.di && info.di->dev_type == DEV_TYPE_USB;
	int is_file = info.di && info.di->dev_type == DEV_TYPE_FILELOG;

	/* 通道:--ch 没给就全开 */
	cap_state st; memset(&st, 0, sizeof st);
	g_mutex_init(&st.lock); g_cond_init(&st.cond);
	int want[MAX_CH]; char *want_name[MAX_CH]; int nwant = 0; int max_phys = -1;
	if (ch_spec) {
		char **items = g_strsplit(ch_spec, ",", -1);
		for (int i = 0; items[i]; i++) {
			if (!*items[i]) continue;
			char *eq = strchr(items[i], '=');
			int idx = atoi(items[i]);
			if (idx < 0 || idx >= MAX_CH || nwant >= MAX_CH) { note("capture:--ch 里的通道号 %s 不合法", items[i]); g_strfreev(items); lib_down(); return 2; }
			want[nwant] = idx; want_name[nwant] = eq ? g_strdup(eq + 1) : NULL; nwant++;
			if (idx > max_phys) max_phys = idx;
		}
		g_strfreev(items);
	}
	/* 通道模式(只有 USB 设备有这层概念)*/
	if (is_usb && pf) {
		int need = ch_spec ? max_phys + 1 : (int)pf->dev_caps.total_ch_num;
		if (!rate) rate = SR_MHZ(20);
		int mode_id;
		if (!pick_channel_mode(pf, stream, need, rate, &mode_id)) {
			note("这块 %s 没有\"%s 模式 · %d 通道 · %" G_GUINT64_FORMAT " Hz\"的组合;`yoma-la devices` 的 channel_modes 列出了可选项(少开几根线或降采样率)", pf->model, stream ? "stream" : "buffer", need, rate);
			lib_down(); return 2;
		}
		ds_set_actived_device_config(NULL, NULL, SR_CONF_OPERATION_MODE, g_variant_new_int16(stream ? LO_OP_STREAM : LO_OP_BUFFER));
		ds_set_actived_device_config(NULL, NULL, SR_CONF_CHANNEL_MODE, g_variant_new_int16(mode_id));
		ds_set_actived_device_config(NULL, NULL, SR_CONF_BUFFER_OPTIONS, g_variant_new_int16(1 /* SR_BUF_UPLOAD:手动停止时把已采到的传回来,而不是丢掉 */));
		if (vth > 0 && (pf->dev_caps.feature_caps & CAPS_FEATURE_VTH)) ds_set_actived_device_config(NULL, NULL, SR_CONF_VTH, g_variant_new_double(vth));
	}
	/* 使能 + 命名 */
	GSList *chs = ds_get_actived_device_channels();
	for (GSList *l = chs; l; l = l->next) {
		struct sr_channel *ch = l->data;
		if (ch->type != SR_CHANNEL_LOGIC) continue;
		int on = !ch_spec; const char *nm = NULL;
		for (int i = 0; i < nwant; i++) if (want[i] == ch->index) { on = 1; nm = want_name[i]; }
		if (is_file) on = ch->enabled; /* 文件设备:照文件里的来 */
		ds_enable_device_channel(ch, on);
		if (on && nm) ds_set_device_channel_name(ch->index, nm);
	}
	for (GSList *l = ds_get_actived_device_channels(); l; l = l->next) {
		struct sr_channel *ch = l->data;
		if (ch->type == SR_CHANNEL_LOGIC && ch->enabled && st.nch < MAX_CH) { st.phys[st.nch] = ch->index; st.names[st.nch] = g_strdup(ch->name ? ch->name : ""); st.nch++; }
	}
	if (st.nch == 0) { note("capture:一个通道都没使能"); lib_down(); return 2; }

	/* 采样率 / 采样数 */
	GVariant *gv = NULL;
	if (is_file) {
		if (ds_get_actived_device_config(NULL, NULL, SR_CONF_SAMPLERATE, &gv) == SR_OK && gv) { rate = g_variant_get_uint64(gv); g_variant_unref(gv); gv = NULL; }
		if (ds_get_actived_device_config(NULL, NULL, SR_CONF_LIMIT_SAMPLES, &gv) == SR_OK && gv) { samples = g_variant_get_uint64(gv); g_variant_unref(gv); gv = NULL; }
	} else {
		if (!rate) rate = SR_MHZ(20);
		if (ds_set_actived_device_config(NULL, NULL, SR_CONF_SAMPLERATE, g_variant_new_uint64(rate)) != SR_OK) { note("设不了采样率 %" G_GUINT64_FORMAT, rate); lib_down(); return 2; }
		if (ds_get_actived_device_config(NULL, NULL, SR_CONF_SAMPLERATE, &gv) == SR_OK && gv) { uint64_t got = g_variant_get_uint64(gv); g_variant_unref(gv); gv = NULL; if (got != rate) { note("采样率被设备改成了 %" G_GUINT64_FORMAT "(请求 %" G_GUINT64_FORMAT ");用 devices 的 samplerates 里有的档", got, rate); rate = got; } }
		if (!samples) samples = (uint64_t)((double)rate * duration_ms / 1000.0);
		if (is_usb) {
			if (ds_get_actived_device_config(NULL, NULL, SR_CONF_HW_DEPTH, &gv) == SR_OK && gv) {
				uint64_t depth = g_variant_get_uint64(gv); g_variant_unref(gv); gv = NULL;
				if (!stream && samples > depth) { note("采样数 %" G_GUINT64_FORMAT " 超过这块板 buffer 模式每通道深度 %" G_GUINT64_FORMAT ",已截到上限(要更长就用 --mode stream 或少开通道)", samples, depth); samples = depth; }
			}
		}
		if (ds_set_actived_device_config(NULL, NULL, SR_CONF_LIMIT_SAMPLES, g_variant_new_uint64(samples)) != SR_OK) { note("设不了采样数"); lib_down(); return 2; }
	}
	if (samples == 0 || rate == 0) { note("capture:采样率/采样数为 0"); lib_down(); return 2; }

	/* 触发(只对 USB 设备有意义;简单触发:每通道一个字符)*/
	int trig_any = 0;
	ds_trigger_reset();
	if (trig_spec && is_usb) {
		char **items = g_strsplit(trig_spec, ",", -1);
		for (int i = 0; items[i]; i++) {
			char *eq = strchr(items[i], '=');
			if (!eq) continue;
			int idx = atoi(items[i]);
			char c = g_ascii_toupper(eq[1]);
			if (!strchr("01RFCX", c)) { note("capture:触发 '%s' 看不懂(每通道 0|1|r|f|c|x)", items[i]); g_strfreev(items); lib_down(); return 2; }
			ds_trigger_probe_set((uint16_t)idx, (unsigned char)c, 'X');
			if (c != 'X') trig_any = 1;
		}
		g_strfreev(items);
	}
	ds_trigger_set_mode(SIMPLE_TRIGGER);
	ds_trigger_set_en(trig_any ? 1 : 0);
	if (pos >= 0 && pos <= 100) ds_trigger_set_pos((uint16_t)pos);

	/* 缓冲 */
	st.cap_samples = (samples + 63) & ~63ULL;
	st.cap_bytes = st.cap_samples / 8 + 64;
	for (int i = 0; i < st.nch; i++) st.bits[i] = g_malloc0(st.cap_bytes);
	G = &st;

	gint64 t0 = g_get_monotonic_time();
	if ((r = ds_start_collect()) != SR_OK) { note("ds_start_collect 失败(%d)", r); G = NULL; lib_down(); return 1; }

	/* 等:正常结束 / 超时。超时 = 等触发的上限 + 采集本身的时长 + 上传余量 */
	double capture_ms = (double)samples / (double)rate * 1000.0;
	gint64 deadline_us = g_get_monotonic_time() + (timeout_ms > 0 ? (gint64)timeout_ms * 1000 : (gint64)((30000.0 + capture_ms * 2 + 5000.0) * 1000.0));
	int timed_out = 0;
	g_mutex_lock(&st.lock);
	while (!st.finished) {
		if (!g_cond_wait_until(&st.cond, &st.lock, deadline_us)) { timed_out = 1; break; }
	}
	g_mutex_unlock(&st.lock);
	if (timed_out) {
		note("等了 %ld ms 还没结束(触发没来?),停止并保留已采到的部分", (long)((g_get_monotonic_time() - t0) / 1000));
		ds_stop_collect();
		g_mutex_lock(&st.lock);
		gint64 grace = g_get_monotonic_time() + 5 * G_USEC_PER_SEC;
		while (!st.finished && g_cond_wait_until(&st.cond, &st.lock, grace)) {}
		g_mutex_unlock(&st.lock);
	}
	gint64 t1 = g_get_monotonic_time();
	G = NULL;

	uint64_t got = (st.words / (uint64_t)st.nch) * 64;
	if (got > samples) got = samples;
	got &= ~63ULL;
	uint64_t actual = 0;
	if (ds_get_actived_device_config(NULL, NULL, SR_CONF_ACTUAL_SAMPLES, &gv) == SR_OK && gv) { actual = g_variant_get_uint64(gv); g_variant_unref(gv); gv = NULL; }
	const char *driver = info.driver_name[0] ? info.driver_name : (is_usb ? "DSLogic" : "virtual-demo");

	int rc = 0;
	char *fname = g_strdup_printf("%s.dsl", name);
	char *dsl_path = g_build_filename(out_dir, fname, NULL);
	char *partial = g_strdup_printf("%s.partial", dsl_path);
	if (got == 0) { note("一个采样都没收到(%d 包,%" G_GUINT64_FORMAT " 字节)", st.packets, st.bytes_in); rc = 1; }
	else if (write_dsl(partial, &st, rate, got, driver, &err)) { note("%s", err); g_free(err); rc = 1; }
	else {
		g_remove(dsl_path);
		if (g_rename(partial, dsl_path) != 0) { note("rename %s → %s 失败", partial, dsl_path); rc = 1; }
	}

	/* 报告 */
	FILE *f = stdout;
	int first = 1;
	fputc('{', f);
	jw_kv_bool(f, &first, "ok", rc == 0 && !st.data_error);
	jw_kv_str(f, &first, "file", rc == 0 ? dsl_path : NULL);
	jw_kv_u64(f, &first, "samplerate", rate);
	jw_kv_u64(f, &first, "samples", got);
	jw_kv_u64(f, &first, "requested_samples", samples);
	jw_kv_u64(f, &first, "device_actual_samples", actual);
	jw_kv_double(f, &first, "duration_ms", (double)got / (double)rate * 1000.0);
	jw_kv_key(f, &first, "trigger"); fputc('{', f);
	int ftr = 1;
	jw_kv_bool(f, &ftr, "enabled", trig_any);
	jw_kv_bool(f, &ftr, "fired", st.trig_fired);
	jw_kv_u64(f, &ftr, "pos", st.trig_fired ? st.trig_pos : 0);
	fputc('}', f);
	jw_kv_key(f, &first, "channels"); fputc('[', f);
	for (int i = 0; i < st.nch; i++) {
		if (i) fputc(',', f);
		int fc = 1;
		fputc('{', f);
		jw_kv_i64(f, &fc, "index", st.phys[i]);
		jw_kv_str(f, &fc, "name", st.names[i]);
		fputc('}', f);
	}
	fputc(']', f);
	jw_kv_str(f, &first, "mode", is_usb ? (stream ? "stream" : "buffer") : (is_file ? "file" : "demo"));
	jw_kv_i64(f, &first, "packets", st.packets);
	jw_kv_u64(f, &first, "bytes_in", st.bytes_in);
	jw_kv_bool(f, &first, "timed_out", timed_out);
	jw_kv_bool(f, &first, "overflow", st.overflow);
	jw_kv_i64(f, &first, "data_error", st.data_error);
	jw_kv_i64(f, &first, "end_event", st.finished_event);
	jw_kv_i64(f, &first, "elapsed_ms", (t1 - t0) / 1000);
	jw_kv_key(f, &first, "device"); device_json(f);
	fputs("}\n", f);
	fflush(f);

	for (int i = 0; i < st.nch; i++) { g_free(st.bits[i]); g_free(st.names[i]); }
	g_free(fname); g_free(dsl_path); g_free(partial);
	lib_down();
	return rc;
}
