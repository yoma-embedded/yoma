/* yoma-la decode —— 用 DSView 自己的解码器(libsigrokdecode4DSL + Python pd.py)解一份 .dsl,
 * 每条注解一行 NDJSON 写到 stdout。子命令一览与全局开关见 main.c。
 *
 * --pd 的语法:<实例名>=<解码器 id>[:<通道 id>=<通道引用>]*[:<选项 id>=<值>]*[:on=<父实例名>]
 *   通道引用可以是物理通道号(header 里的 probe<N>)、通道名、或 D<N>;
 *   通道 id / 选项 id 按解码器自己的声明区分(先查 channels/opt_channels,再查 options);
 *   on= 表示堆叠在某个已声明的实例之上(uart → modbus、i2c → eeprom24xx),此时不需要通道。
 *
 * 输出(每行一个 JSON 对象):
 *   {"type":"meta", …}                       第一行:采样率、通道表、实例表
 *   {"s":起,"e":止,"k":实例,"c":类号,"r":行 id,"t":[文本…],"h":"十六进制","n":数值}
 *   {"type":"end","annotations":N,"elapsed_ms":…}
 * h/n 来自 fork 专有的 str_number_hex:UART/SPI 的 '@41'、I²C 的 '{$}' 这些占位在这里还原;
 * t 里带 '{$}' 的文本原样保留,替换由上层按它想要的进制做。标成忽略('\n' 开头)的文本行不输出。
 *
 * .dsl 怎么读、为什么不走 libsigrok4DSL 的 session_driver:见 dsl.h。注解类号倒序、id 与模块名
 * 不同名这两件事:见 srdx.h。按 64K 采样分块喂:srd_session_send 每次与解码线程同步一轮,
 * 块太小(DSView 用 16K)握手开销可见,块太大失去进度;对正确性无影响(起点内部按 8 对齐)。 */
#include "engine.h"
#include "dsl.h"
#include "jsonw.h"
#include <glib.h>
#include <libsigrokdecode.h>
#include "srdx.h"
#include <stdlib.h>
#include <string.h>

#define CHUNK_SAMPLES (1ULL << 16)
#define MAX_PD 16

typedef struct {
	char *key;
	char *id;
	char *on;                 /* 父实例名,NULL = 直接吃逻辑通道 */
	GHashTable *options;      /* id → GVariant */
	GHashTable *channels;     /* id → GVariant int32(dsl 通道下标) */
	struct srd_decoder *dec;
	struct srd_decoder_inst *di;
	int *class_row;           /* ann_class → annotation_rows 下标,-1 = 无行 */
	const char **class_row_id;/* 同一下标的行 id:回调里每条注解都要用,不能现走一次链表 */
	int nclasses;
} pd_spec;

typedef struct {
	FILE *out;
	GMutex lock;
	pd_spec *pds; int npds;
	uint64_t count;
} sink;

static pd_spec *spec_of(sink *s, const struct srd_decoder_inst *di) {
	for (int i = 0; i < s->npds; i++) if (s->pds[i].di == di) return &s->pds[i];
	return NULL;
}

static void on_annotation(struct srd_proto_data *pdata, void *cb_data) {
	sink *s = cb_data;
	const struct srd_proto_data_annotation *a = pdata->data;
	pd_spec *p = spec_of(s, pdata->pdo->di);
	g_mutex_lock(&s->lock);
	FILE *f = s->out;
	int first = 1;
	fputc('{', f);
	jw_kv_u64(f, &first, "s", pdata->start_sample);
	jw_kv_u64(f, &first, "e", pdata->end_sample);
	jw_kv_str(f, &first, "k", p ? p->key : pdata->pdo->di->inst_id);
	jw_kv_i64(f, &first, "c", a->ann_class);
	if (p && a->ann_class >= 0 && a->ann_class < p->nclasses && p->class_row[a->ann_class] >= 0)
		jw_kv_str(f, &first, "r", p->class_row_id[a->ann_class]);
	jw_kv_key(f, &first, "t"); fputc('[', f);
	int ft = 1;
	for (char **t = a->ann_text; t && *t; t++) {
		if ((*t)[0] == '\n') continue;
		if (!ft) fputc(',', f);
		jw_str(f, *t); ft = 0;
	}
	fputc(']', f);
	if (a->str_number_hex[0]) {
		jw_kv_str(f, &first, "h", a->str_number_hex);
		char *end = NULL;
		unsigned long long v = strtoull(a->str_number_hex, &end, 16);
		if (end && *end == 0 && strlen(a->str_number_hex) <= 16) jw_kv_u64(f, &first, "n", v);
	}
	fputs("}\n", f);
	s->count++;
	g_mutex_unlock(&s->lock);
}

