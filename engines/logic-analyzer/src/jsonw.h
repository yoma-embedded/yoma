/* 极小的 JSON 写出助手:只管转义与数字格式,结构由调用方手写。
 * 引擎的全部输出(devices/decoders 的 --json、decode 的 NDJSON)都走这里,
 * 字符串一律按 UTF-8 原样写出、只转义 JSON 要求的那几个字符 —— 不做本地化、不碰 locale。 */
#pragma once
#include <glib.h>
#include <stdint.h>
#include <stdio.h>

void jw_str(FILE *f, const char *s);          /* "…",s 可为 NULL → null */
void jw_key(FILE *f, const char *k);          /* "k": */
void jw_u64(FILE *f, uint64_t v);
void jw_i64(FILE *f, int64_t v);
void jw_bool(FILE *f, int v);
void jw_double(FILE *f, double v);
/* GVariant → JSON。认不出的类型退回 g_variant_print 的字符串,不丢信息。 */
void jw_variant(FILE *f, GVariant *v);

/* 对象成员:*first 为 0 时先补一个逗号,写完把它清零。分隔符跟着成员走,增删/条件成员就不会
 * 再出现"多一个逗号"或"少一个逗号"这类只在某条分支上才显形的坏 JSON。 */
void jw_kv_key(FILE *f, int *first, const char *key);   /* 值由调用方自己写(数组/对象/裸字面量) */
void jw_kv_str(FILE *f, int *first, const char *key, const char *v);
void jw_kv_u64(FILE *f, int *first, const char *key, uint64_t v);
void jw_kv_i64(FILE *f, int *first, const char *key, int64_t v);
void jw_kv_bool(FILE *f, int *first, const char *key, int v);
void jw_kv_double(FILE *f, int *first, const char *key, double v);
