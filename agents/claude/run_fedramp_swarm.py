
import argparse
import asyncio
import difflib
import glob
import json
import math
import os
import shlex
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Tuple
from urllib.error import HTTPError, URLError

try:
    from agents.swarm.failure_heuristics import analyze_ci_failure  # type: ignore
except Exception:  # pragma: no cover - heuristics optional fallback
    analyze_ci_failure = None

REPO_ROOT = Path(__file__).resolve().parents[2]
EVIDENCE_DIR = REPO_ROOT / ".aegis" / "evidence"

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover
    yaml = None

# Ensure the Claude CLI has a writable configuration directory; otherwise the
# subprocess exits immediately with EPERM and the swarm cannot progress.
_claude_cfg = os.environ.get("CLAUDE_CONFIG_DIR")
if not _claude_cfg:
    fallback_cfg_dir = REPO_ROOT / ".aegis" / "claude_config"
    fallback_cfg_dir.mkdir(parents=True, exist_ok=True)
    (fallback_cfg_dir / "debug").mkdir(exist_ok=True)
    try:
        fallback_cfg_dir.chmod(0o700)
        (fallback_cfg_dir / "debug").chmod(0o700)
    except PermissionError:
        # Best-effort; on some systems chmod is restricted.
        pass
    os.environ["CLAUDE_CONFIG_DIR"] = str(fallback_cfg_dir)

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from claude_agent_sdk import ClaudeAgentOptions, query
from claude_agent_sdk.types import McpStdioServerConfig


def _claude_env() -> Dict[str, str]:
    """Gather env vars required by the Claude CLI and surface a useful error if missing."""
    required_keys = ["ANTHROPIC_API_KEY"]
    optional_keys = ["ANTHROPIC_API_URL", "CLAUDE_CONFIG_DIR"]

    env: Dict[str, str] = {}
    missing: list[str] = []
    for key in required_keys:
        value = os.environ.get(key)
        if value:
            env[key] = value
        else:
            missing.append(key)
    for key in optional_keys:
        value = os.environ.get(key)
        if value:
            env[key] = value

    if missing:
        raise RuntimeError(
            "Missing required environment variables for Claude CLI: "
            + ", ".join(missing)
        )
    return dict(env)


def _load_repo_config() -> Dict[str, Any]:
    cfg_path = REPO_ROOT / ".aegis" / "config.yaml"
    if yaml is None or not cfg_path.exists():
        return {}
    try:
        return yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}

def _fedramp_baseline_dir() -> Path:
    return (
        REPO_ROOT
        / "third_party"
        / "fedramp-automation"
        / "dist"
        / "content"
        / "rev5"
        / "baselines"
        / "json"
    )



def _base_mcp_servers() -> Dict[str, Any]:
    fedramp_dir = _fedramp_baseline_dir()

    nist = McpStdioServerConfig(
        command="uv",
        args=["run", "servers/nist_oscal/nist_oscal_server.py"],
        env={
            "FEDRAMP_BASELINES_DIR": str(fedramp_dir),
            "OSCAL_CATALOG": str(
                REPO_ROOT
                / "third_party"
                / "oscal-content"
                / "nist.gov"
                / "SP800-53"
                / "rev5"
                / "json"
                / "NIST_SP-800-53_rev5_catalog.json"
            ),
        },
    )
    fs = McpStdioServerConfig(
        command="mcp-server-filesystem",
        args=[
            str(REPO_ROOT),
            str(REPO_ROOT / "third_party" / "oscal-content"),
            str(REPO_ROOT / "third_party" / "fedramp-automation"),
        ],
    )
    gpt5 = McpStdioServerConfig(
        command="uv",
        args=["run", "servers/gpt5_pro/gpt5_pro_mcp_server.py"],
        env={
            "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", ""),
            "AEGIS_OPENAI_MODEL": os.environ.get("AEGIS_OPENAI_MODEL", "gpt-5-pro-2025-10-06"),
        },
    )
    return {"nist": nist, "fs": fs, "gpt5": gpt5}


def mcp_servers(stage: str | None = None) -> Dict[str, Any]:
    servers = _base_mcp_servers()
    if stage in {"analyzer", "tester"}:
        servers = dict(servers)
        servers["aegis"] = McpStdioServerConfig(
            command="uv",
            args=["run", "servers/aegis/aegis_mcp_server.py"],
        )
    return servers



def _stderr_logger(filename: str):
    log_path = REPO_ROOT / ".aegis" / "debug" / filename
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] <<stderr logger attached>>\n")
    except Exception:
        pass

    def _log(line: str) -> None:
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(f"[{timestamp}] {line}\n")
        except Exception:
            pass

    return _log


def unified_diff(a_text: str, b_text: str, path: str) -> str:
    a_lines = a_text.splitlines(keepends=True)
    b_lines = b_text.splitlines(keepends=True)
    return "".join(difflib.unified_diff(a_lines, b_lines, fromfile=f"a/{path}", tofile=f"b/{path}"))


def strip_code_fence(text: str) -> str:
    candidate = text.strip()
    if candidate.startswith("```"):
        parts = candidate.split("```")
        for part in parts:
            chunk = part.strip()
            if not chunk:
                continue
            if chunk.startswith("json"):
                chunk = chunk[4:].strip()
            if chunk.startswith("{") or chunk.startswith("["):
                return chunk
    return candidate


def _decode_json_response(raw: str) -> Any:
    raw = strip_code_fence(raw.strip())
    if not raw:
        raise ValueError("empty-response")

    try:
        return json.loads(raw)
    except Exception:
        pass

    import re

    match = re.search(r"```json\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```", raw, re.IGNORECASE)
    if match:
        snippet = match.group(1)
        try:
            return json.loads(snippet)
        except Exception:
            pass

    def _first_json_object(text: str) -> str | None:
        stack = []
        start = None
        for idx, ch in enumerate(text):
            if ch == '{':
                if start is None:
                    start = idx
                stack.append('{')
            elif ch == '}':
                if stack:
                    stack.pop()
                    if not stack and start is not None:
                        return text[start : idx + 1]
        return None

    candidate = _first_json_object(raw)
    if candidate:
        try:
            return json.loads(candidate)
        except Exception:
            pass

    raise ValueError("invalid-json")


async def ask_json(prompt: str, options: ClaudeAgentOptions) -> Any:
    max_attempts = 1 + int(os.environ.get("AEGIS_JSON_RETRY_COUNT", "3"))
    base_prompt = prompt
    last_raw = ""
    last_error = ""

    for attempt in range(1, max_attempts + 1):
        buffer: list[str] = []
        transcripts: list[str] = []
        try:
            async for message in query(prompt=prompt, options=options):
                transcripts.append(repr(message))
                content = getattr(message, "content", None)
                if isinstance(content, Iterable):
                    for block in content:
                        text = None
                        if isinstance(block, dict):
                            if block.get("type") == "text" and isinstance(block.get("text"), str):
                                text = block["text"]
                        else:
                            text_attr = getattr(block, "text", None)
                            if isinstance(text_attr, str):
                                text = text_attr
                        if text:
                            buffer.append(text)
        except Exception as exc:
            debug_dir = REPO_ROOT / ".aegis" / "debug"
            debug_dir.mkdir(exist_ok=True)
            timestamp = int(time.time())
            base_name = f"{timestamp}"
            debug_path = debug_dir / f"{base_name}_error.txt"
            try:
                lines = [
                    f"exception_type={type(exc).__name__}",
                    f"message={exc}",
                ]
                exit_code = getattr(exc, "exit_code", None)
                if exit_code is not None:
                    lines.append(f"exit_code={exit_code}")
                stderr_hint = getattr(exc, "stderr", None)
                if stderr_hint:
                    lines.append(f"stderr_hint={stderr_hint}")
                lines.append(f"options_extra_args={options.extra_args}")
                lines.append(f"buffered_characters={sum(len(x) for x in transcripts)}")
                debug_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                transcript_path = debug_dir / f"{base_name}_transcript.log"
                transcript_path.write_text(
                    "\n".join(transcripts) + "\n", encoding="utf-8"
                )
            except Exception:
                pass
            raise
        raw = "".join(buffer)
        last_raw = raw
        try:
            return _decode_json_response(raw)
        except ValueError as exc:
            last_error = exc.args[0] if exc.args else str(exc)
            if attempt >= max_attempts:
                break
            prompt = (
                base_prompt
                + "\n\nRETRY INSTRUCTION: Return STRICT JSON only (no prose, no backticks). "
                  "Re-emit the COMPLETE JSON object for ALL requested paths; do not omit any key."
            )

    debug_dir = REPO_ROOT / ".aegis" / "debug"
    debug_dir.mkdir(exist_ok=True)
    debug_path = debug_dir / f"{int(time.time())}_raw.json"
    try:
        debug_path.write_text(last_raw, encoding="utf-8")
    except Exception:
        pass
    trimmed = strip_code_fence(last_raw.strip())[:2000]
    raise RuntimeError(
        "Failed to parse JSON from model response after retries. "
        f"Last error='{last_error}'. Last response snippet: {trimmed}"
    )


