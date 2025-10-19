
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from mcp import StdioServerParameters
from agents.tools.mcp import MCPClient

REPO_ROOT = Path(__file__).resolve().parents[2]


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


def _jira_client() -> MCPClient:
    env = {
        "JIRA_BASE_URL": os.environ.get("JIRA_BASE_URL", ""),
        "JIRA_EMAIL": os.environ.get("JIRA_EMAIL", ""),
        "JIRA_API_TOKEN": os.environ.get("JIRA_API_TOKEN", ""),
        "JIRA_PROJECT_KEY": os.environ.get("JIRA_PROJECT_KEY", ""),
        "AEGIS_JIRA_AUDIT": os.environ.get("AEGIS_JIRA_AUDIT", ""),
        "AEGIS_AUTO_APPROVE": os.environ.get("AEGIS_AUTO_APPROVE", ""),
        "GITHUB_PERSONAL_ACCESS_TOKEN": os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN", ""),
        "AEGIS_GITHUB_OWNER": os.environ.get("AEGIS_GITHUB_OWNER", ""),
        "AEGIS_GITHUB_REPO": os.environ.get("AEGIS_GITHUB_REPO", ""),
    }
    env = {key: value for key, value in env.items() if value}

    return MCPClient(
        lambda: StdioServerParameters(
            command="uv",
            args=["run", "servers/jira/jira_mcp_server.py"],
            env=env,
        )
    )


def _coerce_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def _adf_text(node: Dict[str, Any]) -> str:
    collected: List[str] = []

    def walk(current: Any) -> None:
        if isinstance(current, dict):
            if current.get("type") == "text" and isinstance(current.get("text"), str):
                collected.append(current["text"])
            for key in ("content", "marks"):
                value = current.get(key)
                if isinstance(value, list):
                    for child in value:
                        walk(child)
        elif isinstance(current, list):
            for child in current:
                walk(child)

    walk(node)
    return " ".join(" ".join(collected).split())


def _find_section_content(adf: Dict[str, Any], section_names: List[str]) -> List[Dict[str, Any]]:
    if not isinstance(adf, dict):
        return []
    content = adf.get("content") or []
    captured: List[Dict[str, Any]] = []
    grabbing = False
    level = None
    for node in content:
        if isinstance(node, dict) and node.get("type") == "heading":
            text = _adf_text(node).strip().lower()
            if grabbing and (level is None or node.get("attrs", {}).get("level") == level):
                break
            if any(name.lower() in text for name in section_names):
                grabbing = True
                level = node.get("attrs", {}).get("level")
                continue
        if grabbing:
            captured.append(node)
    return captured


def _extract_checklist_items(nodes: List[Dict[str, Any]]) -> List[str]:
    items: List[str] = []

    def walk(current: Any) -> None:
        if isinstance(current, dict):
            node_type = current.get("type")
            if node_type in ("taskItem", "listItem"):
                text = _adf_text(current).strip()
                if text:
                    items.append(text)
            for key in ("content",):
                value = current.get(key)
                if isinstance(value, list):
                    for child in value:
                        walk(child)
        elif isinstance(current, list):
            for child in current:
                walk(child)

    for node in nodes:
        walk(node)
    return items


def _parse_acceptance_from_description(description: Any) -> List[str]:
    try:
        if isinstance(description, dict) and description.get("type") == "doc":
            section = _find_section_content(description, ["Acceptance Criteria", "AC", "Acceptance"])
            items = _extract_checklist_items(section)
            if items:
                return items
            as_text = [
                _adf_text(node)
                for node in section
            ]
            return [text.strip() for text in as_text if text and text.strip()]
    except Exception:
        pass

    if isinstance(description, str):
        pattern = re.compile(
            r"(?:^|\n)#{1,6}\s*(?:Acceptance Criteria|AC)[: ]?\n(?P<body>.*?)(?:\n#{1,6}|\Z)",
            re.IGNORECASE | re.DOTALL,
        )
        match = pattern.search(description)
        body = match.group("body") if match else description
        lines = [
            line.strip("- *\t").strip()
            for line in body.splitlines()
            if re.match(r"^\s*(?:[-*]|\[\s*[x ]\s*\])", line)
        ]
        return [line for line in lines if line]

    return []


