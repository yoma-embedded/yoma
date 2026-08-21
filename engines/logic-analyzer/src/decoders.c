/* yoma-la decoders —— 把解码器的元数据(通道、选项、注解行/类、输入输出)吐成 JSON。
 * 模型先查再调:DSView 的 '1:uart' 是单根 rxtx、'1:i2c' 只有 address_format 一个选项,
 * 按上游 sigrok 的记忆写参数必错;让它看一眼真实声明比让它报错重试便宜。
 *
 *   yoma-la decoders --json            全部(加载 150 个 Python 模块,约一两秒)
 *   yoma-la decoders --json 1:i2c uart 只列这几个 */
#include "engine.h"
#include "jsonw.h"
#include <glib.h>
#include <libsigrokdecode.h>
#include "srdx.h"
#include <string.h>

static void strlist(FILE *f, GSList *l) {
	fputc('[', f);
	for (GSList *i = l; i; i = i->next) { if (i != l) fputc(',', f); jw_str(f, i->data); }
	fputc(']', f);
}

static void channels(FILE *f, GSList *l) {
	fputc('[', f);
	for (GSList *i = l; i; i = i->next) {
		struct srd_channel *c = i->data;
		if (i != l) fputc(',', f);
		fputs("{\"id\":", f); jw_str(f, c->id);
		fputs(",\"name\":", f); jw_str(f, c->name);
		fputs(",\"desc\":", f); jw_str(f, c->desc);
		fputs(",\"order\":", f); jw_i64(f, c->order);
		fputc('}', f);
	}
	fputc(']', f);
}

static void one(FILE *f, struct srd_decoder *d) {
	fputs("{\"id\":", f); jw_str(f, d->id);
	fputs(",\"name\":", f); jw_str(f, d->name);
	fputs(",\"longname\":", f); jw_str(f, d->longname);
	fputs(",\"desc\":", f); jw_str(f, d->desc);
	fputs(",\"license\":", f); jw_str(f, d->license);
	fputs(",\"inputs\":", f); strlist(f, d->inputs);
	fputs(",\"outputs\":", f); strlist(f, d->outputs);
	fputs(",\"tags\":", f); strlist(f, d->tags);
	fputs(",\"channels\":", f); channels(f, d->channels);
	fputs(",\"opt_channels\":", f); channels(f, d->opt_channels);
	fputs(",\"options\":[", f);
	for (GSList *i = d->options; i; i = i->next) {
		struct srd_decoder_option *o = i->data;
		if (i != d->options) fputc(',', f);
		fputs("{\"id\":", f); jw_str(f, o->id);
		fputs(",\"desc\":", f); jw_str(f, o->desc);
		fputs(",\"type\":", f); jw_str(f, o->def ? g_variant_get_type_string(o->def) : NULL);
		fputs(",\"default\":", f); jw_variant(f, o->def);
		fputs(",\"values\":[", f);
		for (GSList *v = o->values; v; v = v->next) { if (v != o->values) fputc(',', f); jw_variant(f, v->data); }
		fputs("]}", f);
	}
	fputs("],\"classes\":[", f);
	int nclasses = (int)g_slist_length(d->annotations);
	for (int c = 0; c < nclasses; c++) {
		const char *id, *desc;
		srdx_class(d, c, &id, &desc);
		if (c) fputc(',', f);
		fputs("{\"index\":", f); jw_i64(f, c);
		fputs(",\"id\":", f); jw_str(f, id);
		fputs(",\"desc\":", f); jw_str(f, desc);
		fputc('}', f);
	}
	fputs("],\"rows\":[", f);
	for (GSList *i = d->annotation_rows; i; i = i->next) {
		struct srd_decoder_annotation_row *r = i->data;
		if (i != d->annotation_rows) fputc(',', f);
		fputs("{\"id\":", f); jw_str(f, r->id);
		fputs(",\"desc\":", f); jw_str(f, r->desc);
		fputs(",\"classes\":[", f);
		for (GSList *k = r->ann_classes; k; k = k->next) { if (k != r->ann_classes) fputc(',', f); jw_i64(f, GPOINTER_TO_INT(k->data)); }
		fputs("]}", f);
	}
	fputs("],\"binary\":[", f);
	for (GSList *i = d->binary; i; i = i->next) {
		char **b = i->data;
		if (i != d->binary) fputc(',', f);
		fputs("{\"id\":", f); jw_str(f, b[0]); fputs(",\"desc\":", f); jw_str(f, b[1]); fputc('}', f);
	}
	fputs("]}", f);
}

int cmd_decoders(int argc, char **argv) {
	const char *decoders_dir = NULL;
	const char *ids[256]; int nids = 0;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--json")) continue;
		if (!strcmp(argv[i], "--decoders") && i + 1 < argc) { decoders_dir = argv[++i]; continue; }
		if (argv[i][0] == '-') { note("decoders:不认识的参数 %s", argv[i]); return 2; }
		if (nids < 256) ids[nids++] = argv[i];
	}
	char *dir = resolve_decoders_dir(decoders_dir);
	if (!dir) { note("找不到解码器目录:传 --decoders <dir>,或设 YOMA_LA_DECODERS"); return 1; }
	char *err = NULL;
	if (srd_bootstrap(dir, &err)) { note("%s", err); g_free(err); g_free(dir); return 1; }

	int rc = 0;
	fputs("{\"decoders_dir\":", stdout); jw_str(stdout, dir); fputs(",\"decoders\":[", stdout);
	g_free(dir);
	if (nids) {
		int first = 1;
		for (int i = 0; i < nids; i++) {
			struct srd_decoder *d = srdx_load(ids[i]);
			if (!d) { note("解码器 %s 加载失败", ids[i]); rc = 1; continue; }
			if (!first) fputc(',', stdout);
			one(stdout, d); first = 0;
		}
	} else {
		srd_decoder_load_all();
		const GSList *all = srd_decoder_list();
		for (const GSList *i = all; i; i = i->next) { if (i != all) fputc(',', stdout); one(stdout, i->data); }
	}
	fputs("]}\n", stdout);
	srd_exit();
	return rc;
}