def read_fs(path: str) -> str:
    full = REPO_ROOT / path
    try:
        return full.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def write_fs(path: str, content: str) -> None:
    full = REPO_ROOT / path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def _write_impl_mode_evidence(phase: str, payload: Dict[str, Any]) -> None:
    """Persist implementer execution mode details for observability."""
    try:
        timestamp = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
        path = EVIDENCE_DIR / f"{timestamp}_impl_mode_{phase}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"phase": phase, **payload}, indent=2), encoding="utf-8")
    except Exception:
        pass


def _estimate_tokens_for_text(text: str) -> int:
    """Estimate output tokens (~4 chars/token) to avoid exceeding model limits."""
    if not text:
        return 1
    return max(1, math.ceil(len(text) / 4))


def _estimate_output_budget(paths: List[str]) -> tuple[int, Dict[str, int]]:
    per_file: Dict[str, int] = {}
    total = 0
    for p in paths:
        est = _estimate_tokens_for_text(read_fs(p))
        per_file[p] = est
        total += est
    return total, per_file


@dataclass
class Plan:
    baseline: str = "moderate"
    controls: List[str] = field(default_factory=list)
    file_hints: List[str] = field(default_factory=list)
    allow_paths: List[str] = field(default_factory=lambda: ["services/**", "charts/**"])
    max_files: int = 8
    pr: Dict[str, Any] = field(default_factory=dict)
    expert_notes: str = ""
    issue_key: str = ""
    issue_type: str = ""
    summary: str = ""
    acceptance: List[str] = field(default_factory=list)
    component: List[str] = field(default_factory=list)
    paths: List[str] = field(default_factory=list)
    risk: str = "Medium"
    tests_required: bool = True
    docs_required: bool = True
    breaking_change: bool = False
    requires_migration: bool = False
    labels: List[str] = field(default_factory=list)
    max_loc_delta: int = 800
    remote_tests_required: bool = True
    remote_ci_workflow: str = ""
    remote_ci_inputs: Dict[str, Any] = field(default_factory=dict)
    remote_ci_branch_prefix: str = "aegis-ci"
    remote_ci_delete_branch_on_success: bool = True


def _list_of_strings(value: Any) -> List[str]:
    if isinstance(value, list):
        return [str(item) for item in value if isinstance(item, str)]
    return []


def load_plan(path: Path) -> Plan:
    data = json.loads(path.read_text(encoding="utf-8"))
    return Plan(
        baseline=str(data.get("baseline", "moderate")),
        controls=_list_of_strings(data.get("controls")),
        file_hints=_list_of_strings(data.get("file_hints")),
        allow_paths=_list_of_strings(data.get("allow_paths")) or ["services/**", "charts/**"],
        max_files=int(data.get("max_files", 8)),
        pr=data.get("pr", {}),
        expert_notes=data.get("expert_notes", ""),
        issue_key=str(data.get("issue_key", "")),
        issue_type=str(data.get("issue_type", "")),
        summary=str(data.get("summary", "")),
        acceptance=_list_of_strings(data.get("acceptance")),
        component=_list_of_strings(data.get("component")),
        paths=_list_of_strings(data.get("paths")),
        risk=str(data.get("risk", "Medium")),
        tests_required=bool(data.get("tests_required", True)),
        docs_required=bool(data.get("docs_required", True)),
        breaking_change=bool(data.get("breaking_change", False)),
        requires_migration=bool(data.get("requires_migration", False)),
        labels=_list_of_strings(data.get("labels")),
        max_loc_delta=int(data.get("max_loc_delta", 800)),
        remote_tests_required=bool(data.get("remote_tests_required", True)),
        remote_ci_workflow=str(data.get("remote_ci_workflow", "")),
        remote_ci_inputs=data.get("remote_ci_inputs", {}) or {},
        remote_ci_branch_prefix=str(data.get("remote_ci_branch_prefix", "aegis-ci")),
        remote_ci_delete_branch_on_success=bool(data.get("remote_ci_delete_branch_on_success", True)),
    )


def analyzer_options(plan: Mapping[str, Any]) -> ClaudeAgentOptions:
    is_compliance = bool(plan.get("controls"))
    if is_compliance:
        allowed = [
            "mcp__nist__get_control",
            "mcp__nist__in_fedramp_baseline",
            "mcp__fs__list_directory",
            "mcp__fs__read_file",
            "mcp__fs__read_text_file",
            "mcp__fs__read_multiple_files",
            "mcp__aegis__repo_glob",
        ]
        system_prompt = textwrap.dedent(
            """
            You are the Analyzer.
            Goal: plan concrete remediation for the requested NIST controls aligned to the specified baseline.
            Use MCP tools to read repository context and NIST OSCAL data.
            Return STRICT JSON: {"summary":"...","targets":[{"path":"<file>","reason":"..."}],"edits":[{"path":"<file>","instructions":"..."}]}
            Constraints: prefer file_hints; stay within allow_paths; do not exceed max_files.
            """
        ).strip()
    else:
        allowed = [
            "mcp__fs__list_directory",
            "mcp__fs__read_file",
            "mcp__fs__read_text_file",
            "mcp__fs__read_multiple_files",
            "mcp__aegis__repo_glob",
        ]
        system_prompt = textwrap.dedent(
            """
            You are the Analyzer for a Jira engineering task (not compliance).
            Inputs: issue summary, acceptance criteria, file_hints, allow_paths, max_files.
            Goal: propose the smallest, safest change that fully satisfies acceptance criteria.
            Strongly prefer files in file_hints; stay inside allow_paths; do not exceed max_files.
            Do NOT mention NIST or FedRAMP in this mode.
            Return STRICT JSON: {"summary":"...","targets":[{"path":"<file>","reason":"..."}],"edits":[{"path":"<file>","instructions":"..."}]}
            """
        ).strip()
    return ClaudeAgentOptions(
        system_prompt=system_prompt,
        mcp_servers=mcp_servers("analyzer"),
        allowed_tools=allowed,
        model=os.environ.get("AEGIS_CLAUDE_MODEL", "claude-sonnet-4-5"),
        env=_claude_env(),
        stderr=_stderr_logger("analyzer-stderr.log"),
        extra_args={"debug-to-stderr": None, "debug": None},
    )