static GVariant *variant_like(GVariant *def, const char *text, char **err) {
	const GVariantType *t = g_variant_get_type(def);
	if (g_variant_type_equal(t, G_VARIANT_TYPE_STRING)) return g_variant_new_string(text);
	if (g_variant_type_equal(t, G_VARIANT_TYPE_INT64)) { char *e; long long v = strtoll(text, &e, 0); if (*e) { *err = g_strdup_printf("'%s' 不是整数", text); return NULL; } return g_variant_new_int64(v); }
	if (g_variant_type_equal(t, G_VARIANT_TYPE_INT32)) { char *e; long v = strtol(text, &e, 0); if (*e) { *err = g_strdup_printf("'%s' 不是整数", text); return NULL; } return g_variant_new_int32((int32_t)v); }
	if (g_variant_type_equal(t, G_VARIANT_TYPE_DOUBLE)) { char *e; double v = g_ascii_strtod(text, &e); if (*e) { *err = g_strdup_printf("'%s' 不是数字", text); return NULL; } return g_variant_new_double(v); }
	if (g_variant_type_equal(t, G_VARIANT_TYPE_BOOLEAN)) return g_variant_new_boolean(!g_ascii_strcasecmp(text, "yes") || !g_ascii_strcasecmp(text, "true") || !strcmp(text, "1"));
	*err = g_strdup_printf("选项的类型 %s 不支持", g_variant_get_type_string(def));
	return NULL;
}

static struct srd_channel *find_pd_channel(struct srd_decoder *d, const char *id) {
	for (GSList *l = d->channels; l; l = l->next) if (!strcmp(((struct srd_channel *)l->data)->id, id)) return l->data;
	for (GSList *l = d->opt_channels; l; l = l->next) if (!strcmp(((struct srd_channel *)l->data)->id, id)) return l->data;
	return NULL;
}
static struct srd_decoder_option *find_pd_option(struct srd_decoder *d, const char *id) {
	for (GSList *l = d->options; l; l = l->next) if (!strcmp(((struct srd_decoder_option *)l->data)->id, id)) return l->data;
	return NULL;
}

/* 文件里有哪些通道,写成 "D0=SDA D1=SCL …" —— 通道名写错时这一行就是答案,不该让人再去读 meta。 */
static char *channel_list(const dsl_file *file) {
	GString *s = g_string_new("");
	for (int i = 0; i < file->nchannels; i++)
		g_string_append_printf(s, "%sD%d=%s", i ? " " : "", file->ch[i].index, file->ch[i].name ? file->ch[i].name : "");
	return g_string_free(s, FALSE);
}