def _parse_file_hints(description: Any) -> List[str]:
    if isinstance(description, dict) and description.get("type") == "doc":
        text = _adf_text(description)
    else:
        text = str(description or "")
    match = re.search(
        r"```(?:\w+)?\s*(?:File\s*Hints|file[\s_-]*hints)\s*\n(?P<body>.*?)```",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if match:
        hints = [line.strip() for line in match.group("body").splitlines() if line.strip()]
        if hints:
            return hints[:32]

    # Fallback: scan plain text lines for path-like strings (e.g., services/foo/bar.go)
    fallback: List[str] = []
    line_pattern = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+/?$")
    for line in text.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        if line_pattern.match(candidate):
            fallback.append(candidate)
        if len(fallback) >= 32:
            return fallback

    # As a final resort, search anywhere in the text for path-like substrings.
    inline_pattern = re.compile(r"(?=[A-Za-z0-9_.-/]*[A-Za-z_])[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+/?")
    for match in inline_pattern.finditer(text):
        path = match.group(0)
        if path not in fallback:
            fallback.append(path)
        if len(fallback) >= 32:
            break
    return fallback


def _component_path_map() -> Dict[str, str]:
    cfg_path = REPO_ROOT / ".aegis" / "config.yaml"
    if cfg_path.is_file():
        try:
            import yaml

            data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            mapping = data.get("component_path_map") if isinstance(data, dict) else {}
            if isinstance(mapping, dict):
                return {str(k).lower(): str(v) for k, v in mapping.items()}
        except Exception:
            return {}
    return {"proxy": "services/proxy/**"}


def _paths_from_components(components: List[str]) -> List[str]:
    mapping = _component_path_map()
    paths: List[str] = []
    for component in components:
        key = component.lower().strip()
        if key in mapping:
            paths.append(mapping[key])
    # Preserve order but deduplicate.
    seen: Dict[str, None] = {}
    for path in paths:
        seen.setdefault(path, None)
    return list(seen.keys())


def _normalize_allow(paths: List[str]) -> List[str]:
    return list(dict.fromkeys(paths or ["services/**", "charts/**"]))


def _default_tests_docs(issue_type: str, labels: List[str]) -> Tuple[bool, bool]:
    issue = issue_type.lower()
    tests = issue in {"story", "bug", "refactor"}
    docs = issue in {"story", "refactor"}
    label_blob = " ".join(labels).lower()
    if "no-tests" in label_blob:
        tests = False
    if "no-docs" in label_blob:
        docs = False
    return tests, docs


def _detect_breaking(summary: str, labels: List[str]) -> bool:
    sample = f"{summary} {' '.join(labels)}".lower()
    return any(token in sample for token in ("breaking", "public api", "api change"))


def _detect_migration(summary: str, labels: List[str]) -> bool:
    sample = f"{summary} {' '.join(labels)}".lower()
    return any(token in sample for token in ("migration", "migrate", "db schema", "database", "ddl"))


def _mcp_call(name: str, tool: str, args: Dict[str, Any]) -> Any:
    with _jira_client() as client:
        response = client.call_tool_sync(name, tool, args)

    if isinstance(response, dict):
        structured = response.get("structuredContent") if "structuredContent" in response else response.get("result")
        if isinstance(structured, dict):
            return structured.get("result", structured)
        return structured or response

    content = getattr(response, "content", None)
    if isinstance(content, list) and content and isinstance(content[0], dict):
        text = content[0].get("text")
        if isinstance(text, str):
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return text
    return response


def whoami() -> Dict[str, Any]:
    data = _mcp_call("jira-whoami", "whoami", {})
    return data if isinstance(data, dict) else {}


def probe_issue_visibility(issue_key: str) -> Dict[str, Any]:
    data = _mcp_call(
        "jira-probe",
        "probe_issue_visibility",
        {"issue_key": issue_key},
    )
    return data if isinstance(data, dict) else {}


_SINGLE_KEY_PATTERNS = [
    r"^\s*key\s*=\s*(?P<k>[A-Z][A-Z0-9]+-\d+)\s*$",
    r"^\s*issuekey\s*=\s*(?P<k>[A-Z][A-Z0-9]+-\d+)\s*$",
    r"^\s*key\s+in\s*\(\s*(?P<k>[A-Z][A-Z0-9]+-\d+)\s*\)\s*$",
    r"^\s*issuekey\s+in\s*\(\s*(?P<k>[A-Z][A-Z0-9]+-\d+)\s*\)\s*$",
]


def _extract_single_key(jql: str) -> Optional[str]:
    candidate = (jql or "").strip()
    for pattern in _SINGLE_KEY_PATTERNS:
        match = re.match(pattern, candidate, flags=re.IGNORECASE)
        if match:
            key = match.group("k")
            return key.upper()
    return None


def diagnose_single_issue_from_jql(jql: str) -> Dict[str, Any]:
    key = _extract_single_key(jql)
    if not key:
        return {"diagnosis": "not-single-key"}

    identity = whoami()
    probe = probe_issue_visibility(key)

    raw_status = probe.get("status")
    try:
        status = int(raw_status)
    except (TypeError, ValueError):
        status = 0

    if status == 200:
        hint = "Issue visible via GET; proceeding via single-key fallback if needed."
    elif status in (401, 403, 404):
        hint = (
            f"Service account cannot view {key}. Grant 'Browse projects' or team access, "
            "and include the user in any Issue Security level."
        )
    else:
        hint = "Unexpected response probing issue; verify permissions and site access."

    return {
        "diagnosis": "single-key",
        "issue_key": key,
        "whoami": {
            "accountId": identity.get("accountId"),
            "email": identity.get("emailAddress"),
        },
        "probe": probe,
        "hint": hint,
    }


def search_for_ready_issues(jql: str, limit: int = 10, next_page_token: Optional[str] = None) -> List[str]:
    payload: Dict[str, Any] = {
        "jql": jql,
        "limit": limit,
        "start_at": 0,
        "fields": ["key", "summary", "status", "issuetype", "labels", "components"],
    }
    if next_page_token:
        payload["next_page_token"] = next_page_token

    result = _mcp_call(
        "jira-search",
        "search_issues",
        payload,
    )
    issues = (result or {}).get("issues", []) if isinstance(result, dict) else []
    keys: List[str] = []
    for issue in issues:
        key = issue.get("key") if isinstance(issue, dict) else None
        if isinstance(key, str):
            keys.append(key)
    if keys:
        return keys

    single = _extract_single_key(jql)
    if single:
        probe = probe_issue_visibility(single)
        if isinstance(probe, dict) and probe.get("visible") is True:
            return [single]
    return keys


def load_plan_from_jira(issue_key: str) -> Plan:
    fields = [
        "summary",
        "description",
        "labels",
        "components",
        "issuetype",
        "status",
        "customfield_risk",
        "customfield_maxfiles",
        "customfield_allowpaths",
        "customfield_baseline",
        "customfield_controls",
        "parent",
        "customfield_10014",
    ]
    data = _mcp_call(
        "jira-get",
        "get_issue",
        {"issue_key": issue_key, "expand": ["renderedFields"], "fields": fields},
    )
    issue_fields = (data or {}).get("fields", {}) if isinstance(data, dict) else {}

    summary = issue_fields.get("summary") or ""
    description = issue_fields.get("description")
    labels = _coerce_list(issue_fields.get("labels"))
    components = [
        component.get("name")
        for component in issue_fields.get("components", [])
        if isinstance(component, dict) and component.get("name")
    ]

    acceptance = _parse_acceptance_from_description(description)
    file_hints = _parse_file_hints(description)

    risk_custom = issue_fields.get("customfield_risk")
    risk = str(risk_custom).title() if risk_custom else ("High" if "risk-high" in labels else "Medium")

    try:
        max_files = int(issue_fields.get("customfield_maxfiles") or 8)
    except Exception:
        max_files = 8

    allow_paths_field = issue_fields.get("customfield_allowpaths")
    allow_paths = _coerce_list(allow_paths_field) or _normalize_allow(file_hints or _paths_from_components(components))

    paths = list(dict.fromkeys((file_hints or []) + _paths_from_components(components)))

    tests_required, docs_required = _default_tests_docs(issue_fields.get("issuetype", {}).get("name", ""), labels)

    plan = Plan(
        baseline=str(issue_fields.get("customfield_baseline") or "moderate"),
        controls=_coerce_list(issue_fields.get("customfield_controls")),
        file_hints=file_hints,
        allow_paths=_normalize_allow(paths or allow_paths),
        max_files=max_files,
        pr={
            "branch_prefix": f"jira-{issue_key.lower()}",
            "title": f"[{issue_key}] {summary}",
            "base": os.environ.get("AEGIS_GITHUB_BASE") or "main",
        },
        issue_key=issue_key,
        issue_type=(issue_fields.get("issuetype") or {}).get("name", "Task"),
        summary=summary,
        acceptance=acceptance,
        component=components,
        paths=paths,
        risk=risk,
        tests_required=tests_required,
        docs_required=docs_required,
        breaking_change=_detect_breaking(summary, labels),
        requires_migration=_detect_migration(summary, labels),
        labels=labels,
    )
    return plan


def post_pr_comment(
    issue_key: str,
    pr_url: str,
    evidence_paths: List[str],
    diff_summary: Dict[str, Any],
    notes: str = "",
    include_evidence: bool = True,
) -> None:
    paragraphs: List[Dict[str, Any]] = []
    paragraphs.append(
        {
            "type": "paragraph",
            "content": [
                {
                    "type": "text",
                    "text": f"PR opened: {pr_url}" if pr_url else "No PR opened yet.",
                }
            ],
        }
    )
    files_changed = len((diff_summary or {}).get("diffs", {}))
    paragraphs.append(
        {
            "type": "paragraph",
            "content": [{"type": "text", "text": f"Files changed: {files_changed}"}],
        }
    )
    if "loc_delta" in diff_summary:
        paragraphs.append(
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": f"LOC delta: {diff_summary['loc_delta']}"}],
            }
        )
    if notes:
        paragraphs.append(
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": notes}],
            }
        )
    if include_evidence and evidence_paths:
        paragraphs.append({"type": "paragraph", "content": [{"type": "text", "text": "Evidence:"}]})
        for path in evidence_paths:
            paragraphs.append(
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": f"- {path}"}],
                }
            )
    elif not include_evidence:
        paragraphs.append(
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "Evidence: (omitted for Jira engineering mode)"}],
            }
        )
    body = {"type": "doc", "version": 1, "content": paragraphs}
    _mcp_call(
        "jira-comment",
        "add_comment",
        {"issue_key": issue_key, "body": body, "is_adf": False},
    )


def safe_transition(issue_key: str, to_status: str) -> None:
    try:
        _mcp_call(
            "jira-transition",
            "transition_issue",
            {"issue_key": issue_key, "transition_name": to_status},
        )
    except Exception:
        pass


def ensure_label(issue_key: str, label: str) -> None:
    if not label:
        return
    try:
        issue = _mcp_call(
            "jira-get-labels",
            "get_issue",
            {"issue_key": issue_key, "fields": ["labels"]},
        )
        fields = issue.get("fields", {}) if isinstance(issue, dict) else {}
        existing = _coerce_list(fields.get("labels"))
        if label not in existing:
            updated = existing + [label]
            _mcp_call(
                "jira-set-labels",
                "set_fields",
                {"issue_key": issue_key, "fields": {"labels": updated}},
            )
    except Exception:
        pass
