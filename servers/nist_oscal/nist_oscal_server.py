"""FastMCP server exposing NIST and FedRAMP OSCAL datasets."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

# Add repo root to Python path so we can import servers.mcp_compat
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from mcp.server.fastmcp import FastMCP

# Apply MCP JSON-RPC compatibility shim for legacy Codex clients.
# import servers.mcp_compat  # noqa: F401


mcp = FastMCP("NIST-OSCAL")

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OSCAL_ROOT = REPO_ROOT / "third_party"

CATALOG_PATH = Path(
    os.environ.get(
        "OSCAL_CATALOG",
        DEFAULT_OSCAL_ROOT
        / "oscal-content/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json",
    )
)
DOCS_CATALOG_PATH = REPO_ROOT / "docs" / "oscal" / "nist_sp_800_53_rev5_catalog.json"
if not CATALOG_PATH.is_file() and DOCS_CATALOG_PATH.is_file():
    CATALOG_PATH = DOCS_CATALOG_PATH
FEDRAMP_BASELINES_DIR = Path(
    os.environ.get(
        "FEDRAMP_BASELINES_DIR",
        DEFAULT_OSCAL_ROOT
        / "fedramp-automation/dist/content/rev5/baselines/json",
    )
)
DOCS_BASELINES_DIR = (
    REPO_ROOT
    / "third_party"
    / "fedramp-automation"
    / "dist"
    / "content"
    / "rev5"
    / "baselines"
    / "json"
)
if not FEDRAMP_BASELINES_DIR.exists() and DOCS_BASELINES_DIR.exists():
    FEDRAMP_BASELINES_DIR = DOCS_BASELINES_DIR


def _load_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _load_catalog() -> Dict[str, Any]:
    try:
        return _load_json(CATALOG_PATH)
    except FileNotFoundError as exc:
        raise SystemExit(
            "OSCAL catalog not found. Set OSCAL_CATALOG or run scripts/fetch_oscal_content.sh"
        ) from exc


CATALOG = _load_catalog()
print(f"[NIST_OSCAL] catalog loaded from {CATALOG_PATH}", file=sys.stderr)


def _control_aliases(control: Dict[str, Any]) -> List[str]:
    aliases: List[str] = []
    control_id = control.get("id")
    if isinstance(control_id, str):
        aliases.append(control_id.lower().replace("(", ".").replace(")", ""))
    props = control.get("props")
    if isinstance(props, list):
        for prop in props:
            if prop.get("name") == "label" and isinstance(prop.get("value"), str):
                aliases.append(prop["value"].lower())
    return aliases


def _index_controls(catalog: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    index: Dict[str, Dict[str, Any]] = {}

    def walk(controls: List[Dict[str, Any]]) -> None:
        for control in controls:
            cid = control.get("id")
            if not isinstance(cid, str):
                continue
            normalized = cid.lower()
            index[normalized] = control
            for alias in _control_aliases(control):
                index[alias] = control
            nested = control.get("controls")
            if isinstance(nested, list):
                walk(nested)

    for group in catalog.get("catalog", {}).get("groups", []):
        controls = group.get("controls")
        if isinstance(controls, list):
            walk(controls)

    return index


CONTROL_INDEX = _index_controls(CATALOG)


def _load_baseline_json(name: str) -> Dict[str, Any]:
    target = name.lower()
    for candidate in sorted(FEDRAMP_BASELINES_DIR.glob("*.json")):
        candidate_name = candidate.name.lower()
        if target in candidate_name or target.replace("-", "_") in candidate_name:
            return _load_json(candidate)
    raise FileNotFoundError(f"Baseline '{name}' not found under {FEDRAMP_BASELINES_DIR}")


def _extract_control_id(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("control_id", "id", "control"):
            candidate = value.get(key)
            if isinstance(candidate, str):
                return candidate
        raise TypeError("control identifier dict must include a string 'control_id' or 'id'")

    if isinstance(value, str):
        raw = value.strip()
        if raw.startswith("{") and raw.endswith("}"):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                return raw
            return _extract_control_id(parsed)
        return raw

    raise TypeError("control identifier must be a string or mapping")


@mcp.tool()
def get_control(control_id: Any) -> Dict[str, Any]:
    """Return control metadata (title, params, parts) for a NIST 800-53 control."""

    resolved = _extract_control_id(control_id)
    normalized = resolved.lower().strip()
    control = CONTROL_INDEX.get(normalized)
    if control is None:
        return {"found": False, "id": resolved}

    return {
        "found": True,
        "id": control.get("id"),
        "title": control.get("title"),
        "class": control.get("class"),
        "params": control.get("params", []),
        "parts": control.get("parts", []),
    }


@mcp.tool()
def in_fedramp_baseline(control_id: Any, level: str = "high") -> Dict[str, Any]:
    """Return whether the control is included in a FedRAMP Rev5 baseline."""

    if level not in {"low", "moderate", "high"}:
        raise ValueError("level must be 'low', 'moderate', or 'high'")

    resolved = _extract_control_id(control_id)
    try:
        baseline = _load_baseline_json(f"FedRAMP_rev5_{level.upper()}-baseline_profile")
    except FileNotFoundError as exc:
        return {
            "control": resolved,
            "baseline": level,
            "selected": False,
            "error": str(exc),
        }

    selected: List[str] = []
    profile = baseline.get("profile", {})
    for imp in profile.get("imports", []):
        include_blocks: List[Any] = []
        if "include" in imp:
            include_blocks.append(imp["include"])
        if "include-controls" in imp:
            include = imp.get("include-controls")
            if isinstance(include, list):
                include_blocks.extend(include)
            else:
                include_blocks.append(include)

        for block in include_blocks:
            if isinstance(block, dict):
                controls = block.get("controls")
                if isinstance(controls, list):
                    entries = controls
                else:
                    entries = [block]
                for entry in entries:
                    ids = entry.get("with-ids", []) if isinstance(entry, dict) else []
                    for cid in ids:
                        if isinstance(cid, str):
                            selected.append(cid.lower())

    normalized = resolved.lower().strip()
    return {
        "control": normalized,
        "baseline": level,
        "selected": normalized in selected,
        "selected_ids": selected,
    }


if __name__ == "__main__":
    mcp.run()