/* 解析一条 --pd,并确认解码器已加载。 */
static int parse_pd(const char *text, const dsl_file *file, pd_spec *p, char **err) {
	memset(p, 0, sizeof *p);
	const char *eq = strchr(text, '=');
	if (!eq || eq == text) { *err = g_strdup_printf("--pd '%s':要写成 <实例名>=<解码器 id>[:…]", text); return 1; }
	p->key = g_strndup(text, eq - text);
	char **parts = g_strsplit(eq + 1, ":", -1);
	/* 解码器 id 本身可能含冒号(DSView 的 '1:i2c'、'0:uart'):第一个 k=v 之前的全部就是 id */
	int consumed = 0;
	GString *idbuf = g_string_new("");
	for (int i = 0; parts[i] && !strchr(parts[i], '='); i++) {
		if (i) g_string_append_c(idbuf, ':');
		g_string_append(idbuf, parts[i]);
		consumed = i + 1;
	}
	p->dec = idbuf->len ? srdx_load(idbuf->str) : NULL;
	if (!p->dec) {
		*err = g_strdup_printf("--pd '%s':没有叫 '%s' 的解码器(用 `yoma-la decoders` 看可用的;DSView 的 I²C/SPI/UART 叫 '1:i2c' / '1:spi' / '1:uart')", text, idbuf->str);
		g_string_free(idbuf, TRUE); g_strfreev(parts);
		return 1;
	}
	p->id = g_string_free(idbuf, FALSE);
	p->options = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, (GDestroyNotify)g_variant_unref);
	p->channels = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, (GDestroyNotify)g_variant_unref);
	for (int i = consumed; parts[i]; i++) {
		if (!*parts[i]) continue;
		char *kv = parts[i];
		char *v = strchr(kv, '=');
		if (!v) { *err = g_strdup_printf("--pd '%s':'%s' 要写成 key=value", text, kv); g_strfreev(parts); return 1; }
		*v++ = 0;
		if (!strcmp(kv, "on")) { p->on = g_strdup(v); continue; }
		struct srd_channel *ch = find_pd_channel(p->dec, kv);
		if (ch) {
			int idx = dsl_find_channel(file, v);
			if (idx < 0) {
				char *have = channel_list(file);
				*err = g_strdup_printf("--pd '%s':通道 %s=%s —— 文件里没有叫 '%s' 的通道(有:%s)", text, kv, v, v, have);
				g_free(have); g_strfreev(parts); return 1;
			}
			GVariant *gv = g_variant_new_int32(idx);
			g_variant_ref_sink(gv);
			g_hash_table_insert(p->channels, g_strdup(kv), gv);
			continue;
		}
		struct srd_decoder_option *opt = find_pd_option(p->dec, kv);
		if (opt) {
			char *e2 = NULL;
			GVariant *gv = variant_like(opt->def, v, &e2);
			if (!gv) { *err = g_strdup_printf("--pd '%s':选项 %s:%s", text, kv, e2); g_free(e2); g_strfreev(parts); return 1; }
			g_variant_ref_sink(gv);
			g_hash_table_insert(p->options, g_strdup(kv), gv);
			continue;
		}
		*err = g_strdup_printf("--pd '%s':解码器 %s 既没有通道也没有选项叫 '%s'", text, p->id, kv);
		g_strfreev(parts);
		return 1;
	}
	g_strfreev(parts);
	/* class → row 表 */
	p->nclasses = g_slist_length(p->dec->annotations);
	int n = p->nclasses > 0 ? p->nclasses : 1;
	p->class_row = g_new(int, n);
	p->class_row_id = g_new0(const char *, n);
	for (int c = 0; c < p->nclasses; c++) p->class_row[c] = -1;
	int r = 0;
	for (GSList *l = p->dec->annotation_rows; l; l = l->next, r++) {
		struct srd_decoder_annotation_row *row = l->data;
		for (GSList *cl = row->ann_classes; cl; cl = cl->next) {
			int c = GPOINTER_TO_INT(cl->data);
			if (c >= 0 && c < p->nclasses) { p->class_row[c] = r; p->class_row_id[c] = row->id; }
		}
	}
	return 0;
}