def implementer_options(plan: Mapping[str, Any]) -> ClaudeAgentOptions:
    invocations_log = REPO_ROOT / ".aegis" / "debug" / "implementer-invocations.log"
    try:
        invocations_log.parent.mkdir(parents=True, exist_ok=True)
        with invocations_log.open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] invoked implementer_options\n")
    except Exception:
        pass

    allowed = ["mcp__fs__read_file", "mcp__fs__read_text_file", "mcp__fs__read_multiple_files"]
    is_compliance = bool(plan.get("controls"))
    if is_compliance:
        system_prompt = textwrap.dedent(
            """
            You are the Implementer (compliance).
            Rewrite FULL FILE CONTENTS per Analyzer plan.
            Output STRICT JSON only: {"<path>":"<entire file text>", ...}.
            Keep code buildable; do not relax TLS/FIPS requirements.
            """
        ).strip()
    else:
        system_prompt = textwrap.dedent(
            """
            You are the Implementer (Jira engineering).
            Rewrite FULL FILE CONTENTS per Analyzer plan to meet acceptance criteria with minimal safe changes.
            Output STRICT JSON only: {"<path>":"<entire file text>", ...}.
            Keep Go code buildable; stay within allow_paths; prefer file_hints.
            """
        ).strip()
    return ClaudeAgentOptions(
        system_prompt=system_prompt,
        mcp_servers=mcp_servers("implementer"),
        allowed_tools=allowed,
        model=os.environ.get("AEGIS_CLAUDE_MODEL", "claude-sonnet-4-5"),
        env=_claude_env(),
        stderr=_stderr_logger("implementer-stderr.log"),
        extra_args={
            "debug-to-stderr": None,
            "debug": None,
        },
    )


def reviewer_options(plan: Mapping[str, Any]) -> ClaudeAgentOptions:
    is_compliance = bool(plan.get("controls"))
    if is_compliance:
        prompt = 'You are the Reviewer (compliance). Return STRICT JSON only: {"pass":bool,"must_fix":[...],"comments":[...]}'
    else:
        prompt = (
            "You are the Reviewer (Jira engineering). Validate the diffs meet the acceptance criteria and avoid obvious "
            "regressions. Return STRICT JSON only: {\"pass\":true|false,\"must_fix\":[\"...\"],\"comments\":[\"...\"]}"
        )
    return ClaudeAgentOptions(
        system_prompt=prompt,
        mcp_servers=mcp_servers("reviewer"),
        allowed_tools=[],
        model=os.environ.get("AEGIS_CLAUDE_MODEL", "claude-sonnet-4-5"),
        env=_claude_env(),
        stderr=_stderr_logger("reviewer-stderr.log"),
        extra_args={"debug-to-stderr": None, "debug": None},
    )


def tester_options(plan: Mapping[str, Any]) -> ClaudeAgentOptions:
    allowed = ["mcp__aegis__go_build", "mcp__aegis__run_tests", "mcp__aegis__evidence_write_json"]
    return ClaudeAgentOptions(
        system_prompt=(
            "You are the Tester. First run go_build with target ./... (entire repo) then run_tests. "
            "Return JSON: {build_ok, test_ok, ok, summaries:[...], stdout?:str, stderr?:str}."
        ),
        mcp_servers=mcp_servers("tester"),
        allowed_tools=allowed,
        model=os.environ.get("AEGIS_CLAUDE_MODEL", "claude-sonnet-4-5"),
        env=_claude_env(),
    )


def failure_analyst_options(plan: Mapping[str, Any]) -> ClaudeAgentOptions:
    prompt = (
        "You are the Failure Analyst.\n"
        "Inputs: diffs and failing build/test output (+ targeted repo excerpts provided).\n"
        "Goal: produce the minimal, safe edits addressing the failure root cause.\n"
        "Return STRICT JSON only: {\"edits\":[{\"path\":\"<file>\",\"instructions\":\"<what to change and why>\"}, ...]}"
    )
    return ClaudeAgentOptions(
        system_prompt=prompt,
        mcp_servers=mcp_servers("reviewer"),
        allowed_tools=[
            "mcp__fs__list_directory",
            "mcp__fs__read_file",
            "mcp__fs__read_text_file",
            "mcp__fs__read_multiple_files",
            "mcp__aegis__repo_glob",
        ],
        model=os.environ.get("AEGIS_CLAUDE_MODEL", "claude-sonnet-4-5"),
        env=_claude_env(),
        stderr=_stderr_logger("failure-analyst-stderr.log"),
        extra_args={"debug-to-stderr": None, "debug": None},
    )


async def run_failure_analyst(plan: Plan, diffs: Dict[str, str], test_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    # First attempt deterministic heuristics; fall back to LLM if needed.
    if analyze_ci_failure is not None:
        deterministic = analyze_ci_failure(diffs, test_result)
        if deterministic:
            return deterministic

    stdout = str(test_result.get("stdout") or "")[:100000]
    stderr = str(test_result.get("stderr") or "")[:100000]
    payload = {
        "summary": plan.summary,
        "acceptance": plan.acceptance,
        "allow_paths": plan.allow_paths,
        "diffs": diffs,
        "test_result": {
            "stdout": stdout,
            "stderr": stderr,
            "summaries": test_result.get("summaries", []),
        },
    }
    prompt = "Given the following context, return STRICT JSON edits only:\n" + json.dumps(payload)[:200000]
    result = await ask_json(prompt, failure_analyst_options(plan.__dict__))
    edits = [e for e in result.get("edits", []) if isinstance(e, dict) and "path" in e]
    return edits


def _gh_headers() -> Dict[str, str]:
    token = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN", "")
    if not token:
        raise RuntimeError("GITHUB_PERSONAL_ACCESS_TOKEN required for remote CI")
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _gh_owner_repo() -> Tuple[str, str]:
    owner = os.environ.get("AEGIS_GITHUB_OWNER") or ""
    repo = os.environ.get("AEGIS_GITHUB_REPO") or ""
    if not owner or not repo:
        raise RuntimeError("AEGIS_GITHUB_OWNER and AEGIS_GITHUB_REPO are required")
    return owner, repo


def _http_json(method: str, url: str, headers: Dict[str, str], data: Dict[str, Any] | None = None, binary: bool = False):
    body = None
    request_headers = dict(headers)
    if data is not None and not binary:
        body = json.dumps(data).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url=url, data=body, headers=request_headers, method=method.upper())
    try:
        with urllib.request.urlopen(req) as resp:
            payload = resp.read()
            if binary:
                return payload
            if not payload:
                return {}
            return json.loads(payload.decode("utf-8"))
    except HTTPError as err:
        details = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API error: {err.code} {err.reason} – {details}") from err
    except URLError as err:
        raise RuntimeError(f"GitHub API request failed: {err}") from err


def _gh_api(method: str, path: str, data: Dict[str, Any] | None = None):
    owner, repo = _gh_owner_repo()
    url = f"https://api.github.com/repos/{owner}/{repo}/{path.lstrip('/')}"
    return _http_json(method, url, _gh_headers(), data)


def _gh_get_ref_sha(ref: str) -> str:
    obj = _gh_api("GET", f"git/ref/heads/{ref}")
    return obj["object"]["sha"]


def _gh_create_branch(branch: str, base_ref: str) -> str:
    base_sha = _gh_get_ref_sha(base_ref)
    _gh_api("POST", "git/refs", {"ref": f"refs/heads/{branch}", "sha": base_sha})
    return base_sha


def _gh_tree_from_files(files: Mapping[str, str]) -> List[Dict[str, Any]]:
    tree: List[Dict[str, Any]] = []
    for path, content in files.items():
        tree.append({"path": path, "mode": "100644", "type": "blob", "content": content})
    return tree


