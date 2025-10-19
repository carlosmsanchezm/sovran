from __future__ import annotations

import json
import os
import sys
import textwrap
from pathlib import Path
from typing import Any, Dict

# Add repo root to Python path so we can import servers.mcp_compat
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from mcp.server.fastmcp import FastMCP

# Apply MCP JSON-RPC compatibility shim for legacy Codex clients.
# import servers.mcp_compat  # noqa: F401

try:
    from openai import OpenAI
except Exception as exc:  # pragma: no cover - import guard
    sys.stderr.write(f"[gpt5_mcp] install missing dependency: openai ({exc})\n")
    raise

mcp = FastMCP("gpt5")  # tool namespace will be mcp__gpt5__advise

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
MODEL = os.environ.get("AEGIS_OPENAI_MODEL", "gpt-5-pro-2025-10-06")
if not OPENAI_API_KEY:
    raise SystemExit("OPENAI_API_KEY is required for gpt5_pro_mcp_server.py")

client = OpenAI(api_key=OPENAI_API_KEY)


def _truncate(value: Any, limit: int = 200_000) -> str:
    """Limit payload size to avoid exceeding request caps."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text[:limit]


@mcp.tool()
def advise(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Diagnose failing tests and propose minimal, safe edits.

    Expected payload keys:
      - summary: str
      - acceptance: list[str]
      - allow_paths: list[str]
      - max_files: int
      - diffs: dict[str, str]
      - test_result: dict[str, Any]
    Returns STRICT JSON:
      {"summary": "...", "root_cause": "...",
       "edits":[{"path":"...", "instructions":"..."}],
       "risk":"Low|Medium|High", "confidence": 0.0-1.0}
    """
    prompt = textwrap.dedent(
        f"""
        You are GPT-5 Pro acting as an advisor of last resort for a CI failure.
        Constraints you MUST obey:
        - Only propose changes inside allow_paths; <= max_files files.
        - Keep edits minimal and safe, targeted to satisfy acceptance criteria.
        - Output STRICT JSON ONLY with keys: summary, root_cause, edits, risk, confidence.
        - Each edit: {{ "path": "<file>", "instructions": "<what to change and why>" }}

        Acceptance: {json.dumps(payload.get("acceptance", []), ensure_ascii=False)}
        Allow paths: {json.dumps(payload.get("allow_paths", []))}
        Max files: {int(payload.get("max_files") or 8)}

        Issue summary: {_truncate(payload.get("summary", ""), 2000)}

        Test result (truncated):
        {_truncate(payload.get("test_result", {}), 120000)}

        Diffs under review (unified, truncated):
        {_truncate(payload.get("diffs", {}), 120000)}

        Now return STRICT JSON only.
        """
    ).strip()

    response = client.responses.create(
        model=MODEL,
        input=prompt,
        reasoning={"effort": "high"},
    )
    text = getattr(response, "output_text", None)
    if not text:
        # Fallback to collect text fragments in case output_text is unavailable.
        items = getattr(response, "output", None) or []
        chunks: list[str] = []
        for item in items:
            content = getattr(item, "content", None)
            if isinstance(content, list):
                for block in content:
                    candidate = getattr(block, "text", None)
                    if isinstance(candidate, str):
                        chunks.append(candidate)
        text = "\n".join(chunks)

    try:
        data = json.loads((text or "").strip())
        if not isinstance(data, dict):
            raise ValueError("non-object JSON")
    except Exception:
        data = {
            "summary": "parse-error",
            "root_cause": "Model did not return valid JSON.",
            "edits": [],
            "risk": "Medium",
            "confidence": 0.0,
            "raw": (text or "")[:2000],
        }

    return data


if __name__ == "__main__":
    mcp.run()
