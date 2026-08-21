/* yoma-la —— DSLogic 逻辑分析仪的无头引擎(采集 + 协议解码),给 Yoma 的 `la` 工具当子进程。
 *
 *   yoma-la devices  --json                       枚举 DSLogic
 *   yoma-la capture  --out DIR …                  采集,写 .dsl
 *   yoma-la decode   --in X.dsl --pd … [--pd …]   跑 DSView 的解码器,NDJSON 到 stdout
 *   yoma-la decoders --json [ID…]                 列解码器(通道 / 选项 / 行 / 类)
 *   yoma-la --version
 *
 * 约定:stdout 只放数据(JSON / NDJSON,UTF-8,Windows 下切成二进制模式防 CRLF),
 * 诊断一律 stderr、前缀 "yoma-la: ";退出码 0 成功、1 运行失败、2 参数错。 */
#include "engine.h"
#include <glib.h>
#include <libsigrokdecode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

#ifndef YOMA_LA_VERSION
#define YOMA_LA_VERSION "0.0.0-dev"
#endif
#ifndef DSVIEW_DESCRIBE
#define DSVIEW_DESCRIBE "?"
#endif
#ifndef DSVIEW_COMMIT
#define DSVIEW_COMMIT "?"
#endif

static int verbose = 0;

static char *exe_dir(void) {
#ifdef _WIN32
	wchar_t wbuf[MAX_PATH];
	DWORD n = GetModuleFileNameW(NULL, wbuf, MAX_PATH);
	if (!n) return NULL;
	char *p = g_utf16_to_utf8((gunichar2 *)wbuf, n, NULL, NULL, NULL);
	char *d = g_path_get_dirname(p);
	g_free(p);
	return d;
#else
	char buf[4096];
	ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
	if (n <= 0) return NULL;
	buf[n] = 0;
	return g_path_get_dirname(buf);
#endif
}

/* 按顺序试:显式参数 → 环境变量 → <exe>/../data/la/<leaf> → 源码树 vendor/<leaf>(开发期)。 */
static char *resolve_data_dir(const char *cli, const char *env, const char *leaf, const char *vendor_leaf) {
	if (cli && g_file_test(cli, G_FILE_TEST_IS_DIR)) return g_strdup(cli);
	const char *e = g_getenv(env);
	if (e && g_file_test(e, G_FILE_TEST_IS_DIR)) return g_strdup(e);
	char *d = exe_dir();
	if (d) {
		char *cands[] = {
			g_build_filename(d, "..", "data", "la", leaf, NULL),
			g_build_filename(d, "data", "la", leaf, NULL),
			g_build_filename(d, "..", "vendor", vendor_leaf, NULL),          /* build/ 里直接跑 */
			g_build_filename(d, "..", "..", "vendor", vendor_leaf, NULL),    /* build/Release/ 里跑 */
			NULL,
		};
		char *hit = NULL;
		for (int i = 0; cands[i]; i++) {
			if (!hit && g_file_test(cands[i], G_FILE_TEST_IS_DIR)) hit = g_canonicalize_filename(cands[i], NULL);
			g_free(cands[i]);
		}
		g_free(d);
		if (hit) return hit;
	}
	return NULL;
}

char *resolve_decoders_dir(const char *cli) { return resolve_data_dir(cli, "YOMA_LA_DECODERS", "decoders", "libsigrokdecode4DSL/decoders"); }
char *resolve_res_dir(const char *cli) { return resolve_data_dir(cli, "YOMA_LA_RES", "res", "res"); }

