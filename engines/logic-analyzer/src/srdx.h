/* libsigrokdecode4DSL 的小补充:按解码器 id 加载。
 * srd_decoder_load() 吃的是 Python 模块名 = decoders/ 下的目录名('1-i2c'),而解码器
 * 自报的 id 是 '1:i2c'(pd.py 里的 id 字段)。用户和模型说的都是 id,这里把两种都认。 */
#pragma once
#include <libsigrokdecode.h>

static inline struct srd_decoder *srdx_load(const char *id_or_module) {
	struct srd_decoder *d = srd_decoder_get_by_id(id_or_module);
	if (d) return d;
	/* 含 ':' 的一定是 id 而不是模块名:直接按目录名 '1-i2c' import,不先白试一次 */
	char *mod = g_strdup(id_or_module);
	for (char *p = mod; *p; p++) if (*p == ':') *p = '-';
	if (srd_decoder_load(mod) == SRD_OK) {
		d = srd_decoder_get_by_id(id_or_module);
		if (!d) {
			/* 模块名与 id 都不等于请求串时(极少数目录名带空格),在已加载列表里按模块反查 */
			for (const GSList *l = srd_decoder_list(); l; l = l->next) {
				struct srd_decoder *x = l->data;
				char *xid = g_strdup(x->id);
				for (char *p = xid; *p; p++) if (*p == ':') *p = '-';
				if (!strcmp(xid, mod)) d = x;
				g_free(xid);
				if (d) break;
			}
		}
	}
	g_free(mod);
	return d;
}

/* 按 ann_class 取类的 id / desc。
 * fork 的 get_annotations() 用 g_slist_prepend 建表且**不反转**,所以 dec->annotations 是倒序的
 * (DSView 自己从不按类号读它,于是没人发现);条目是 char**:3 元组 [type, id, desc],
 * 2 元组 [id, desc]。这里把两件事都吸收掉,调用方只看到 (id, desc)。 */
static inline int srdx_class(const struct srd_decoder *d, int cls, const char **id, const char **desc) {
	int n = (int)g_slist_length(d->annotations);
	if (cls < 0 || cls >= n) { *id = NULL; *desc = NULL; return 0; }
	char **e = g_slist_nth_data(d->annotations, n - 1 - cls);
	if (!e) { *id = NULL; *desc = NULL; return 0; }
	int len = 0; while (e[len]) len++;
	if (len >= 3) { *id = e[1]; *desc = e[2]; }
	else { *id = e[0]; *desc = len > 1 ? e[1] : NULL; }
	return 1;
}