def _gh_commit_to_branch(branch: str, message: str, files: Mapping[str, str]) -> str:
    ref = _gh_api("GET", f"git/ref/heads/{branch}")
    parent_sha = ref["object"]["sha"]
    tree = _gh_api("POST", "git/trees", {"base_tree": parent_sha, "tree": _gh_tree_from_files(files)})
    commit = _gh_api("POST", "git/commits", {"message": message, "tree": tree["sha"], "parents": [parent_sha]})
    _gh_api("PATCH", f"git/refs/heads/{branch}", {"sha": commit["sha"], "force": True})
    return commit["sha"]


def _gh_create_branch_with_files(branch: str, base_ref: str, message: str, files: Mapping[str, str]) -> Tuple[str, str]:
    base_sha = _gh_create_branch(branch, base_ref)
    tree = _gh_api("POST", "git/trees", {"base_tree": base_sha, "tree": _gh_tree_from_files(files)})
    commit = _gh_api("POST", "git/commits", {"message": message, "tree": tree["sha"], "parents": [base_sha]})
    _gh_api("PATCH", f"git/refs/heads/{branch}", {"sha": commit["sha"], "force": True})
    return commit["sha"], base_sha


def _gh_delete_branch(branch: str) -> None:
    try:
        _gh_api("DELETE", f"git/refs/heads/{branch}")
    except Exception:
        pass


def _gh_workflow_runs(workflow: str, branch: str) -> Dict[str, Any]:
    path = f"actions/workflows/{workflow}/runs?branch={urllib.parse.quote(branch)}&event=workflow_dispatch&per_page=1"
    return _gh_api("GET", path)


def _gh_dispatch_workflow(workflow: str, ref: str, inputs: Dict[str, Any] | None = None) -> None:
    _gh_api("POST", f"actions/workflows/{workflow}/dispatches", {"ref": ref, "inputs": inputs or {}})


def _gh_get_run(run_id: int) -> Dict[str, Any]:
    return _gh_api("GET", f"actions/runs/{run_id}")


def _gh_wait_for_run(run_id: int, poll_seconds: int = 10, timeout_seconds: int = 3600) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        run = _gh_get_run(run_id)
        if run.get("status") == "completed":
            return run
        time.sleep(max(2, poll_seconds))
    raise TimeoutError(f"Workflow run {run_id} did not complete in time")


def _gh_download_logs(run_id: int, dest_zip: Path) -> Path:
    owner, repo = _gh_owner_repo()
    url = f"https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/logs"
    payload = _http_json("GET", url, _gh_headers(), None, binary=True)
    dest_zip.write_bytes(payload)
    return dest_zip


def _open_pr_from_branch(branch: str, base: str, title: str, body: str) -> str:
    pr = _gh_api("POST", "pulls", {"title": title, "head": branch, "base": base, "body": body, "draft": False})
    return pr["html_url"]


def compute_diffs(originals: Mapping[str, str], proposed: Mapping[str, str]) -> Tuple[bool, Dict[str, str]]:
    changed = False
    diffs: Dict[str, str] = {}
    for path, new_content in proposed.items():
        old_content = originals.get(path, "")
        if old_content != new_content:
            changed = True
        diffs[path] = unified_diff(old_content, new_content, path)
    return changed, diffs


def _sum_loc_from_unified(diffs: Mapping[str, str]) -> int:
    total = 0
    for diff in diffs.values():
        for line in diff.splitlines():
            if line.startswith("+++") or line.startswith("---"):
                continue
            if line.startswith("+") or line.startswith("-"):
                total += 1
    return total


def _matches_allowlist(allow_paths: List[str], path: str) -> bool:
    if not allow_paths:
        return True
    path_obj = Path(path)
    for pattern in allow_paths:
        if path_obj.match(pattern):
            return True
        try:
            # Basic prefix support for patterns ending with /**
            normalized = pattern.rstrip("*")
            if normalized and path.startswith(normalized):
                return True
        except Exception:
            continue
    return False


async def run_analyzer(plan: Plan) -> Tuple[str, List[str], List[Dict[str, Any]]]:
    is_compliance = bool(plan.controls)
    if is_compliance:
        prompt = textwrap.dedent(
            f"""
            Controls: {plan.controls}
            Baseline: FedRAMP {plan.baseline.title()}
            Hints (optional): {plan.file_hints}
            Allow paths (guardrail): {plan.allow_paths}
            Max files: {plan.max_files}
            Expert notes: {plan.expert_notes}
            Propose targets and concrete edit instructions.
            """
        ).strip()
    else:
        prompt = textwrap.dedent(
            f"""
            Jira issue: {plan.issue_key}
            Summary: {plan.summary}
            Acceptance: {plan.acceptance}
            File hints: {plan.file_hints}
            Allow paths (guardrail): {plan.allow_paths}
            Max files: {plan.max_files}
            Propose the smallest, safest changes to satisfy acceptance criteria.
            """
        ).strip()

    analysis = await ask_json(prompt, analyzer_options(plan.__dict__))
    summary = analysis.get("summary", "")
    targets = [t for t in analysis.get("targets", []) if isinstance(t, dict) and "path" in t]
    edits = [e for e in analysis.get("edits", []) if isinstance(e, dict)]

    filtered = []
    for entry in targets:
        path = entry["path"]
        if _matches_allowlist(plan.allow_paths, path):
            filtered.append(path)
    target_paths = filtered[: plan.max_files]
    if not target_paths:
        if not is_compliance:
            hints = [p for p in plan.file_hints if _matches_allowlist(plan.allow_paths, p)]
            target_paths = hints[: plan.max_files]
        if not target_paths:
            raise RuntimeError("Analyzer produced no target files within guardrails and no usable file_hints")

    timestamp = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
    analysis_path = EVIDENCE_DIR / f"{timestamp}_analysis.json"
    analysis_payload = {
        "controls": plan.controls,
        "baseline": plan.baseline,
        "summary": summary,
        "targets": target_paths,
        "edits": edits,
    }
    analysis_path.parent.mkdir(parents=True, exist_ok=True)
    analysis_path.write_text(json.dumps(analysis_payload, indent=2), encoding="utf-8")

    return str(analysis_path.relative_to(REPO_ROOT)), target_paths, edits


async def run_implementer(plan: Plan, summary: str, targets: List[str], edits: List[Dict[str, Any]]) -> Tuple[Dict[str, str], Dict[str, str], str]:
    originals = {path: read_fs(path) for path in targets}
    prompt = textwrap.dedent(
        f"""
        Plan summary: {summary}
        Edits to apply: {json.dumps(edits, indent=2)}
        Target files: {targets}

        Return STRICT JSON mapping each path to its COMPLETE NEW CONTENT.
        Do not add commentary or extra keys.
        If a target needs no change, still return it with strengthened policy hooks so that a delta exists.
        """
    ).strip()

    files_map = await ask_json(prompt, implementer_options(plan.__dict__))
    if not isinstance(files_map, dict):
        raise RuntimeError("Implementer did not return a JSON object")

    proposed = {k: str(v) for k, v in files_map.items() if k in targets}
    if not proposed:
        raise RuntimeError("Implementer returned no recognized targets")

    sanitized: Dict[str, str] = {}
    for path, content in proposed.items():
        sanitized[path] = content
    proposed = sanitized
    changed, diffs = compute_diffs(originals, proposed)
    if not changed:
        retry_prompt = prompt + "\n\nIMPORTANT: Your previous output produced no diffs. Introduce the minimal safe policy enhancement to create a concrete delta."
        files_map = await ask_json(retry_prompt, implementer_options(plan.__dict__))
        proposed = {k: str(v) for k, v in files_map.items() if k in targets}
        if not proposed:
            raise RuntimeError("Implementer retry returned no recognized targets")
        sanitized_retry: Dict[str, str] = {}
        for path, content in proposed.items():
            sanitized_retry[path] = content
        proposed = sanitized_retry
        changed, diffs = compute_diffs(originals, proposed)
        if not changed:
            raise RuntimeError("No diffs after retry; aborting to avoid an empty PR.")

    timestamp = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
    diff_path = EVIDENCE_DIR / f"{timestamp}_diff_summary.json"
    diff_payload = {"targets": targets, "diffs": diffs}
    diff_path.write_text(json.dumps(diff_payload, indent=2), encoding="utf-8")

    return proposed, diffs, str(diff_path.relative_to(REPO_ROOT))


