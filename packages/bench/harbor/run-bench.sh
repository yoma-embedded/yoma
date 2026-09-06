#!/usr/bin/env bash
# 固定参数的一键跑批 —— 两个人跑出来的数才可比。
#
#   ./run-bench.sh smoke                      零 key 冒烟(faux,验链路)
#   ./run-bench.sh tb21                       Terminal-Bench 2.1 × yoma
#   ./run-bench.sh tb21-baseline              同一个模型 × terminus-2 / opencode(对照组)
#   ./run-bench.sh polyglot | skills | swe    其它数据集
#
# 环境变量:
#   DEEPSEEK_API_KEY   必需(冒烟除外)
#   YOMA_EVAL_MODEL    被测模型,默认 deepseek/deepseek-v4-flash-vision-exp
#   YOMA_BASE_MODEL    对照组模型,默认 deepseek/deepseek-v4-flash(pi-ai 目录里有的那个)
#   N_CONCURRENT       并发 trial 数,默认 4
#   K_ATTEMPTS         每题跑几次,默认 3(pass@k 与 pass^k 都要它)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
bundle="$here/../dist/yoma-eval-entry.mjs"
jobs_dir="${YOMA_EVAL_JOBS:-$repo/../evals/jobs}"

# 中文 Windows 的 GBK 控制台会让 Harbor 的 rich 进度条当场 UnicodeEncodeError —— 实测踩过。
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1
# Harbor 的 --agent 走 importlib,要模块路径不是文件路径。
export PYTHONPATH="$here${PYTHONPATH:+:$PYTHONPATH}"

model="${YOMA_EVAL_MODEL:-deepseek/deepseek-v4-flash-vision-exp}"
base_model="${YOMA_BASE_MODEL:-deepseek/deepseek-v4-flash}"
n="${N_CONCURRENT:-4}"
k="${K_ATTEMPTS:-3}"
stamp="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$bundle" ]]; then
  echo "找不到产物 $bundle —— 先跑:bun --cwd packages/bench build:eval" >&2
  exit 2
fi

run() { echo "+ harbor run $*" >&2; harbor run "$@" -o "$jobs_dir" -y; }

case "${1:-}" in
  smoke)
    run -d harbor/hello-world --agent yoma_agent:Yoma -m "$model" \
        --ak "faux=$here/faux-smoke.json" --job-name "yoma-smoke-$stamp" -q
    ;;
  tb21)
    run -d terminal-bench/terminal-bench-2-1 --agent yoma_agent:Yoma -m "$model" \
        -n "$n" -k "$k" --job-name "yoma-tb21-$stamp"
    ;;
  tb21-baseline)
    run -d terminal-bench/terminal-bench-2-1 -a terminus-2 -m "$base_model" \
        -n "$n" -k "$k" --job-name "terminus2-tb21-$stamp"
    run -d terminal-bench/terminal-bench-2-1 -a opencode -m "$base_model" \
        -n "$n" -k "$k" --job-name "opencode-tb21-$stamp"
    ;;
  polyglot)
    run -d aider/aider-polyglot --agent yoma_agent:Yoma -m "$model" \
        -n "$n" -k "$k" --job-name "yoma-polyglot-$stamp"
    ;;
  skills)
    run -d benchflow/skillsbench --agent yoma_agent:Yoma -m "$model" \
        -n "$n" -k "$k" --job-name "yoma-skills-$stamp"
    ;;
  swe)
    run -d swe-bench/swe-bench-verified --agent yoma_agent:Yoma -m "$model" \
        -n "$n" -k "$k" --job-name "yoma-swe-$stamp"
    ;;
  *)
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac

echo "结果:$jobs_dir  ·  看 transcript:harbor view $jobs_dir" >&2
