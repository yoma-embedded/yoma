cmake_minimum_required(VERSION 3.20)
project(yoma-la C)

# yoma-la:DSLogic 逻辑分析仪的无头引擎 —— 采集(libsigrok4DSL)与协议解码(libsigrokdecode4DSL)。
# 两组源码 vendored 自 DreamSourceLab/DSView(提交见 vendor/UPSTREAM.json,`bun vendor.ts --from <DSView>`
# 重新 vendored,patches/ 自动应用)。DSView 的树里它们不是库(全树唯一 add_executable),所以这里自己建 target。
#
# 许可:本目录含 vendor/ 按 GPLv3 发布(LICENSE = DSView 的 COPYING);vendor/res/ 的固件与 FPGA 位流是 MIT。
# yoma-la 是独立进程,Yoma 主体只经命令行与它对话、保持 MIT;再分发二进制时必须一并提供本目录源码。
#
# 依赖:glib-2.0、libusb-1.0、zlib、Python3(内嵌解释器跑 150 个 pd.py)。Windows 只能 MSYS2/ucrt64
# (源码 #include <unistd.h>,MSVC 走不通;DSView 官方 Windows 包也是 MinGW 构建):
#   pacman -S mingw-w64-ucrt-x86_64-{gcc,glib2,libusb,zlib,python,pkgconf,cmake,ninja}
#   bun engines/logic-analyzer/build.ts            # 或 bun engines/build.ts 顺带做
#   ./run.sh decode --in vendor/demo/logic/protocol.demo --pd "i2c0=1:i2c:scl=SCL:sda=SDA"
# 子命令与输出约定见 src/main.c 头注释;上游怪癖见 CLAUDE.md「逻辑分析仪」。

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(PkgConfig REQUIRED)
pkg_check_modules(GLIB REQUIRED IMPORTED_TARGET glib-2.0 gthread-2.0)
pkg_check_modules(LIBUSB REQUIRED IMPORTED_TARGET libusb-1.0)
pkg_check_modules(ZLIB REQUIRED IMPORTED_TARGET zlib)
pkg_check_modules(PYTHON REQUIRED IMPORTED_TARGET python3-embed)

set(VENDOR ${CMAKE_CURRENT_SOURCE_DIR}/vendor)

# 把 vendor/UPSTREAM.json 里的提交编进 --version,"用户的 DSView 比内置固件新"才有得查。
file(READ ${VENDOR}/UPSTREAM.json UPSTREAM_JSON)
string(REGEX MATCH "\"describe\": \"([^\"]+)\"" _m "${UPSTREAM_JSON}")
set(DSVIEW_DESCRIBE "${CMAKE_MATCH_1}")
string(REGEX MATCH "\"commit\": \"([^\"]+)\"" _m "${UPSTREAM_JSON}")
set(DSVIEW_COMMIT "${CMAKE_MATCH_1}")

# ---- common(minizip + xlog),两个库都要 ----------------------------------------------
add_library(dsl_common STATIC
  ${VENDOR}/common/minizip/zip.c
  ${VENDOR}/common/minizip/unzip.c
  ${VENDOR}/common/minizip/ioapi.c
  ${VENDOR}/common/log/xlog.c)
target_include_directories(dsl_common PUBLIC ${VENDOR}/common)
target_link_libraries(dsl_common PUBLIC PkgConfig::ZLIB PkgConfig::GLIB)