async def run_implementer_chunked(
    plan: Plan,
    summary: str,
    targets: List[str],
    edits: List[Dict[str, Any]],
    *,
    chunk_cfg: Dict[str, Any] | None = None,
) -> Tuple[Dict[str, str], Dict[str, str], str]:
    """Run Implementer per file to keep responses under output-token limits."""
    proposed: Dict[str, str] = {}
    diffs: Dict[str, str] = {}
    cfg = dict(chunk_cfg or {})
    max_chunk_tokens = int(cfg.get("max_chunk_tokens", 0)) or None
    sorted_targets = sorted(targets, key=lambda p: len(read_fs(p)), reverse=True)

    for path in sorted_targets:
        original = read_fs(path)
        if max_chunk_tokens is not None and _estimate_tokens_for_text(original) > max_chunk_tokens:
            raise RuntimeError(
                f"Target {path} exceeds chunk token budget ({max_chunk_tokens}); "
                "reduce chunk size or split edits."
            )
        originals = {path: original}
        file_edits = [e for e in edits if isinstance(e, dict) and e.get("path") == path]
        prompt = textwrap.dedent(
            f"""
            Plan summary: {summary}
            Target file: {path}
            Edits to apply (THIS FILE ONLY): {json.dumps(file_edits, indent=2)}

            Return STRICT JSON ONLY in the exact shape:
            {{"{path}":"<entire new file content>"}}
            """
        ).strip()
        files_map = await ask_json(prompt, implementer_options(plan.__dict__))
        if not isinstance(files_map, dict) or path not in files_map:
            raise RuntimeError(f"Implementer (per-file) did not return content for {path}")
        new_content = str(files_map[path])
        proposed[path] = new_content
        changed, file_diff = compute_diffs(originals, {path: new_content})
        if not changed:
            retry_prompt = (
                prompt
                + "\n\nIMPORTANT: Your previous output produced no diffs. "
                  "Introduce the minimal safe policy enhancement to create a concrete delta."
            )
            files_map = await ask_json(retry_prompt, implementer_options(plan.__dict__))
            new_content = str(files_map[path])
            proposed[path] = new_content
            changed, file_diff = compute_diffs(originals, {path: new_content})
            if not changed:
                raise RuntimeError(f"No diffs produced for {path} after retry; aborting.")
        diffs[path] = file_diff[path]

    timestamp = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
    diff_path = EVIDENCE_DIR / f"{timestamp}_diff_summary.json"
    diff_payload = {"targets": targets, "diffs": diffs}
    diff_path.write_text(json.dumps(diff_payload, indent=2), encoding="utf-8")
    return proposed, diffs, str(diff_path.relative_to(REPO_ROOT))


async def run_implementer_auto(
    plan: Plan,
    summary: str,
    targets: List[str],
    edits: List[Dict[str, Any]],
    *,
    chunk_cfg: Dict[str, Any] | None = None,
) -> Tuple[Dict[str, str], Dict[str, str], str]:
    """Dispatch to chunked or monolithic implementer based on plan state/env."""
    mode = getattr(plan, "impl_mode", None)
    if not mode:
        mode = os.environ.get("AEGIS_IMPL_MODE", "").strip().lower() or "chunked"
        plan.impl_mode = mode  # type: ignore[attr-defined]
    cfg = chunk_cfg if chunk_cfg is not None else getattr(plan, "chunk_cfg", None)
    if mode == "chunked":
        return await run_implementer_chunked(plan, summary, targets, edits, chunk_cfg=cfg)
    return await run_implementer(plan, summary, targets, edits)


async def run_reviewer(plan: Plan, diffs: Dict[str, str]) -> Dict[str, Any]:
    is_compliance = bool(plan.controls)
    if is_compliance:
        prompt = textwrap.dedent(
            f"""
            Validate the diffs implement the intended control outcomes for {plan.controls} (FedRAMP {plan.baseline}).
            Confirm there are no regressions (mTLS, TLS >= 1.2, FIPS guardrails, etc.) and that new env variables / policies are wired correctly.

            Return STRICT JSON: {{"pass": true|false, "must_fix": [strings], "comments": [strings]}}

            Diffs:
            {json.dumps(diffs, indent=2)[:200000]}
            """
        ).strip()
    else:
        prompt = textwrap.dedent(
            f"""
            You are the Reviewer (Jira engineering). Evaluate only against Jira acceptance criteria and scope guardrails.
            - Do not apply FedRAMP/NIST criteria in this mode.
            - Verify the change is the minimal safe edit that satisfies acceptance.
            - Ensure touched paths stay within allow_paths and prefer file_hints.
            - Flag obvious compile-time errors or regressions in the touched files.

            Context:
            - Issue: {plan.issue_key}
            - Summary: {plan.summary}
            - Acceptance: {json.dumps(plan.acceptance, indent=2) if plan.acceptance else "[]"}
            - allow_paths: {plan.allow_paths}
            - file_hints: {plan.file_hints}
            - max_files: {plan.max_files}

            Return STRICT JSON only:
            {{"pass": true|false, "must_fix": [strings], "comments": [strings]}}

            Diffs:
            {json.dumps(diffs, indent=2)[:200000]}
            """
        ).strip()

    review = await ask_json(prompt, reviewer_options(plan.__dict__))
    if review.get("pass", False):
        return review

    must_fix = review.get("must_fix", [])
    if must_fix:
        fix_prompt = prompt + "\n\nReviewer must-fix notes:\n" + "\n".join(f"- {note}" for note in must_fix)
        review = await ask_json(fix_prompt, reviewer_options(plan.__dict__))
    return review


