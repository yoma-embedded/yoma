#pragma once
#include <stdio.h>

/* 子命令入口;argv[0] 是子命令名。 */
int cmd_decode(int argc, char **argv);
int cmd_decoders(int argc, char **argv);
int cmd_devices(int argc, char **argv);
int cmd_capture(int argc, char **argv);

/* 解码器目录:--decoders 参数 > YOMA_LA_DECODERS 环境变量 > <exe>/../data/la/decoders >
 * <源码树>/vendor/libsigrokdecode4DSL/decoders。返回 g_strdup 的路径或 NULL。 */
char *resolve_decoders_dir(const char *cli_override);
/* 固件 / FPGA 位流目录,同样的解析顺序(--res、YOMA_LA_RES、<exe>/../data/la/res、vendor/res)。 */
char *resolve_res_dir(const char *cli_override);

/* 初始化 libsigrokdecode(含内嵌 Python)。只能调一次。 */
int srd_bootstrap(const char *decoders_dir, char **err);

/* stderr 上的诊断行,统一前缀,便于 TS 侧过滤。 */
#define note(...) do { fprintf(stderr, "yoma-la: " __VA_ARGS__); fputc('\n', stderr); } while (0)
