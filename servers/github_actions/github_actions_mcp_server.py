"""MCP server exposing a minimal GitHub Actions surface.

Tools:
  - list_workflows: enumerate workflows for a repo
  - prepare_dispatch: return payload/endpoint that would be used to trigger
    a workflow
  - dispatch_workflow: trigger a workflow run (requires confirm)

Environment variables loaded (either via `.env` or shell):
  GITHUB_PERSONAL_ACCESS_TOKEN - PAT with `repo` and `workflow` scopes
  AEGIS_GITHUB_OWNER           - default owner for operations
  AEGIS_GITHUB_REPO            - default repository
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx
from mcp.server.fastmcp import FastMCP


mcp = FastMCP("GitHubActions")


API_BASE = "https://api.github.com"


def _get_token() -> str:
    token = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN")
    if not token:
        raise RuntimeError("GITHUB_PERSONAL_ACCESS_TOKEN is not set")
    return token


def _get_owner_repo(owner: Optional[str], repo: Optional[str]) -> tuple[str, str]:
    resolved_owner = owner or os.environ.get("AEGIS_GITHUB_OWNER")
    resolved_repo = repo or os.environ.get("AEGIS_GITHUB_REPO")
    if not resolved_owner or not resolved_repo:
        raise RuntimeError("Missing repository identifiers (owner/repo)")
    return resolved_owner, resolved_repo


def _client(token: str) -> httpx.Client:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "aegis-final-ui-mcp",
    }
    return httpx.Client(base_url=API_BASE, headers=headers, timeout=30)


def _workflow_identifier(workflow: str | int) -> str:
    if isinstance(workflow, int):
        return str(workflow)
    workflow_str = str(workflow).strip()
    if workflow_str.isdigit():
        return workflow_str
    return workflow_str


@mcp.tool()
def list_workflows(owner: Optional[str] = None, repo: Optional[str] = None) -> Dict[str, Any]:
    """List workflows configured for the repository."""

    token = _get_token()
    resolved_owner, resolved_repo = _get_owner_repo(owner, repo)
    with _client(token) as client:
        response = client.get(f"/repos/{resolved_owner}/{resolved_repo}/actions/workflows")
        if response.status_code >= 400:
            return {
                "ok": False,
                "status": response.status_code,
                "error": response.text,
            }
        data = response.json()
    workflows = [
        {
            "id": wf.get("id"),
            "name": wf.get("name"),
            "path": wf.get("path"),
            "state": wf.get("state"),
        }
        for wf in data.get("workflows", [])
    ]
    return {"ok": True, "count": len(workflows), "workflows": workflows}


def _build_dispatch_payload(ref: str, inputs: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"ref": ref}
    if inputs:
        payload["inputs"] = inputs
    return payload


@mcp.tool()
def prepare_dispatch(
    workflow: str | int,
    ref: str = "main",
    inputs: Optional[Dict[str, Any]] = None,
    owner: Optional[str] = None,
    repo: Optional[str] = None,
) -> Dict[str, Any]:
    """Return the endpoint and payload that would dispatch a workflow."""

    resolved_owner, resolved_repo = _get_owner_repo(owner, repo)
    identifier = _workflow_identifier(workflow)
    payload = _build_dispatch_payload(ref, inputs)
    endpoint = f"/repos/{resolved_owner}/{resolved_repo}/actions/workflows/{identifier}/dispatches"
    return {
        "ok": True,
        "endpoint": endpoint,
        "method": "POST",
        "payload": payload,
        "note": "Call dispatch_workflow with confirm=True to execute",
    }


@mcp.tool()
def dispatch_workflow(
    workflow: str | int,
    ref: str = "main",
    inputs: Optional[Dict[str, Any]] = None,
    owner: Optional[str] = None,
    repo: Optional[str] = None,
    confirm: bool = False,
) -> Dict[str, Any]:
    """Trigger a GitHub Actions workflow if confirm=True; otherwise return dry-run info."""

    resolved_owner, resolved_repo = _get_owner_repo(owner, repo)
    identifier = _workflow_identifier(workflow)
    payload = _build_dispatch_payload(ref, inputs)
    endpoint = f"/repos/{resolved_owner}/{resolved_repo}/actions/workflows/{identifier}/dispatches"

    if not confirm:
        return {
            "ok": False,
            "dispatched": False,
            "endpoint": endpoint,
            "payload": payload,
            "message": "Set confirm=True to send the dispatch request",
        }

    token = _get_token()
    with _client(token) as client:
        response = client.post(endpoint, json=payload)
        if response.status_code >= 400:
            return {
                "ok": False,
                "dispatched": False,
                "status": response.status_code,
                "error": response.text,
            }

    return {"ok": True, "dispatched": True, "status": 204, "endpoint": endpoint}


if __name__ == "__main__":
    import traceback

    try:
        mcp.run()
    except Exception:
        traceback.print_exc()
        raise
