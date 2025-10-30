from __future__ import annotations

import re
from typing import Any, Dict, List


def analyze_ci_failure(diffs: Dict[str, str], test_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Return deterministic edit instructions for common test failures observed in this repo.
    """
    edits: List[Dict[str, Any]] = []
    stdout = str(test_result.get("stdout") or "")
    stderr = str(test_result.get("stderr") or "")
    combined = "\n".join([stdout, stderr])

    # 1. Local proxy cannot bind to fixed port (EADDRINUSE on 7001).
    if "EADDRINUSE" in combined and "127.0.0.1:7001" in combined:
        edits.append({
            "path": "scripts/test/start-proxy.js",
            "instructions": (
                "Allow overriding the listen port via `process.env.AEGIS_TEST_PROXY_PORT` and default to a random "
                "free port when not provided (use `get-port` or similar helper). Ensure the wait-on check uses the "
                "chosen port."
            ),
        })
        edits.append({
            "path": "scripts/test/run-all.js",
            "instructions": (
                "Before starting the proxy/bridge, obtain a free port (e.g. using `get-port`), set "
                "`process.env.AEGIS_TEST_PROXY_PORT`, and update the bridge/waitOn targets so the tests run on the "
                "selected port. This removes the hard-coded 7001 collision."
            ),
        })
        return edits

    # 2. Jest global branch coverage threshold not met (common when new logic added without tests).
    coverage_match = re.search(r'Jest: "global" coverage threshold.*branches.*?(\d+\.\d+)%', combined)
    if coverage_match:
        # Provide targeted guidance based on files called out in the coverage summary.
        uncovered_lines = []
        for path, diff in (diffs or {}).items():
            if path.endswith(".ts"):
                uncovered_lines.append(path)
        edits.append({
            "path": "aegis-vscode-remote/extension/src/__tests__/unit/auth.test.ts",
            "instructions": (
                "Add a unit test asserting that `requireSession` delegates to `vscode.authentication.getSession` so the "
                "PKCE login path remains covered. Mock the VS Code API, invoke `requireSession(true)`, and verify the mock "
                "was called with the expected provider ID and scopes."
            ),
        })
        return edits

    return edits


__all__ = ["analyze_ci_failure"]
