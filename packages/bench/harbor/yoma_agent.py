"""Harbor 适配器:把 yoma 当成一个 agent 交给开源跑批器。

    harbor run -d terminal-bench/terminal-bench-2-1 \
        --agent packages/bench/harbor/yoma_agent.py:Yoma \
        -m deepseek/deepseek-v4-flash-vision-exp -n 3

形态与 `harbor.agents.installed.opencode` / `pi` 一样是 **installed agent**:安装期把一个
纯 node 产物送进任务容器,运行期起它跑一轮。产物是 `packages/bench/dist/yoma-eval-entry.mjs`
(内核整个 inline),**跑之前要先在本机构建**::

    bun --cwd packages/bench build:eval

三条与别的适配器不同、值得写下来的决定:

1. **凭据只走环境变量,不写 auth.json。** `--config-dir` 落在 `/logs/agent/` 下(会话 JSONL
   要被收走以便回桌面端回放),而那个目录整个会下载到本机 —— 把 key 写进去等于把它落进
   每一次 trial 的日志。pi-ai 的 deepseek provider 本来就认 `DEEPSEEK_API_KEY`,
   `ModelConnectionSpec(passthrough=True)` 会原名传进容器。

2. **超时给 yoma 自己收。** `timeout_ms` 应当略小于 task.toml 给 agent 的超时:yoma 到点
   会 abort 并照常写出 result.json(工具调用、用量、错误都在),而 Harbor 硬杀之后什么都
   拿不到 —— 一次超时于是从"有证据的失败"变成"没有数据的空洞"。

3. **退出码 2 = 配置错误**(缺 key、未知模型),必须与"agent 没做出来"分开:后者是
   reward 0 的真实结果,前者是我们自己的配置问题,混在一起会把"忘了配 key"记成模型失败。
"""

from __future__ import annotations

import json
import os
import shlex
from collections import OrderedDict
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    BaseInstalledAgent,
    CliFlag,
    ModelNotFoundError,
    with_prompt_template,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json

#: 本机产物位置。`packages/bench/harbor/yoma_agent.py` → `packages/bench/dist/…`。
_DEFAULT_BUNDLE = Path(__file__).resolve().parent.parent / "dist" / "yoma-eval-entry.mjs"

_REMOTE_DIR = PurePosixPath("/installed-agent/yoma")
_REMOTE_BUNDLE = _REMOTE_DIR / "yoma-eval-entry.mjs"
_REMOTE_INSTRUCTION = _REMOTE_DIR / "instruction.md"
_REMOTE_FAUX = _REMOTE_DIR / "faux.json"

#: 容器里的 yoma 配置目录(凭据/技能/上下文/会话)。放在 agent 日志目录下,跑完随日志一起收走。
_REMOTE_CONFIG_DIR = EnvironmentPaths.agent_dir / "yoma-config"

_RESULT_FILENAME = "yoma-result.json"
_EVENTS_FILENAME = "yoma-events.jsonl"
_STDOUT_FILENAME = "yoma.txt"

#: 与 kernel 的 THINKING_ORDER 同序。填模型不支持的档位是安全的(pickThinkingLevel 会落到最近一档)。
_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

#: node 不在 PATH 时先加载 nvm(musl 镜像上 ~/.nvm 不存在,node 由 apk 装)。
_NODE_PREFIX = "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "


class Yoma(BaseInstalledAgent):
    """yoma —— 面向嵌入式调试的 agent(内核 + 13 个工具),经无头入口跑一轮。"""

    # 对齐 PyPI 版 harbor 0.22.0 的写法(`uv tool install harbor` 装到的那份)。
    # GitHub main 上已经改成 `capabilities = AgentCapabilities(atif=True)`,两者版本号相同但
    # 内容不同 —— 以**实际安装的那份**为准,否则 import 就会失败。见 README「版本」一节。
    SUPPORTS_ATIF: bool = True
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    CLI_FLAGS = [
        CliFlag("thinking", cli="--thinking", type="enum", choices=_THINKING_LEVELS),
    ]

    def __init__(
        self,
        *args: Any,
        bundle: str | None = None,
        timeout_ms: int | None = None,
        faux: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        raw_bundle = bundle or os.environ.get("YOMA_EVAL_BUNDLE")
        self._bundle = Path(raw_bundle).resolve() if raw_bundle else _DEFAULT_BUNDLE
        self._timeout_ms = int(timeout_ms) if timeout_ms is not None else None
        raw_faux = faux or os.environ.get("YOMA_EVAL_FAUX")
        self._faux = Path(raw_faux).resolve() if raw_faux else None
        self._instruction: str | None = None

    # ── 身份 ────────────────────────────────────────────────────────────────

    @staticmethod
    @override
    def name() -> str:
        return "yoma"

    @override
    def get_version_command(self) -> str | None:
        # 产物的 --help 第一行是 `yoma-eval-entry (<sha>@<date>)`。
        return f"{_NODE_PREFIX}node {shlex.quote(_REMOTE_BUNDLE.as_posix())} --help | head -1"

    @override
    def parse_version(self, stdout: str) -> str:
        line = stdout.strip().splitlines()[0] if stdout.strip() else ""
        if "(" in line and ")" in line:
            return line[line.index("(") + 1 : line.rindex(")")]
        return line or "unknown"

    # ── 安装 ────────────────────────────────────────────────────────────────

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not self._bundle.is_file():
            raise FileNotFoundError(
                f"找不到 yoma 评测产物:{self._bundle}\n"
                "先在本机构建:bun --cwd packages/bench build:eval\n"
                "(或用 bundle=<path> / YOMA_EVAL_BUNDLE 指定别处的 .mjs)"
            )

        # coreutils 提供 run() 里管道用的 stdbuf,busybox 不带;nodejs/npm 覆盖 musl 镜像。
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "coreutils", "nodejs", "npm")
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                # nvm 下载的官方 node 二进制在 musl 上跑不起来(Alpine),那里用 apk 装的。
                "if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then "
                "node --version; "
                f"else {nvm_node_install_snippet()}; fi"
            ),
        )

        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {shlex.quote(_REMOTE_DIR.as_posix())} "
                f"{shlex.quote(EnvironmentPaths.agent_dir.as_posix())}"
            ),
        )
        await environment.upload_file(self._bundle, _REMOTE_BUNDLE.as_posix())
        if self._faux is not None:
            if not self._faux.is_file():
                raise FileNotFoundError(f"找不到 faux 脚本:{self._faux}")
            await environment.upload_file(self._faux, _REMOTE_FAUX.as_posix())

        agent_user = str(environment.default_user or "root")
        await self.exec_as_root(
            environment,
            command=(
                f"chown -R {shlex.quote(agent_user)}:{shlex.quote(agent_user)} "
                f"{shlex.quote(_REMOTE_DIR.as_posix())}"
            ),
        )

    # ── 运行 ────────────────────────────────────────────────────────────────

    def _register_skills_command(self) -> str | None:
        """把 Harbor 送进来的技能目录接到 yoma 认的位置(`<configDir>/skills`)。

        SkillsBench 这类"带不带技能"的对照实验靠它。yoma 是**建会话时快照一次**读技能,
        所以必须在起 agent 之前拷完。
        """
        if not self.skills_dir:
            return None
        dest = (_REMOTE_CONFIG_DIR / "skills").as_posix()
        return (
            f"mkdir -p {shlex.quote(dest)} && "
            f"cp -r {shlex.quote(self.skills_dir)}/* {shlex.quote(dest)}/ 2>/dev/null || true"
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("model 必须写成 provider/model_id,例如 deepseek/deepseek-v4-flash-vision-exp")
        provider_id, model_id = self.model_name.split("/", 1)

        self._instruction = instruction
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        instruction_path = self.logs_dir / "instruction.md"
        instruction_path.write_text(instruction, encoding="utf-8")
        await environment.upload_file(instruction_path, _REMOTE_INSTRUCTION.as_posix())

        env = dict(self.model_connection.env)

        if skills_command := self._register_skills_command():
            await self.exec_as_agent(environment, command=skills_command, env=env)

        agent_dir = EnvironmentPaths.agent_dir
        parts = [
            f"node {shlex.quote(_REMOTE_BUNDLE.as_posix())}",
            # 任务的工作目录 = 容器默认 cwd(镜像的 WORKDIR)。Harbor 没有把它作为属性暴露出来,
            # 所以让 shell 自己展开 —— 这里**故意不 quote** `$PWD`。
            '--cwd "$PWD"',
            f"--instruction-file {shlex.quote(_REMOTE_INSTRUCTION.as_posix())}",
            f"--out {shlex.quote((agent_dir / _RESULT_FILENAME).as_posix())}",
            f"--events {shlex.quote((agent_dir / _EVENTS_FILENAME).as_posix())}",
            f"--config-dir {shlex.quote(_REMOTE_CONFIG_DIR.as_posix())}",
            f"--provider {shlex.quote(provider_id)}",
            f"--model {shlex.quote(model_id)}",
        ]
        if self._timeout_ms is not None:
            parts.append(f"--timeout-ms {self._timeout_ms}")
        if self._faux is not None:
            # 零 key 冒烟:验证"装 node → 传产物 → 跑起来 → 收产物"这条链路本身。
            # 判据一定不过(脚本是死的),那不是这次要看的东西。
            parts.append(f"--faux {shlex.quote(_REMOTE_FAUX.as_posix())}")
        if cli_flags := self.build_cli_flags():
            parts.append(cli_flags)

        command = (
            f"{_NODE_PREFIX}{' '.join(parts)} "
            f"2>&1 </dev/null | stdbuf -oL tee {shlex.quote((agent_dir / _STDOUT_FILENAME).as_posix())}"
        )

        # 用 environment.exec 而不是 exec_as_agent:要拿到 return_code 自己分类(退出码 2 是
        # 配置错误,不是 agent 失败),而且失败时也要先把产物取回来再抛。
        result = await environment.exec(
            command=f"set -o pipefail; {command}",
            env=env,
        )

        await self._download_artifacts(environment)
        self.populate_context_post_run(context)

        if result.return_code == 2:
            raise self._config_error(result.stdout or "")
        if result.return_code != 0:
            raise self._classify_exec_error(command, result)

    @staticmethod
    def _config_error(output: str) -> Exception:
        """退出码 2 的两种成因,给 Harbor 的重试策略一个能区分的类型。"""
        text = output.lower()
        if "no api key" in text or "auth.json" in text:
            return AgentAuthenticationError(f"yoma 起不来:缺凭据。{output.strip()[-500:]}")
        if "not found" in text and "model" in text:
            return ModelNotFoundError(f"yoma 起不来:模型不可用。{output.strip()[-500:]}")
        return AgentAuthenticationError(f"yoma 配置错误(退出码 2)。{output.strip()[-500:]}")

    async def _download_artifacts(self, environment: BaseEnvironment) -> None:
        """产物是best-effort:`/logs/agent` 在 docker 下是挂载,在远端环境未必。"""
        for filename in (_RESULT_FILENAME, _EVENTS_FILENAME, _STDOUT_FILENAME):
            target = self.logs_dir / filename
            if target.exists():
                continue
            try:
                await environment.download_file(
                    (EnvironmentPaths.agent_dir / filename).as_posix(), target
                )
            except Exception as exc:  # noqa: BLE001 —— 取日志失败不该盖过真正的失败原因
                self.logger.debug(f"取不回 yoma 产物 {filename}: {exc}")

    # ── 记账与 transcript ───────────────────────────────────────────────────

    def _read_result(self) -> dict[str, Any] | None:
        path = self.logs_dir / _RESULT_FILENAME
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            self.logger.debug(f"读不了 {path}: {exc}")
            return None

    def _read_events(self) -> list[dict[str, Any]]:
        path = self.logs_dir / _EVENTS_FILENAME
        if not path.exists():
            return []
        events: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return events

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        payload = self._read_result()
        if not payload:
            return
        result = payload.get("result") or {}
        usage = result.get("usage") or {}
        tokens = usage.get("tokens") or {}
        cache = tokens.get("cache") or {}

        cache_read = int(cache.get("read") or 0)
        # Harbor 的 n_input_tokens 口径是"含缓存的输入"(见 opencode/pi 适配器)。
        context.n_input_tokens = int(tokens.get("input") or 0) + cache_read
        context.n_output_tokens = int(tokens.get("output") or 0)
        context.n_cache_tokens = cache_read
        cost = float(usage.get("cost") or 0.0)
        # cost 为 0 多半是 pi-ai 定价表里没有这个模型的条目(静默 0),别把它当成"免费"。
        context.cost_usd = cost if cost > 0 else None

        metadata = {
            "yoma_build": payload.get("build"),
            "provider": payload.get("providerID"),
            "model": payload.get("modelID"),
            "thinking": payload.get("thinking"),
            "faux": payload.get("faux"),
            "wall_ms": payload.get("wallMs"),
            "elapsed_ms": result.get("elapsedMs"),
            "stop_reason": result.get("stopReason"),
            # provider 抽风被内核当数据自动重试,不进 stopReason —— 不记就会被当成"模型不行"。
            "provider_errors": result.get("errors") or [],
            "tool_calls": len(result.get("toolCalls") or []),
            "tool_errors": sum(
                1 for call in (result.get("toolCalls") or []) if call.get("status") == "error"
            ),
            "reasoning_tokens": int(tokens.get("reasoning") or 0),
        }
        context.metadata = {**(context.metadata or {}), **metadata}

        try:
            trajectory = self._build_trajectory(payload, self._read_events())
        except Exception:  # noqa: BLE001 —— transcript 是分析材料,坏了不该带垮 trial
            self.logger.exception("yoma 事件流转 ATIF 失败")
            return
        if trajectory is None:
            return
        try:
            (self.logs_dir / "trajectory.json").write_text(
                format_trajectory_json(trajectory.to_json_dict()), encoding="utf-8"
            )
        except OSError as exc:
            self.logger.debug(f"写 trajectory.json 失败: {exc}")

    def _build_trajectory(
        self, payload: dict[str, Any], events: list[dict[str, Any]]
    ) -> Trajectory | None:
        """把 yoma 的事件流转成 ATIF。

        一条 assistant 消息 = 一个 Step(一轮里有多条:每次工具循环一条)。part 按
        `messageID` 归组 —— **不能按到达顺序**,并行工具的完成序与源序不同。
        `synthetic` 的消息/文本是压缩摘要与 bash 回显,不是模型说的,不进 transcript。
        """
        result = payload.get("result") or {}
        session_id = result.get("sessionID") or "unknown"

        messages: OrderedDict[str, dict[str, Any]] = OrderedDict()
        for event in events:
            if event.get("type") != "message.updated":
                continue
            message = event.get("message") or {}
            message_id = message.get("id")
            if not message_id:
                continue
            messages[message_id] = message

        # messageID → {partID: 最新快照}。part 会被反复更新(流式),后到的是**全量快照**,
        # 所以按 part id 覆盖而不是追加;dict 保插入顺序,于是 part 的源序天然保住。
        texts: dict[str, OrderedDict[str, str]] = {}
        reasonings: dict[str, OrderedDict[str, str]] = {}
        tools: dict[str, OrderedDict[str, dict[str, Any]]] = {}
        for event in events:
            if event.get("type") != "message.part.updated":
                continue
            part = event.get("part") or {}
            message_id = part.get("messageID")
            if not message_id:
                continue
            part_id = part.get("id") or ""
            part_type = part.get("type")
            if part_type == "text" and not part.get("synthetic"):
                texts.setdefault(message_id, OrderedDict())[part_id] = part.get("text") or ""
            elif part_type == "reasoning":
                reasonings.setdefault(message_id, OrderedDict())[part_id] = part.get("text") or ""
            elif part_type == "tool":
                tools.setdefault(message_id, OrderedDict())[part_id] = part

        steps: list[Step] = []
        total_prompt = total_completion = total_cache = 0
        total_cost = 0.0

        if self._instruction:
            steps.append(Step(step_id=1, source="user", message=self._instruction))

        for message_id, message in messages.items():
            if message.get("role") != "assistant" or message.get("synthetic"):
                continue

            tool_calls: list[ToolCall] = []
            observations: list[ObservationResult] = []
            for part in (tools.get(message_id) or {}).values():
                state = part.get("state") or {}
                call_id = part.get("callID") or part.get("id") or ""
                arguments = state.get("input")
                if not isinstance(arguments, dict):
                    arguments = {"value": arguments} if arguments is not None else {}
                tool_calls.append(
                    ToolCall(
                        tool_call_id=call_id,
                        function_name=str(part.get("tool") or "unknown"),
                        arguments=arguments,
                    )
                )
                content = state.get("output") if state.get("status") == "completed" else state.get("error")
                if content is not None:
                    observations.append(
                        ObservationResult(source_call_id=call_id or None, content=str(content))
                    )

            tokens = message.get("tokens") or {}
            cache = tokens.get("cache") or {}
            prompt_tokens = int(tokens.get("input") or 0) + int(cache.get("read") or 0)
            completion_tokens = int(tokens.get("output") or 0)
            cache_read = int(cache.get("read") or 0)
            cost = float(message.get("cost") or 0.0)
            total_prompt += prompt_tokens
            total_completion += completion_tokens
            total_cache += cache_read
            total_cost += cost

            step_kwargs: dict[str, Any] = {
                "step_id": len(steps) + 1,
                "source": "agent",
                "message": "\n".join(t for t in texts.get(message_id, {}).values() if t),
                "model_name": self.model_name,
                "llm_call_count": 1,
            }
            if timestamp := _iso(message.get("time", {}).get("created")):
                step_kwargs["timestamp"] = timestamp
            if reasoning := "\n\n".join(t for t in reasonings.get(message_id, {}).values() if t):
                step_kwargs["reasoning_content"] = reasoning
            if tool_calls:
                step_kwargs["tool_calls"] = tool_calls
            if observations:
                step_kwargs["observation"] = Observation(results=observations)
            if prompt_tokens or completion_tokens:
                step_kwargs["metrics"] = Metrics(
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    cached_tokens=cache_read or None,
                    cost_usd=cost or None,
                    extra={"reasoning_tokens": int(tokens.get("reasoning") or 0)}
                    if tokens.get("reasoning")
                    else None,
                )
            steps.append(Step(**step_kwargs))

        if not steps:
            return None

        return Trajectory(
            schema_version="ATIF-v1.7",
            session_id=session_id,
            agent=Agent(
                name="yoma",
                version=self.version() or payload.get("build") or "unknown",
                model_name=self.model_name,
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=total_prompt or None,
                total_completion_tokens=total_completion or None,
                total_cached_tokens=total_cache or None,
                total_cost_usd=total_cost or None,
                total_steps=len(steps),
            ),
        )


def _iso(timestamp_ms: Any) -> str | None:
    if not isinstance(timestamp_ms, (int, float)):
        return None
    from datetime import datetime, timezone

    try:
        return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).isoformat()
    except (OSError, ValueError, OverflowError):
        return None
