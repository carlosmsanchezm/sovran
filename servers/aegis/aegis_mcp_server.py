from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

# Add repo root to Python path so we can import servers.mcp_compat
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from mcp.server.fastmcp import FastMCP

# Apply MCP JSON-RPC compatibility shim for legacy Codex clients.
# import servers.mcp_compat  # noqa: F401


mcp = FastMCP("Aegis")

EVIDENCE_DIR = REPO_ROOT / ".aegis" / "evidence"


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


@mcp.tool()
def evidence_write_json(name_prefix: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    timestamp = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
    path = EVIDENCE_DIR / f"{timestamp}_{name_prefix}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return {"ok": True, "path": str(path)}


@mcp.tool()
def repo_glob(patterns: List[str], max_results: int = 200) -> Dict[str, Any]:
    seen: set[str] = set()
    results: list[str] = []
    for pattern in patterns or []:
        for candidate in REPO_ROOT.glob(pattern):
            if candidate.is_file():
                rel = str(candidate.relative_to(REPO_ROOT))
                if rel not in seen:
                    seen.add(rel)
                    results.append(rel)
            if len(results) >= max_results:
                break
        if len(results) >= max_results:
            break
    results.sort()
    return {"results": results}


@mcp.tool()
def go_build(target: str = "./services/proxy/cmd/aegis-auth-proxy") -> Dict[str, Any]:
    out_dir = REPO_ROOT / "out"
    out_dir.mkdir(exist_ok=True)
    commands = [
        ["go", "work", "sync"],
        ["go", "build", "-o", str(out_dir / "aegis-auth-proxy"), target],
    ]
    ok = True
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    for cmd in commands:
        result = subprocess.run(cmd, cwd=str(REPO_ROOT), text=True, capture_output=True)
        stdout_chunks.append(result.stdout or "")
        stderr_chunks.append(result.stderr or "")
        if result.returncode != 0:
            ok = False
            break
    return {"ok": ok, "stdout": "\n".join(stdout_chunks), "stderr": "\n".join(stderr_chunks)}


@mcp.tool()
def run_tests(cmd: str = "") -> Dict[str, Any]:
    test_cmd = cmd or os.environ.get("AEGIS_TEST_CMD") or "go test ./..."
    result = subprocess.run(
        test_cmd,
        cwd=str(REPO_ROOT),
        text=True,
        shell=True,
        capture_output=True,
        timeout=600,
    )
    return {
        "ok": result.returncode == 0,
        "exit_code": result.returncode,
        "cmd": test_cmd,
        "stdout": (result.stdout or "")[-100_000:],
        "stderr": (result.stderr or "")[-100_000:],
    }


if __name__ == "__main__":
    mcp.run()
