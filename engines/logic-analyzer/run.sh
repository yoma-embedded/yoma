#!/usr/bin/env bash
# 开发期跑 build/ 里的产物:把 MSYS2 ucrt64 的 DLL 目录放进 PATH。分发时 DLL 会被拷到 exe 旁边,不需要这个。
#   engines/logic-analyzer/run.sh decoders --json 1:i2c
export PATH="/c/msys64/ucrt64/bin:$PATH"
exec "$(dirname "$0")/build/yoma-la.exe" "$@"
