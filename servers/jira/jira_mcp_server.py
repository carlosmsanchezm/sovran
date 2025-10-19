from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# Add repo root to Python path so we can import servers.mcp_compat
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

import httpx
from mcp.server.fastmcp import FastMCP

# Apply MCP JSON-RPC compatibility shim for legacy Codex clients.
# import servers.mcp_compat  # noqa: F401

mcp = FastMCP("Jira")


class ToolError(Exception):
    """Custom exception for MCP tool errors"""
    pass

BASE_URL = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
EMAIL = os.environ.get("JIRA_EMAIL", "")
TOKEN = os.environ.get("JIRA_API_TOKEN", "")
PROJECT = os.environ.get("JIRA_PROJECT_KEY", "")
AUDIT_LOG = os.environ.get("AEGIS_JIRA_AUDIT", ".aegis/logs/jira_mcp_audit.jsonl")

if not (BASE_URL and EMAIL and TOKEN):
    raise SystemExit("JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN are required")


def _auth_header() -> Dict[str, str]:
    raw = f"{EMAIL}:{TOKEN}".encode("utf-8")
    encoded = base64.b64encode(raw).decode("ascii")
    return {"Authorization": f"Basic {encoded}"}


def _audit(
    tool: str,
    path: str,
    method: str,
    ok: bool,
    args: Dict[str, Any],
    code: Optional[int],
    note: Optional[str] = None,
) -> None:
    try:
        safe_args = json.loads(json.dumps(args))
        for key in list(safe_args.keys()):
            if any(token in key.lower() for token in ("token", "auth", "password", "secret")):
                safe_args[key] = "***REDACTED***"
        record = {
            "ts": int(time.time()),
            "tool": tool,
            "method": method,
            "path": path,
            "args_hash": hashlib.sha256(
                json.dumps(safe_args, sort_keys=True).encode("utf-8")
            ).hexdigest(),
            "ok": ok,
            "status": code,
            "note": note or "",
        }
        os.makedirs(os.path.dirname(AUDIT_LOG), exist_ok=True)
        with open(AUDIT_LOG, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
    except Exception:
        # Never let audit logging break request handling.
        pass


def _client() -> httpx.Client:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        **_auth_header(),
    }
    return httpx.Client(headers=headers, timeout=30.0, http2=False)


def _request_raw(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    json_body: Any = None,
) -> httpx.Response:
    url = f"{BASE_URL}{path}"
    attempts = 0
    while True:
        attempts += 1
        with _client() as client:
            response = client.request(method, url, params=params, json=json_body)

        if response.status_code < 400:
            _audit(
                "jira",
                path,
                method,
                True,
                {"params": params or {}, "json": json_body or {}},
                response.status_code,
            )
            return response

        retryable = response.status_code in {429, 500, 502, 503, 504}
        if retryable and attempts < 6:
            retry_after = response.headers.get("Retry-After")
            if retry_after and retry_after.isdigit():
                delay = max(0.5, min(30.0, float(retry_after)))
            else:
                delay = min(30.0, 0.5 * (2 ** (attempts - 1)) + random.uniform(0, 0.5))
            _audit(
                "jira",
                path,
                method,
                False,
                {"params": params or {}, "json": json_body or {}},
                response.status_code,
                f"backoff {delay}s",
            )
            time.sleep(delay)
            continue

        _audit(
            "jira",
            path,
            method,
            False,
            {"params": params or {}, "json": json_body or {}},
            response.status_code,
            response.text[:500],
        )
        return response


def _request(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    json_body: Any = None,
) -> Dict[str, Any]:
    response = _request_raw(method, path, params=params, json_body=json_body)
    if response.status_code >= 400:
        raise ToolError(f"Jira API error {response.status_code}: {response.text[:512]}")

    if response.status_code == 204 or not response.content:
        return {}
    try:
        return response.json()
    except Exception:
        return {"raw": response.text}