async def ensure_review_signoff(
    plan: Plan,
    summary: str,
    target_paths: List[str],
    base_edits: List[Dict[str, Any]],
    proposed: Dict[str, str],
    diffs: Dict[str, str],
    diff_paths: List[str],
) -> Tuple[Dict[str, str], Dict[str, str], List[str], Dict[str, Any]]:
    review = await run_reviewer(plan, diffs)

    if not review.get("pass", False) and not plan.controls:
        must_fix = [
            str(item).strip()
            for item in review.get("must_fix", [])
            if isinstance(item, str) and item.strip()
        ]
        if must_fix:
            remediation_suffix = (
                "\n\nAddress the following reviewer findings before returning final content:\n- "
                + "\n- ".join(must_fix)
            )
            remediation_edits: List[Dict[str, Any]] = []
            for entry in base_edits:
                updated = dict(entry)
                instructions = str(updated.get("instructions", ""))
                updated["instructions"] = (
                    f"{instructions}{remediation_suffix}" if instructions else remediation_suffix.lstrip()
                )
                remediation_edits.append(updated)
            if not remediation_edits and target_paths:
                remediation_edits.append({"path": target_paths[0], "instructions": remediation_suffix.lstrip()})
            if remediation_edits:
                # Preserve implementer mode across remediation; default to chunked.
                plan.impl_mode = getattr(plan, "impl_mode", "chunked")  # type: ignore[attr-defined]
                chunk_cfg = getattr(plan, "chunk_cfg", None)
                try:
                    proposed, diffs, diff_path = await run_implementer_auto(
                        plan,
                        summary,
                        target_paths,
                        remediation_edits,
                        chunk_cfg=chunk_cfg,
                    )
                except Exception as exc:
                    msg = str(exc).lower()
                    if "token" in msg or "32000" in msg or "exceeded the" in msg:
                        plan.impl_mode = "chunked"  # type: ignore[attr-defined]
                        limit = int(os.environ.get("AEGIS_IMPL_MAX_OUTPUT_TOKENS", "32000"))
                        cfg = dict(chunk_cfg or {})
                        cfg["max_chunk_tokens"] = int(cfg.get("max_chunk_tokens", int(limit * 0.75)) * 0.8)
                        cfg["limit"] = limit
                        plan.chunk_cfg = cfg  # type: ignore[attr-defined]
                        proposed, diffs, diff_path = await run_implementer_auto(
                            plan,
                            summary,
                            target_paths,
                            remediation_edits,
                            chunk_cfg=cfg,
                        )
                    else:
                        raise
                _write_impl_mode_evidence(
                    phase="remediation",
                    payload={
                        "mode": getattr(plan, "impl_mode", "unknown"),
                        "targets": target_paths,
                        "chunk_cfg": getattr(plan, "chunk_cfg", None),
                    },
                )
                diff_paths.append(diff_path)
                review = await run_reviewer(plan, diffs)

    if not review.get("pass", False):
        if os.environ.get("AEGIS_PR_ON_REVIEW_FAIL", "").lower() == "true":
            os.environ.setdefault("AEGIS_WIP_PREFIX", "WIP: ")
        else:
            raise RuntimeError(f"Reviewer failed with issues: {review}")

    return proposed, diffs, diff_paths, review


async def run_tester(plan: Plan) -> Tuple[Dict[str, Any], str]:
    """
    Execute the local Node.js harness for this repository. The harness already
    exercises unit, integration, and local Electron E2E tests for the VS Code
    extension and proxy.
    """

    cfg = _load_repo_config()
    local_ci = cfg.get("local_ci") or {}
    steps = local_ci.get("steps") or ["npm ci", "node scripts/test/run-all.js"]
    env_overrides = local_ci.get("env") or {}

    env = os.environ.copy()
    env.update({k: str(v) for k, v in env_overrides.items()})
    # Ensure we use the Node version configured via nvm (often required for consistent coverage).
    nvm_bin = env.get("NVM_BIN")
    if nvm_bin:
        path_entries = env.get("PATH", "")
        if not path_entries.startswith(nvm_bin):
            env["PATH"] = f"{nvm_bin}:{path_entries}"

    timestamp = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
    run_dir = EVIDENCE_DIR / timestamp
    run_dir.mkdir(parents=True, exist_ok=True)
    log_path = run_dir / "local-ci.log"

    result: Dict[str, Any] = {
        "ok": False,
        "build_ok": True,
        "test_ok": False,
        "summaries": [],
        "stdout": "",
        "stderr": "",
        "details": {
            "tests": {
                "steps": steps,
                "log_file": "",
            }
        },
    }

    def _run_steps() -> int:
        with log_path.open("w", encoding="utf-8") as log_handle:
            for cmd in steps:
                log_handle.write(f"$ {cmd}\n")
                log_handle.flush()
                proc = subprocess.Popen(
                    shlex.split(cmd),
                    cwd=str(REPO_ROOT),
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                streamed: List[str] = []
                assert proc.stdout is not None
                for line in proc.stdout:
                    streamed.append(line)
                    log_handle.write(line)
                rc = proc.wait()
                result["stdout"] += "".join(streamed)
                if rc != 0:
                    result["summaries"].append(f"Command `{cmd}` failed with exit code {rc}")
                    return rc
            result["summaries"].append("npm harness completed successfully.")
            return 0

    loop = asyncio.get_running_loop()
    rc = await loop.run_in_executor(None, _run_steps)

    junit_patterns = local_ci.get("junit_globs") or []
    coverage_patterns = local_ci.get("coverage_globs") or []

    def _collect(patterns: List[str], bucket: str) -> None:
        collected: List[str] = []
        for pattern in patterns:
            for match in glob.glob(str(REPO_ROOT / pattern), recursive=True):
                src = Path(match)
                if src.is_file():
                    dest = run_dir / src.name
                    try:
                        shutil.copy2(src, dest)
                        collected.append(str(dest.relative_to(REPO_ROOT)))
                    except Exception:
                        pass
        if collected:
            result.setdefault("artifacts", {})[bucket] = collected

    _collect(junit_patterns, "junit")
    _collect(coverage_patterns, "coverage")

    if rc == 0:
        result["ok"] = True
        result["test_ok"] = True
    else:
        result["ok"] = False
        result["test_ok"] = False

    rel_log = str(log_path.relative_to(REPO_ROOT))
    result["log"] = rel_log
    result["details"]["tests"]["log_file"] = rel_log
    result.setdefault("artifacts", {}).setdefault("logs", []).append(rel_log)
    result_path = run_dir / "local-ci-result.json"
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    return result, str(result_path.relative_to(REPO_ROOT))


def gpt5_advisor_options(plan: Mapping[str, Any]) -> ClaudeAgentOptions:
    system_prompt = (
        "You are the Escalation Orchestrator. "
        "Call the tool mcp__gpt5__advise with the provided payload and return its STRICT JSON."
    )
    return ClaudeAgentOptions(
        system_prompt=system_prompt,
        mcp_servers=mcp_servers("tester"),
        allowed_tools=["mcp__gpt5__advise"],
        model=os.environ.get("AEGIS_CLAUDE_MODEL", "claude-sonnet-4-5"),
        env=_claude_env(),
        stderr=_stderr_logger("advisor-stderr.log"),
        extra_args={"debug-to-stderr": None, "debug": None},
    )


async def consult_gpt5(plan: Plan, diffs: Dict[str, str], test_result: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], str]:
    payload = {
        "summary": plan.summary,
        "acceptance": plan.acceptance,
        "allow_paths": plan.allow_paths,
        "max_files": plan.max_files,
        "diffs": diffs,
        "test_result": test_result,
    }
    prompt = (
        "Invoke mcp__gpt5__advise with this JSON payload and return its STRICT JSON only:\n"
        + json.dumps(payload)
    )
    advice = await ask_json(prompt, gpt5_advisor_options(plan.__dict__))

    timestamp = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
    advice_path = EVIDENCE_DIR / f"{timestamp}_gpt5_advice.json"
    advice_path.write_text(json.dumps(advice, indent=2), encoding="utf-8")

    edits = [entry for entry in advice.get("edits", []) if isinstance(entry, dict) and "path" in entry]
    return edits, str(advice_path.relative_to(REPO_ROOT))