static void write_meta(FILE *f, const dsl_file *file, pd_spec *pds, int npds, uint64_t from, uint64_t to) {
	int first = 1;
	fputc('{', f);
	jw_kv_str(f, &first, "type", "meta");
	jw_kv_str(f, &first, "file", file->path);
	jw_kv_i64(f, &first, "version", file->version);
	jw_kv_u64(f, &first, "samplerate", file->samplerate);
	jw_kv_u64(f, &first, "total_samples", file->total_samples);
	if (file->trigger_pos >= 0) jw_kv_i64(f, &first, "trigger_pos", file->trigger_pos);
	else jw_kv_str(f, &first, "trigger_pos", NULL);
	jw_kv_u64(f, &first, "from", from);
	jw_kv_u64(f, &first, "to", to);
	jw_kv_key(f, &first, "channels"); fputc('[', f);
	for (int i = 0; i < file->nchannels; i++) {
		if (i) fputc(',', f);
		int fc = 1;
		fputc('{', f);
		jw_kv_i64(f, &fc, "index", file->ch[i].index);
		jw_kv_str(f, &fc, "name", file->ch[i].name);
		jw_kv_bool(f, &fc, "has_data", file->ch[i].dir >= 0);
		fputc('}', f);
	}
	fputc(']', f);
	jw_kv_key(f, &first, "decoders"); fputc('[', f);
	for (int i = 0; i < npds; i++) {
		pd_spec *p = &pds[i];
		if (i) fputc(',', f);
		int fd = 1;
		fputc('{', f);
		jw_kv_str(f, &fd, "key", p->key);
		jw_kv_str(f, &fd, "id", p->id);
		jw_kv_str(f, &fd, "name", p->dec->name);
		if (p->on) jw_kv_str(f, &fd, "on", p->on);
		jw_kv_key(f, &fd, "channels"); fputc('{', f);
		int fch = 1;
		GHashTableIter it; gpointer k, v;
		g_hash_table_iter_init(&it, p->channels);
		while (g_hash_table_iter_next(&it, &k, &v)) jw_kv_i64(f, &fch, k, file->ch[g_variant_get_int32(v)].index);
		fputc('}', f);
		jw_kv_key(f, &fd, "options"); fputc('{', f);
		int fo = 1;
		for (GSList *l = p->dec->options; l; l = l->next) {
			struct srd_decoder_option *o = l->data;
			GVariant *val = g_hash_table_lookup(p->options, o->id);
			jw_kv_key(f, &fo, o->id);
			jw_variant(f, val ? val : o->def);
		}
		fputc('}', f);
		jw_kv_key(f, &fd, "rows"); fputc('[', f);
		int fr = 1;
		for (GSList *l = p->dec->annotation_rows; l; l = l->next) {
			struct srd_decoder_annotation_row *row = l->data;
			if (!fr) fputc(',', f);
			fr = 0;
			int frr = 1;
			fputc('{', f);
			jw_kv_str(f, &frr, "id", row->id);
			jw_kv_str(f, &frr, "desc", row->desc);
			jw_kv_key(f, &frr, "classes"); fputc('[', f);
			int fcl = 1;
			for (GSList *cl = row->ann_classes; cl; cl = cl->next) { if (!fcl) fputc(',', f); jw_i64(f, GPOINTER_TO_INT(cl->data)); fcl = 0; }
			fputs("]}", f);
		}
		fputc(']', f);
		jw_kv_key(f, &fd, "classes"); fputc('[', f);
		for (int c = 0; c < p->nclasses; c++) {
			const char *cid, *cdesc;
			srdx_class(p->dec, c, &cid, &cdesc);
			if (c) fputc(',', f);
			int fcc = 1;
			fputc('{', f);
			jw_kv_str(f, &fcc, "id", cid);
			jw_kv_str(f, &fcc, "desc", cdesc);
			fputc('}', f);
		}
		fputs("]}", f);
	}
	fputs("]}\n", f);
}

