
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Tuple

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    yaml = None

from agents.tools.mcp import jira_client
from agents.tools.mcp.jira_client import Plan

REPO_ROOT = Path(__file__).resolve().parents[2]
LOG_PATH = REPO_ROOT / ".aegis" / "logs" / "coordinator.jsonl"


def _load_cfg() -> Dict[str, Any]:
    cfg_path = REPO_ROOT / ".aegis" / "config.yaml"
    if not cfg_path.is_file() or yaml is None:
        return {}
    try:
        return yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _success_label(cfg: Dict[str, Any]) -> str:
    jira_cfg = cfg.get("jira") or {}
    return str(jira_cfg.get("success_label") or os.environ.get("AEGIS_JIRA_SUCCESS_LABEL") or "automation-complete")


def _log(payload: Dict[str, Any]) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + "\n")


def _sum_loc_from_unified(diffs: Dict[str, str]) -> int:
    total = 0
    for diff in (diffs or {}).values():
        for line in diff.splitlines():
            if line.startswith("+++") or line.startswith("---"):
                continue
            if line.startswith("+") or line.startswith("-"):
                total += 1
    return total


def _run_swarm_with_plan(plan: Plan) -> Tuple[str, List[str], Dict[str, Any]]:
    import agents.claude.run_fedramp_swarm as swarm

    return swarm.run_end_to_end(plan)


def _guardrails_allow(diff_payload: Dict[str, Any], max_loc_delta: int) -> Tuple[bool, str]:
    diffs = diff_payload.get("diffs", {}) if isinstance(diff_payload, dict) else {}
    loc_delta = diff_payload.get("loc_delta")
    if loc_delta is None:
        loc_delta = _sum_loc_from_unified(diffs)
    diff_payload["loc_delta"] = loc_delta
    if max_loc_delta and loc_delta > max_loc_delta:
        return False, f"Change budget exceeded: LOC delta {loc_delta} > {max_loc_delta}"
    return True, f"LOC delta: {loc_delta}"


def _handle_issue(issue_key: str, cfg: Dict[str, Any]) -> None:
    pr_url = ""
    evidence_paths: List[str] = []
    diff_payload: Dict[str, Any] = {}
    guardrails = cfg.get("guardrails") or {}
    max_loc_delta = int(guardrails.get("max_loc_delta", 800))

    try:
        jira_client.safe_transition(issue_key, "In Progress")
        plan = jira_client.load_plan_from_jira(issue_key)
        plan.max_loc_delta = max_loc_delta
        is_compliance = bool(getattr(plan, "controls", []))

        if any(lbl.lower() == "automation-error" for lbl in (plan.labels or [])):
            _log({"issue": issue_key, "skip": "automation-error"})
            return

        labels_lc = [lbl.lower() for lbl in (plan.labels or [])]
        if (
            plan.risk.lower() == "high"
            and os.environ.get("AEGIS_AUTO_APPROVE") != "true"
            and "auto-approve" not in labels_lc
        ):
            jira_client.post_pr_comment(
                issue_key,
                pr_url="",
                evidence_paths=[],
                diff_summary={},
                notes="Risk=High; blocked pending manual approval. Add label 'auto-approve' to proceed.",
            )
            jira_client.ensure_label(issue_key, "needs-approval")
            return

        pr_url, evidence_paths, diff_payload = _run_swarm_with_plan(plan)

        allow, note = _guardrails_allow(diff_payload, max_loc_delta)
        if not allow:
            jira_client.post_pr_comment(
                issue_key,
                pr_url or "",
                evidence_paths if is_compliance else [],
                diff_payload,
                notes=note + " — labeling needs-approval",
                include_evidence=is_compliance,
            )
            jira_client.ensure_label(issue_key, "needs-approval")
            return

        if plan.breaking_change or plan.requires_migration:
            jira_client.post_pr_comment(
                issue_key,
                pr_url,
                evidence_paths if is_compliance else [],
                diff_payload,
                notes="Pending architect approval (breaking/migration).",
                include_evidence=is_compliance,
            )
            jira_client.ensure_label(issue_key, "needs-approval")
            return

        jira_client.post_pr_comment(
            issue_key,
            pr_url,
            evidence_paths if is_compliance else [],
            diff_payload,
            notes=note,
            include_evidence=is_compliance,
        )
        jira_client.safe_transition(issue_key, "In Review")
        if pr_url:
            jira_client.ensure_label(issue_key, _success_label(cfg))

    except Exception as exc:
        jira_client.post_pr_comment(
            issue_key,
            pr_url if pr_url else "",
            evidence_paths if "is_compliance" in locals() and is_compliance else [],
            diff_payload,
            notes=f"Automation error: {exc}",
            include_evidence=("is_compliance" in locals() and is_compliance),
        )
        try:
            jira_client.ensure_label(issue_key, "automation-error")
        except Exception:
            pass
        _log({"issue": issue_key, "error": str(exc), "trace": traceback.format_exc()})


def main() -> None:
    cfg = _load_cfg()
    jira_cfg = cfg.get("jira") or {}
    single_issue = jira_cfg.get("single_issue_key")
    if single_issue:
        jql = f"key = {single_issue}"
    else:
        jql = jira_cfg.get("jql") or "project = AEG AND labels = auto-implement AND status = Backlog"
    poll_minutes = int(jira_cfg.get("poll_interval_minutes", 10))
    max_parallel = int(jira_cfg.get("max_parallel", 2))

    while True:
        try:
            keys = jira_client.search_for_ready_issues(jql, limit=10)
            if not keys:
                diagnostic = jira_client.diagnose_single_issue_from_jql(jql)
                if diagnostic.get("diagnosis") != "not-single-key":
                    _log({"ts": int(time.time()), "diagnostic": diagnostic})
            _log({"ts": int(time.time()), "found": keys})
            workers: List[threading.Thread] = []
            for key in keys[:max_parallel]:
                worker = threading.Thread(target=_handle_issue, args=(key, cfg), daemon=True)
                worker.start()
                workers.append(worker)
            for worker in workers:
                worker.join()
        except Exception as exc:
            _log({"ts": int(time.time()), "error": str(exc)})
        time.sleep(max(1, poll_minutes) * 60)


if __name__ == "__main__":
    main()