async def open_pr(
    plan: Plan,
    summary: str,
    targets: List[str],
    evidence_paths: List[str],
    proposed: Dict[str, str] | None = None,
    include_evidence_files: bool = True,
) -> str:
    from agents.strands.tools.composite_github import open_pr_from_paths

    files_for_pr: Dict[str, str] = {}
    for path in targets:
        if proposed and path in proposed:
            files_for_pr[path] = proposed[path]
        else:
            files_for_pr[path] = read_fs(path)
    if include_evidence_files:
        for evidence in evidence_paths:
            files_for_pr[evidence] = read_fs(evidence)

    default_prefix = "jira" if plan.issue_key else "fedramp-moderate"
    branch_prefix = plan.pr.get("branch_prefix") or f"{default_prefix}-{plan.issue_key.lower()}".strip("-")
    branch = f"{branch_prefix}-{int(time.time())}"
    title = plan.pr.get(
        "title",
        f"FedRAMP {plan.baseline.title()}: implement {', '.join(plan.controls)}",
    )
    wip_prefix = os.environ.get("AEGIS_WIP_PREFIX")
    if wip_prefix and not title.startswith(wip_prefix):
        title = f"{wip_prefix}{title}"
    base = os.environ.get("AEGIS_GITHUB_BASE") or plan.pr.get("base", "main")

    acceptance_items = plan.acceptance or ["Acceptance criteria to be confirmed"]
    acceptance_section = "\n".join(f"- [ ] {item}" for item in acceptance_items)

    affected_paths = plan.paths or plan.file_hints or plan.allow_paths
    paths_section = "\n".join(f"- {path}" for path in affected_paths)

    if include_evidence_files:
        evidence_section = "\n".join(f"- {path}" for path in evidence_paths) or "- Evidence pending"
    else:
        evidence_section = "(omitted in Jira engineering mode)"

    summary_text = plan.summary or summary or "Implementation summary pending."
    if summary and summary != plan.summary:
        summary_text = f"{summary_text}\n\nImplementation notes:\n{summary}"

    risk_line = plan.risk or "Medium"
    tests_line = "Yes" if plan.tests_required else "No"
    docs_line = "Yes" if plan.docs_required else "No"

    body = textwrap.dedent(
        f"""
        ## Summary
        {summary_text}

        ## Acceptance Criteria
        {acceptance_section or '- [ ] Acceptance criteria to be confirmed'}

        ## Affected Paths
        {paths_section or '- (guardrail only)'}

        ## Risk & Gates
        - Risk: {risk_line}
        - Tests required: {tests_line}
        - Docs required: {docs_line}

        ## Evidence
        {evidence_section}
        """
    ).strip()

    pr_url = open_pr_from_paths(
        branch=branch,
        title=title,
        body=body,
        files=files_for_pr,
        owner=os.environ.get("AEGIS_GITHUB_OWNER"),
        repo=os.environ.get("AEGIS_GITHUB_REPO"),
        base=base,
    )
    return pr_url