int srd_bootstrap(const char *decoders_dir, char **err) {
	/* Python 标准库在哪:分发时 <decoders>/../python 是随包带的裁剪版(目录);开发期 engines/build.ts
	 * 写一个 <decoders>/../python.home 文本文件指向 MSYS2 的 ucrt64 前缀(不用 junction:打包脚本
	 * dereference 复制时会把整个 ucrt64 卷进去)。两者都没有就用链接时那个解释器自己的默认。 */
	if (!g_getenv("PYTHONHOME")) {
		char *home = g_build_filename(decoders_dir, "..", "python", NULL);
		char *h = NULL;
		if (g_file_test(home, G_FILE_TEST_IS_DIR)) {
			h = g_canonicalize_filename(home, NULL);
		} else {
			char *pointer = g_build_filename(decoders_dir, "..", "python.home", NULL);
			char *text = NULL;
			if (g_file_get_contents(pointer, &text, NULL, NULL) && text) {
				g_strstrip(text);
				if (*text && g_file_test(text, G_FILE_TEST_IS_DIR)) h = g_strdup(text);
				g_free(text);
			}
			g_free(pointer);
		}
		if (h) {
			g_setenv("PYTHONHOME", h, TRUE);
#ifdef _WIN32
			_putenv_s("PYTHONHOME", h);
#endif
			if (verbose) note("PYTHONHOME=%s", h);
			g_free(h);
		}
		g_free(home);
	}
	/* 解码器自己 print 的东西(极少)别用 GBK 编码 */
	g_setenv("PYTHONIOENCODING", "utf-8", FALSE);
	g_setenv("PYTHONUTF8", "1", FALSE);
	g_setenv("PYTHONDONTWRITEBYTECODE", "1", FALSE);
#ifdef _WIN32
	_putenv_s("PYTHONIOENCODING", "utf-8");
	_putenv_s("PYTHONUTF8", "1");
	_putenv_s("PYTHONDONTWRITEBYTECODE", "1");
#endif
	srd_log_level(verbose ? 4 : 1);
	if (srd_init(decoders_dir) != SRD_OK) {
		*err = g_strdup_printf("libsigrokdecode 初始化失败(解码器目录 %s;Python 运行时找不到标准库时也会落到这里,设 PYTHONHOME 或把 python/ 放在 decoders/ 旁边)", decoders_dir);
		return 1;
	}
	if (verbose) note("decoders dir: %s", decoders_dir);
	return 0;
}

static void usage(FILE *f) {
	fputs("yoma-la " YOMA_LA_VERSION " (DSView " DSVIEW_DESCRIBE ")\n"
	      "  yoma-la devices  --json\n"
	      "  yoma-la capture  --out DIR --rate 25M --samples 4M --ch 0=SCL,1=SDA [--trigger 1=f] [--pos 10] [--vth 1.65]\n"
	      "  yoma-la decode   --in X.dsl --pd \"i2c0=1:i2c:scl=1:sda=0\" [--pd \"eep=eeprom24xx:on=i2c0\"] [--from S] [--to S]\n"
	      "  yoma-la decoders --json [ID…]\n"
	      "  全局:--verbose  --decoders DIR  --res DIR  --version\n", f);
}

int main(int argc, char **argv) {
#ifdef _WIN32
	SetConsoleOutputCP(CP_UTF8);
	_setmode(_fileno(stdout), _O_BINARY);
#endif
	/* 全局开关可以出现在任何位置;剥掉后把剩下的交给子命令 */
	char **rest = g_new0(char *, argc + 1);
	int n = 0;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--verbose") || !strcmp(argv[i], "-v")) verbose = 1;
		else if (!strcmp(argv[i], "--srlog") && i + 1 < argc) { g_setenv("YOMA_LA_SRLOG", argv[++i], TRUE); }
		else if (!strcmp(argv[i], "--version") || !strcmp(argv[i], "-V")) {
			printf("{\"yoma-la\":\"%s\",\"dsview\":\"%s\",\"dsview_commit\":\"%s\",\"libsigrokdecode\":\"%s\"}\n",
			       YOMA_LA_VERSION, DSVIEW_DESCRIBE, DSVIEW_COMMIT, srd_package_version_string_get());
			return 0;
		} else if (!strcmp(argv[i], "--help") || !strcmp(argv[i], "-h")) { usage(stdout); return 0; }
		else rest[n++] = argv[i];
	}
	if (n == 0) { usage(stderr); return 2; }
	const char *cmd = rest[0];
	int rc;
	if (!strcmp(cmd, "decode")) rc = cmd_decode(n, rest);
	else if (!strcmp(cmd, "decoders")) rc = cmd_decoders(n, rest);
	else if (!strcmp(cmd, "devices")) rc = cmd_devices(n, rest);
	else if (!strcmp(cmd, "capture")) rc = cmd_capture(n, rest);
	else { note("不认识的子命令 %s", cmd); usage(stderr); rc = 2; }
	g_free(rest);
	fflush(stdout);
	return rc;
}