def _search_impl(
    jql: str,
    limit: int,
    start_at: int,
    fields: Optional[List[str]],
    next_page_token: Optional[str] = None,
    expand: Optional[List[str]] = None,
):
    body: Dict[str, Any] = {
        "jql": jql,
        "maxResults": int(limit or 10),
    }
    if fields:
        body["fields"] = fields
    if expand:
        body["expand"] = expand if isinstance(expand, list) else [str(expand)]
    if next_page_token:
        body["nextPageToken"] = next_page_token

    try:
        data = _request("POST", "/rest/api/3/search/jql", json_body=body)
        if isinstance(data, dict):
            results = data.get("results") or []
            if isinstance(results, list) and results:
                first = results[0]
                return first if isinstance(first, dict) else {"issues": []}
            issues = data.get("issues")
            if isinstance(issues, list):
                return {"issues": issues}
        return {"issues": []}
    except ToolError:
        params: Dict[str, Any] = {
            "jql": jql,
            "maxResults": int(limit or 10),
        }
        if fields:
            params["fields"] = ",".join(fields)
        if expand:
            params["expand"] = ",".join(expand if isinstance(expand, list) else [str(expand)])
        if next_page_token:
            params["nextPageToken"] = next_page_token
        return _request("GET", "/rest/api/3/search/jql", params=params)


@mcp.tool()
def search_issues(
    jql: str,
    limit: int = 10,
    start_at: int = 0,
    fields: Optional[List[str]] = None,
    next_page_token: Optional[str] = None,
    expand: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Search issues via the enhanced JQL endpoint."""

    return _search_impl(jql, limit, start_at, fields, next_page_token, expand)


@mcp.tool()
def get_issue(
    issue_key: str,
    expand: Optional[List[str]] = None,
    fields: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Fetch a single issue with optional expand and fields selections."""

    params: Dict[str, Any] = {}
    if expand:
        params["expand"] = ",".join(expand)
    if fields:
        params["fields"] = ",".join(fields)
    return _request("GET", f"/rest/api/3/issue/{issue_key}", params=params)


@mcp.tool()
def add_comment(issue_key: str, body: Any, is_adf: bool = True) -> Dict[str, Any]:
    """Add a Jira comment, wrapping plain text as ADF when requested."""

    payload = body
    if is_adf and isinstance(body, str):
        payload = {
            "type": "doc",
            "version": 1,
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": body}],
                }
            ],
        }
    return _request(
        "POST",
        f"/rest/api/3/issue/{issue_key}/comment",
        json_body={"body": payload},
    )


@mcp.tool()
def transition_issue(issue_key: str, transition_name: str) -> Dict[str, Any]:
    """Transition an issue by case-insensitive name lookup."""

    data = _request(
        "GET",
        f"/rest/api/3/issue/{issue_key}/transitions",
        params={"expand": "transitions.fields"},
    )
    transitions = (data or {}).get("transitions", [])
    target = None
    for candidate in transitions:
        name = str(candidate.get("name", ""))
        if name.lower() == transition_name.lower():
            target = candidate
            break
    if not target:
        raise ToolError(f"Transition '{transition_name}' not available for {issue_key}")
    return _request(
        "POST",
        f"/rest/api/3/issue/{issue_key}/transitions",
        json_body={"transition": {"id": target.get("id")}},
    )


@mcp.tool()
def set_fields(issue_key: str, fields: Dict[str, Any]) -> Dict[str, Any]:
    """Sparse update for issue fields."""

    return _request("PUT", f"/rest/api/3/issue/{issue_key}", json_body={"fields": fields})


@mcp.tool()
def create_subtask(parent_key: str, fields: Dict[str, Any]) -> Dict[str, Any]:
    """Create a sub-task under the specified parent issue."""

    payload = dict(fields)
    payload.setdefault("parent", {"key": parent_key})
    payload.setdefault("issuetype", {"name": "Sub-task"})
    return _request("POST", "/rest/api/3/issue", json_body={"fields": payload})


@mcp.tool()
def whoami() -> Dict[str, Any]:
    """
    Identify the authenticated Jira user.
    REST: GET /rest/api/3/myself
    """

    return _request("GET", "/rest/api/3/myself")


@mcp.tool()
def probe_issue_visibility(issue_key: str) -> Dict[str, Any]:
    """
    Probe whether the current credentials can view an issue.
    Returns a non-throwing payload.
    """

    response = _request_raw(
        "GET",
        f"/rest/api/3/issue/{issue_key}",
        params={"fields": "summary"},
    )

    if response.status_code < 400:
        data = {}
        try:
            data = response.json()
        except Exception:
            pass
        fields = data.get("fields", {}) if isinstance(data, dict) else {}
        return {
            "status": response.status_code,
            "ok": True,
            "visible": True,
            "summary": fields.get("summary", ""),
        }

    error = response.text[:512]
    return {
        "status": response.status_code,
        "ok": False,
        "visible": False,
        "error": error,
    }


if __name__ == "__main__":
    _audit(
        "jira",
        "/boot",
        "INIT",
        True,
        {"base_url": BASE_URL},
        None,
        "Jira MCP server online",
    )
    mcp.run()