async def run_end_to_end_async(plan: Plan) -> Tuple[str, List[str], Dict[str, Any]]:
    analysis_path, target_paths, edits = await run_analyzer(plan)
    summary_path = REPO_ROOT / analysis_path
    summary_data = json.loads(summary_path.read_text(encoding="utf-8"))
    summary = summary_data.get("summary", "")

    limit = int(os.environ.get("AEGIS_IMPL_MAX_OUTPUT_TOKENS", "32000"))
    threshold_env = os.environ.get("AEGIS_IMPL_CHUNK_THRESHOLD")
    threshold = (
        int(threshold_env)
        if threshold_env and threshold_env.isdigit()
        else int(limit * 0.75)
    )
    force_split = os.environ.get("AEGIS_IMPL_SPLIT_ALWAYS", "").lower() == "true"
    total_budget, per_file_budget = _estimate_output_budget(target_paths)

    if force_split or total_budget > threshold:
        plan.impl_mode = "chunked"  # type: ignore[attr-defined]
        plan.chunk_cfg = {"max_chunk_tokens": threshold, "limit": limit}  # type: ignore[attr-defined]
    else:
        plan.impl_mode = "monolithic"  # type: ignore[attr-defined]
        plan.chunk_cfg = None  # type: ignore[attr-defined]

    try:
        proposed, diffs, diff_path = await run_implementer_auto(
            plan,
            summary,
            target_paths,
            edits,
            chunk_cfg=getattr(plan, "chunk_cfg", None),
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "token" in msg or "32000" in msg or "exceeded the" in msg:
            plan.impl_mode = "chunked"  # type: ignore[attr-defined]
            cfg = dict(getattr(plan, "chunk_cfg", {}) or {})
            cfg["max_chunk_tokens"] = int(cfg.get("max_chunk_tokens", threshold) * 0.8)
            cfg["limit"] = limit
            plan.chunk_cfg = cfg  # type: ignore[attr-defined]
            proposed, diffs, diff_path = await run_implementer_auto(
                plan,
                summary,
                target_paths,
                edits,
                chunk_cfg=cfg,
            )
        else:
            raise

    _write_impl_mode_evidence(
        phase="initial",
        payload={
            "mode": getattr(plan, "impl_mode", "unknown"),
            "limit": limit,
            "threshold": threshold,
            "total_budget_estimate": total_budget,
            "per_file_budget_estimate": per_file_budget,
            "targets": target_paths,
        },
    )
    diff_paths = [diff_path]
    proposed, diffs, diff_paths, review = await ensure_review_signoff(
        plan, summary, target_paths, edits, proposed, diffs, diff_paths
    )

    # -------- Local test loop --------
    max_attempts = int(os.environ.get("AEGIS_LOCAL_MAX_ATTEMPTS", os.environ.get("AEGIS_MAX_TEST_ATTEMPTS", "3")))
    escalate_after = int(os.environ.get("AEGIS_LOCAL_ESCALATE_AFTER", os.environ.get("AEGIS_ESCALATE_AFTER", "2")))
    attempts = 0
    ci_paths: List[str] = []
    advice_paths: List[str] = []
    last_test: Dict[str, Any] = {}
    current_edits = list(edits or [])
    pr_ready = False

    while attempts < max_attempts:
        attempts += 1

        originals_on_disk: Dict[str, Tuple[bool, str]] = {}
        for path, content in proposed.items():
            full = REPO_ROOT / path
            existed = full.exists()
            originals_on_disk[path] = (existed, read_fs(path) if existed else "")
            write_fs(path, content)

        try:
            test_result, ci_path = await run_tester(plan)
            last_test = test_result
            if ci_path:
                ci_paths.append(ci_path)
        finally:
            for path, (existed, original_content) in originals_on_disk.items():
                full = REPO_ROOT / path
                if existed:
                    write_fs(path, original_content)
                else:
                    try:
                        full.unlink()
                    except FileNotFoundError:
                        pass

        if last_test.get("ok", False) and last_test.get("test_ok", last_test.get("ok", False)):
            pr_ready = True
            break

        # Try Failure Analyst first
        failure_edits = await run_failure_analyst(plan, diffs, last_test)
        if failure_edits:
            current_edits = (current_edits or []) + failure_edits
            proposed, diffs, diff_path = await run_implementer_auto(
                plan,
                summary,
                target_paths,
                current_edits,
                chunk_cfg=getattr(plan, "chunk_cfg", None),
            )
            diff_paths.append(diff_path)
            proposed, diffs, diff_paths, review = await ensure_review_signoff(
                plan, summary, target_paths, current_edits, proposed, diffs, diff_paths
            )
            continue

        if attempts >= escalate_after:
            gpt_edits, advice_path = await consult_gpt5(plan, diffs, last_test)
            advice_paths.append(advice_path)
            if gpt_edits:
                current_edits = (current_edits or []) + gpt_edits
                proposed, diffs, diff_path = await run_implementer_auto(
                    plan,
                    summary,
                    target_paths,
                    current_edits,
                    chunk_cfg=getattr(plan, "chunk_cfg", None),
                )
                diff_paths.append(diff_path)
                proposed, diffs, diff_paths, review = await ensure_review_signoff(
                    plan, summary, target_paths, current_edits, proposed, diffs, diff_paths
                )
            else:
                break

    if not pr_ready:
        raise RuntimeError(
            f"Local tests failed after {attempts} attempts (max {max_attempts}). Last result: {json.dumps(last_test)[:500]}"
        )

    evidence_paths = [analysis_path, *diff_paths, *ci_paths, *advice_paths]
    diff_payload: Dict[str, Any] = {"targets": target_paths, "diffs": diffs, "loc_delta": _sum_loc_from_unified(diffs)}

    remote_enabled = bool(
        plan.remote_tests_required and os.environ.get("AEGIS_REMOTE_CI_ENABLE", "true").lower() == "true"
    )
    if not remote_enabled:
        pr_url = ""
        if pr_ready and not (plan.max_loc_delta and diff_payload["loc_delta"] > plan.max_loc_delta):
            pr_url = await open_pr(
                plan,
                summary,
                target_paths,
                evidence_paths,
                proposed,
                include_evidence_files=bool(plan.controls),
            )
        return pr_url, evidence_paths, diff_payload

    # -------- Remote CI loop --------
    base = os.environ.get("AEGIS_GITHUB_BASE") or plan.pr.get("base", "main")
    workflow = plan.remote_ci_workflow or os.environ.get("AEGIS_REMOTE_CI_WORKFLOW", "preview-deployment.yml")
    ci_branch = f"{plan.remote_ci_branch_prefix}-{(plan.issue_key or 'task').lower()}-{int(time.time())}"
    commit_message = f"[aegis-ci] {(plan.issue_key or 'task')} pre-PR remote CI"

    remote_ci_paths: List[str] = []
    remote_advice_paths: List[str] = []
    branch_created = False
    try:
        _gh_create_branch_with_files(ci_branch, base, commit_message, proposed)
        branch_created = True

        remote_attempts = 0
        remote_max = int(os.environ.get("AEGIS_REMOTE_MAX_ATTEMPTS", "2"))
        remote_escalate = int(os.environ.get("AEGIS_REMOTE_ESCALATE_AFTER", "1"))
        last_remote: Dict[str, Any] = {}

        while remote_attempts < remote_max:
            remote_attempts += 1
            _gh_dispatch_workflow(workflow, ci_branch, plan.remote_ci_inputs)
            runs = _gh_workflow_runs(workflow, ci_branch)
            workflow_runs = runs.get("workflow_runs") or []
            if not workflow_runs:
                raise RuntimeError(f"No workflow runs found for workflow {workflow} on branch {ci_branch}")
            run_id = workflow_runs[0]["id"]
            run = _gh_wait_for_run(
                run_id,
                poll_seconds=10,
                timeout_seconds=int(os.environ.get("AEGIS_REMOTE_CI_TIMEOUT_SECONDS", "5400")),
            )

            conclusion = str(run.get("conclusion", "")).lower()
            last_remote = {
                "ok": conclusion == "success",
                "build_ok": None,
                "test_ok": conclusion == "success",
                "summaries": [f"run_id={run_id}", f"status={run.get('status')}", f"conclusion={run.get('conclusion')}"],
                "stdout": "",
                "stderr": "",
                "details": {"run": run},
            }

            timestamp = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
            logs_zip = EVIDENCE_DIR / f"{timestamp}_remote_ci_logs.zip"
            _gh_download_logs(run_id, logs_zip)
            remote_json = EVIDENCE_DIR / f"{timestamp}_remote_ci_results.json"
            remote_json.write_text(json.dumps(last_remote, indent=2), encoding="utf-8")
            remote_ci_paths.extend([str(logs_zip.relative_to(REPO_ROOT)), str(remote_json.relative_to(REPO_ROOT))])

            if last_remote["ok"]:
                break

            failure_edits = await run_failure_analyst(plan, diffs, last_remote)
            if failure_edits:
                current_edits = (current_edits or []) + failure_edits
                proposed, diffs, diff_path = await run_implementer_auto(
                    plan,
                    summary,
                    target_paths,
                    current_edits,
                    chunk_cfg=getattr(plan, "chunk_cfg", None),
                )
                diff_paths.append(diff_path)
                proposed, diffs, diff_paths, review = await ensure_review_signoff(
                    plan, summary, target_paths, current_edits, proposed, diffs, diff_paths
                )
                _gh_commit_to_branch(ci_branch, "[aegis-ci] apply failure analyst edits", proposed)
                continue

            if remote_attempts >= remote_escalate:
                gpt_edits, advice_path = await consult_gpt5(plan, diffs, last_remote)
                remote_advice_paths.append(advice_path)
                if gpt_edits:
                    current_edits = (current_edits or []) + gpt_edits
                    proposed, diffs, diff_path = await run_implementer_auto(
                        plan,
                        summary,
                        target_paths,
                        current_edits,
                        chunk_cfg=getattr(plan, "chunk_cfg", None),
                    )
                    diff_paths.append(diff_path)
                    proposed, diffs, diff_paths, review = await ensure_review_signoff(
                        plan, summary, target_paths, current_edits, proposed, diffs, diff_paths
                    )
                    _gh_commit_to_branch(ci_branch, "[aegis-ci] apply gpt5 advice", proposed)
                    continue
                break

        if not last_remote.get("ok"):
            raise RuntimeError(
                f"Remote CI failed after {remote_attempts} attempts (max {remote_max}). "
                f"Last result: {json.dumps(last_remote)[:500]}"
            )

        acceptance_items = plan.acceptance or ["Acceptance criteria to be confirmed"]
        acceptance_section = "\n".join(f"- [ ] {item}" for item in acceptance_items)
        affected_paths = plan.paths or plan.file_hints or plan.allow_paths
        paths_section = "\n".join(f"- {path}" for path in affected_paths)
        evidence_paths = [
            analysis_path,
            *diff_paths,
            *ci_paths,
            *remote_ci_paths,
            *advice_paths,
            *remote_advice_paths,
        ]
        evidence_section = "\n".join(f"- {p}" for p in evidence_paths) or "- Evidence pending"

        title = plan.pr.get("title", plan.summary or f"Implement Jira {plan.issue_key}")
        wip_prefix = os.environ.get("AEGIS_WIP_PREFIX")
        if wip_prefix and not title.startswith(wip_prefix):
            title = f"{wip_prefix}{title}"

        body = textwrap.dedent(
            f"""
            ## Summary
            {plan.summary}

            ## Acceptance Criteria
            {acceptance_section}

            ## Affected Paths
            {paths_section or '- (guardrail only)'}

            ## Evidence
            {evidence_section}
            """
        ).strip()

        pr_url = _open_pr_from_branch(ci_branch, base, title, body)
        if plan.remote_ci_delete_branch_on_success and os.environ.get(
            "AEGIS_REMOTE_DELETE_CI_BRANCH_ON_SUCCESS", "true"
        ).lower() == "true":
            # We keep the branch for the PR; no deletion needed here.
            pass

        diff_payload["diffs"] = diffs
        diff_payload["loc_delta"] = _sum_loc_from_unified(diffs)
        return pr_url, evidence_paths, diff_payload
    finally:
        if branch_created and os.environ.get("AEGIS_REMOTE_DELETE_CI_ON_FAILURE", "false").lower() == "true":
            _gh_delete_branch(ci_branch)


def run_end_to_end(plan: Plan) -> Tuple[str, List[str], Dict[str, Any]]:
    import asyncio

    return asyncio.run(run_end_to_end_async(plan))


async def main_async(args: argparse.Namespace) -> None:
    required_env = [
        "ANTHROPIC_API_KEY",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "AEGIS_GITHUB_OWNER",
        "AEGIS_GITHUB_REPO",
    ]
    missing = [env for env in required_env if not os.getenv(env)]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

    plan = load_plan(Path(args.plan))
    pr_url, _, _ = await run_end_to_end_async(plan)
    print(pr_url)


def build_argparser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Claude Agent SDK FedRAMP swarm")
    parser.add_argument("--plan", required=True, help="Path to plan JSON")
    return parser


def main() -> None:
    args = build_argparser().parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