# ---- libsigrok4DSL(采集)-------------------------------------------------------------
set(SR_SRC ${VENDOR}/libsigrok4DSL)
add_library(sigrok4dsl STATIC
  ${SR_SRC}/version.c ${SR_SRC}/strutil.c ${SR_SRC}/std.c ${SR_SRC}/session_driver.c
  ${SR_SRC}/session.c ${SR_SRC}/log.c ${SR_SRC}/hwdriver.c ${SR_SRC}/error.c ${SR_SRC}/backend.c
  ${SR_SRC}/output/output.c ${SR_SRC}/input/input.c ${SR_SRC}/hardware/demo/demo.c
  ${SR_SRC}/input/in_binary.c ${SR_SRC}/input/in_vcd.c ${SR_SRC}/input/in_wav.c
  ${SR_SRC}/output/csv.c ${SR_SRC}/output/gnuplot.c ${SR_SRC}/output/srzip.c ${SR_SRC}/output/vcd.c
  ${SR_SRC}/hardware/DSL/dslogic.c ${SR_SRC}/hardware/common/usb.c ${SR_SRC}/hardware/common/ezusb.c
  ${SR_SRC}/trigger.c ${SR_SRC}/dsdevice.c ${SR_SRC}/hardware/DSL/dscope.c
  ${SR_SRC}/hardware/DSL/command.c ${SR_SRC}/hardware/DSL/dsl.c ${SR_SRC}/lib_main.c)
target_include_directories(sigrok4dsl PUBLIC ${SR_SRC})
target_link_libraries(sigrok4dsl PUBLIC dsl_common PkgConfig::GLIB PkgConfig::LIBUSB)
target_compile_options(sigrok4dsl PRIVATE -Wno-unused-parameter -Wno-unused-variable -Wno-unused-but-set-variable -Wno-sign-compare)

# ---- libsigrokdecode4DSL(解码,内嵌 CPython)-----------------------------------------
# config.h / version.h 是 autotools 产物,DSView 不入库;重新 vendor 会把它冲掉。
# CMake 在构建目录生成。不定义 DECODERS_DIR —— 引擎经 srd_init(path) 传入解码器目录。
configure_file(${CMAKE_CURRENT_SOURCE_DIR}/config.h.in ${CMAKE_CURRENT_BINARY_DIR}/config.h @ONLY)
configure_file(${CMAKE_CURRENT_SOURCE_DIR}/version.h.in ${CMAKE_CURRENT_BINARY_DIR}/version.h @ONLY)
set(SRD_SRC ${VENDOR}/libsigrokdecode4DSL)
add_library(sigrokdecode4dsl STATIC
  ${SRD_SRC}/type_decoder.c ${SRD_SRC}/srd.c ${SRD_SRC}/module_sigrokdecode.c ${SRD_SRC}/decoder.c
  ${SRD_SRC}/error.c ${SRD_SRC}/exception.c ${SRD_SRC}/instance.c ${SRD_SRC}/log.c
  ${SRD_SRC}/session.c ${SRD_SRC}/util.c ${SRD_SRC}/version.c)
target_include_directories(sigrokdecode4dsl PUBLIC ${CMAKE_CURRENT_BINARY_DIR} ${SRD_SRC})
target_link_libraries(sigrokdecode4dsl PUBLIC dsl_common PkgConfig::GLIB PkgConfig::PYTHON)
target_compile_options(sigrokdecode4dsl PRIVATE -Wno-unused-parameter -Wno-unused-variable -Wno-unused-but-set-variable -Wno-sign-compare)

# ---- 引擎本体 ----------------------------------------------------------------------------
add_executable(yoma-la
  src/main.c src/jsonw.c src/dsl.c src/decode.c src/decoders.c src/capture.c)
target_include_directories(yoma-la PRIVATE src)
target_compile_definitions(yoma-la PRIVATE
  YOMA_LA_VERSION="0.1.0"
  DSVIEW_DESCRIBE="${DSVIEW_DESCRIBE}"
  DSVIEW_COMMIT="${DSVIEW_COMMIT}")
target_compile_options(yoma-la PRIVATE -Wall -Wextra)
target_link_libraries(yoma-la PRIVATE sigrok4dsl sigrokdecode4dsl dsl_common)
if(WIN32)
  target_link_libraries(yoma-la PRIVATE ws2_32)
endif()

install(TARGETS yoma-la RUNTIME DESTINATION bin)