int cmd_decode(int argc, char **argv) {
	const char *in = NULL, *decoders_dir = NULL, *out_path = NULL;
	const char *pd_text[MAX_PD]; int npd = 0;
	uint64_t from = 0, to = UINT64_MAX;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--in") && i + 1 < argc) in = argv[++i];
		else if (!strcmp(argv[i], "--pd") && i + 1 < argc) { if (npd == MAX_PD) { note("最多 %d 个 --pd", MAX_PD); return 2; } pd_text[npd++] = argv[++i]; }
		else if (!strcmp(argv[i], "--from") && i + 1 < argc) from = strtoull(argv[++i], NULL, 10);
		else if (!strcmp(argv[i], "--to") && i + 1 < argc) to = strtoull(argv[++i], NULL, 10);
		else if (!strcmp(argv[i], "--decoders") && i + 1 < argc) decoders_dir = argv[++i];
		else if (!strcmp(argv[i], "--out") && i + 1 < argc) out_path = argv[++i];
		else { note("decode:不认识的参数 %s", argv[i]); return 2; }
	}
	if (!in) { note("decode:缺 --in <file.dsl>"); return 2; }
	if (npd == 0) { note("decode:至少一个 --pd,例如 --pd \"i2c0=1:i2c:scl=1:sda=0\""); return 2; }

	char *err = NULL;
	dsl_file *file = NULL;
	if (dsl_open(in, &file, &err)) { note("%s", err); g_free(err); return 1; }
	if (to > file->total_samples) to = file->total_samples;
	if (from >= to) { note("decode:--from %llu 不小于 --to %llu", (unsigned long long)from, (unsigned long long)to); dsl_close(file); return 2; }

	char *dir = resolve_decoders_dir(decoders_dir);
	if (!dir) { note("找不到解码器目录:传 --decoders <dir>,或设 YOMA_LA_DECODERS,或把 decoders/ 放在 <exe>/../data/la/ 下"); dsl_close(file); return 1; }
	if (srd_bootstrap(dir, &err)) { note("%s", err); g_free(err); g_free(dir); dsl_close(file); return 1; }
	g_free(dir);

	pd_spec pds[MAX_PD];
	for (int i = 0; i < npd; i++) {
		if (parse_pd(pd_text[i], file, &pds[i], &err)) { note("%s", err); g_free(err); dsl_close(file); return 2; }
	}
	/* 每个实例的父与栈根一次算清:on= 只能指向前面声明过的实例,所以顺着往前扫一遍就够,
	 * 后面按栈分组时只要比 root_of[i] == t。 */
	int parent_of[MAX_PD], root_of[MAX_PD];
	for (int i = 0; i < npd; i++) {
		parent_of[i] = -1;
		if (!pds[i].on) { root_of[i] = i; continue; }
		for (int j = 0; j < i; j++) if (!strcmp(pds[j].key, pds[i].on)) parent_of[i] = j;
		if (parent_of[i] < 0) { note("--pd '%s':on=%s 指向的实例不存在或声明在它之后", pd_text[i], pds[i].on); dsl_close(file); return 2; }
		root_of[i] = root_of[parent_of[i]];
	}

	FILE *out = stdout;
	if (out_path) {
		out = fopen(out_path, "wb");
		if (!out) { note("写不了 %s", out_path); dsl_close(file); return 1; }
		setvbuf(out, NULL, _IOFBF, 1 << 20);  /* 一条注解一行、几百万行:默认缓冲会把它变成 write 风暴 */
	}

	/* 栈 = 一个顶层实例 + 堆在它上面的实例,一栈一个 srd 会话:fork 的解码器按 PD 通道序号
	 * 直接索引 inbuf(dec_channelmap 只在前端组装 inbuf 时用),两个顶层实例共用一组 inbuf
	 * 会互相读错线 —— DSView 自己也是一个 DecoderStack 一个 session。栈之间顺序跑。 */
	sink s = { .out = out, .pds = pds, .npds = npd, .count = 0 };
	g_mutex_init(&s.lock);
	write_meta(out, file, pds, npd, from, to);
	fflush(out);

	gint64 t0 = g_get_monotonic_time();
	int rc = 0;
	for (int t = 0; t < npd && rc == 0; t++) {
		pd_spec *topp = &pds[t];
		if (topp->on) continue;
		struct srd_session *sess = NULL;
		if (srd_session_new(&sess) != SRD_OK) { note("srd_session_new 失败"); rc = 1; break; }
		topp->di = srd_inst_new(sess, topp->id, topp->options);
		if (!topp->di) { note("--pd '%s':建实例失败(看上面的 Python 报错)", pd_text[t]); rc = 1; break; }
		if (g_hash_table_size(topp->channels) == 0 && topp->dec->channels) { note("--pd '%s':解码器 %s 需要通道,一个都没给", pd_text[t], topp->id); rc = 2; break; }
		if (srd_inst_channel_set_all(topp->di, topp->channels) != SRD_OK) { note("--pd '%s':通道映射失败", pd_text[t]); rc = 2; break; }
		int req = g_slist_length(topp->dec->channels);
		for (int c = 0; c < req && rc == 0; c++) if (topp->di->dec_channelmap == NULL || topp->di->dec_channelmap[c] < 0) {
			struct srd_channel *ch = g_slist_nth_data(topp->dec->channels, c);
			note("--pd '%s':必需通道 %s 没有映射", pd_text[t], ch->id); rc = 2;
		}
		if (rc) break;
		/* 堆叠:按声明顺序(父必在前),只收属于本栈的 */
		for (int i = 0; i < npd && rc == 0; i++) {
			pd_spec *p = &pds[i];
			if (!p->on || root_of[i] != t) continue;
			pd_spec *parent = &pds[parent_of[i]];
			if (!parent->di) { note("--pd '%s':父实例 %s 还没建", pd_text[i], p->on); rc = 1; break; }
			p->di = srd_inst_new(sess, p->id, p->options);
			if (!p->di) { note("--pd '%s':建实例失败(看上面的 Python 报错)", pd_text[i]); rc = 1; break; }
			if (srd_inst_stack(sess, parent->di, p->di) != SRD_OK) { note("--pd '%s':堆叠到 %s 失败(输出/输入类型不配?)", pd_text[i], p->on); rc = 1; break; }
		}
		if (rc) break;

		int nch = topp->di->dec_num_channels;
		for (int c = 0; c < nch; c++) {
			int idx = topp->di->dec_channelmap[c];
			if (idx >= 0 && dsl_load_channel(file, idx, &err)) { note("%s", err); g_free(err); rc = 1; break; }
		}
		if (rc) break;

		srd_session_metadata_set(sess, SRD_CONF_SAMPLERATE, g_variant_new_uint64(file->samplerate));
		srd_pd_output_callback_add(sess, SRD_OUTPUT_ANN, on_annotation, &s);
		char *perr = NULL;
		if (srd_session_start(sess, &perr) != SRD_OK) { note("srd_session_start(%s):%s", topp->key, perr ? perr : "失败"); g_free(perr); rc = 1; break; }

		const uint8_t **inbuf = g_new0(const uint8_t *, nch + 1);
		uint8_t *inconst = g_new0(uint8_t, nch + 1);
		for (uint64_t pos = from; pos < to; ) {
			uint64_t end = pos + CHUNK_SAMPLES; if (end > to) end = to;
			uint64_t base = (pos & ~7ULL) / 8;
			for (int c = 0; c < nch; c++) {
				int idx = topp->di->dec_channelmap[c];
				inbuf[c] = (idx >= 0 && file->ch[idx].bits) ? file->ch[idx].bits + base : NULL;
				inconst[c] = 0;
			}
			if (srd_session_send(sess, pos, end, inbuf, inconst, end - pos, &perr) != SRD_OK) {
				note("解码器 %s 报错(采样 %llu..%llu):%s", topp->key, (unsigned long long)pos, (unsigned long long)end, perr ? perr : "?");
				g_free(perr); perr = NULL; rc = 1; break;
			}
			pos = end;
		}
		if (rc == 0) { srd_session_end(sess, &perr); if (perr) { note("srd_session_end(%s):%s", topp->key, perr); g_free(perr); perr = NULL; } }
		g_free(inbuf); g_free(inconst);
		srd_session_destroy(sess);
		/* 会话一销毁,它的实例内存就归还了,而下一栈的 srd_inst_new 很可能**拿到同一个地址**。
		 * spec_of 是按指针认实例的,留着悬垂的 di 就会让后一栈的注解记在前一栈的 key 名下 ——
		 * 实测三个 --pd(i2c/uart/spi)时,spi 的 5184 条注解会偶发全部标成 uart0,
		 * 总数仍然对,所以引擎不报错、上层也看不出来,只是 events 全乱。 */
		for (int i = 0; i < npd; i++) pds[i].di = NULL;
	}
	gint64 t1 = g_get_monotonic_time();

	g_mutex_lock(&s.lock);
	int fe = 1;
	fputc('{', out);
	jw_kv_str(out, &fe, "type", "end");
	jw_kv_u64(out, &fe, "annotations", s.count);
	jw_kv_i64(out, &fe, "elapsed_ms", (t1 - t0) / 1000);
	jw_kv_bool(out, &fe, "ok", rc == 0);
	fputs("}\n", out);
	fflush(out);
	g_mutex_unlock(&s.lock);

	if (out != stdout) fclose(out);
	dsl_close(file);
	srd_exit();
	return rc;
}
