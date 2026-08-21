#include "jsonw.h"
#include <inttypes.h>
#include <math.h>

void jw_str(FILE *f, const char *s) {
	if (!s) { fputs("null", f); return; }
	fputc('"', f);
	for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
		switch (*p) {
		case '"': fputs("\\\"", f); break;
		case '\\': fputs("\\\\", f); break;
		case '\n': fputs("\\n", f); break;
		case '\r': fputs("\\r", f); break;
		case '\t': fputs("\\t", f); break;
		default:
			if (*p < 0x20) fprintf(f, "\\u%04x", *p);
			else fputc(*p, f);
		}
	}
	fputc('"', f);
}

void jw_key(FILE *f, const char *k) { jw_str(f, k); fputc(':', f); }
void jw_u64(FILE *f, uint64_t v) { fprintf(f, "%" PRIu64, v); }
void jw_i64(FILE *f, int64_t v) { fprintf(f, "%" PRId64, v); }
void jw_bool(FILE *f, int v) { fputs(v ? "true" : "false", f); }
void jw_double(FILE *f, double v) {
	if (isfinite(v)) fprintf(f, "%.17g", v);
	else fputs("null", f);
}

void jw_variant(FILE *f, GVariant *v) {
	if (!v) { fputs("null", f); return; }
	if (g_variant_is_of_type(v, G_VARIANT_TYPE_STRING)) jw_str(f, g_variant_get_string(v, NULL));
	else if (g_variant_is_of_type(v, G_VARIANT_TYPE_INT64)) jw_i64(f, g_variant_get_int64(v));
	else if (g_variant_is_of_type(v, G_VARIANT_TYPE_INT32)) jw_i64(f, g_variant_get_int32(v));
	else if (g_variant_is_of_type(v, G_VARIANT_TYPE_UINT64)) jw_u64(f, g_variant_get_uint64(v));
	else if (g_variant_is_of_type(v, G_VARIANT_TYPE_DOUBLE)) jw_double(f, g_variant_get_double(v));
	else if (g_variant_is_of_type(v, G_VARIANT_TYPE_BOOLEAN)) jw_bool(f, g_variant_get_boolean(v));
	else { char *s = g_variant_print(v, FALSE); jw_str(f, s); g_free(s); }
}

void jw_kv_key(FILE *f, int *first, const char *key) {
	if (!*first) fputc(',', f);
	*first = 0;
	jw_key(f, key);
}
void jw_kv_str(FILE *f, int *first, const char *key, const char *v) { jw_kv_key(f, first, key); jw_str(f, v); }
void jw_kv_u64(FILE *f, int *first, const char *key, uint64_t v) { jw_kv_key(f, first, key); jw_u64(f, v); }
void jw_kv_i64(FILE *f, int *first, const char *key, int64_t v) { jw_kv_key(f, first, key); jw_i64(f, v); }
void jw_kv_bool(FILE *f, int *first, const char *key, int v) { jw_kv_key(f, first, key); jw_bool(f, v); }
void jw_kv_double(FILE *f, int *first, const char *key, double v) { jw_kv_key(f, first, key); jw_double(f, v); }
