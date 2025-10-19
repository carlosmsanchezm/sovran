from __future__ import annotations

import os
from typing import Dict

import requests

_GITHUB_API = "https://api.github.com"


def _get_token() -> str:
    for key in ("GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN", "AEGIS_GITHUB_TOKEN"):
        value = os.environ.get(key)
        if value:
            return value
    raise RuntimeError("Missing GitHub authentication token (set GITHUB_PERSONAL_ACCESS_TOKEN)")


def _session(token: str) -> requests.Session:
    sess = requests.Session()
    sess.headers.update(
        {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
    )
    return sess


def _git_ref(owner: str, repo: str, ref: str) -> str:
    return f"{_GITHUB_API}/repos/{owner}/{repo}/git/{ref}"


def _ensure_ok(resp: requests.Response, msg: str) -> None:
    if resp.status_code >= 400:
        raise RuntimeError(f"{msg}: {resp.status_code} {resp.text}")


def open_pr_from_paths(
    *,
    branch: str,
    title: str,
    body: str,
    files: Dict[str, str],
    owner: str,
    repo: str,
    base: str,
) -> str:
    if not files:
        raise ValueError("No files provided for PR")

    token = _get_token()
    sess = _session(token)

    ref_resp = sess.get(_git_ref(owner, repo, f"refs/heads/{base}"))
    _ensure_ok(ref_resp, "Unable to fetch base ref")
    base_sha = ref_resp.json()["object"]["sha"]

    commit_resp = sess.get(_git_ref(owner, repo, f"commits/{base_sha}"))
    _ensure_ok(commit_resp, "Unable to fetch base commit")
    base_tree = commit_resp.json()["tree"]["sha"]

    tree_entries = []
    for path, content in files.items():
        text = content if isinstance(content, str) else str(content)
        blob_resp = sess.post(_git_ref(owner, repo, "blobs"), json={"content": text, "encoding": "utf-8"})
        _ensure_ok(blob_resp, f"Failed to create blob for {path}")
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob_resp.json()["sha"]})

    tree_resp = sess.post(_git_ref(owner, repo, "trees"), json={"base_tree": base_tree, "tree": tree_entries})
    _ensure_ok(tree_resp, "Failed to create tree")
    tree_sha = tree_resp.json()["sha"]

    commit_resp = sess.post(
        _git_ref(owner, repo, "commits"),
        json={"message": title or "automated update", "tree": tree_sha, "parents": [base_sha]},
    )
    _ensure_ok(commit_resp, "Failed to create commit")
    commit_sha = commit_resp.json()["sha"]

    branch = branch.strip().replace(" ", "-")
    ref_url = _git_ref(owner, repo, f"refs/heads/{branch}")
    ref_exists = sess.get(ref_url)
    if ref_exists.status_code == 404:
        create_ref = sess.post(_git_ref(owner, repo, "refs"), json={"ref": f"refs/heads/{branch}", "sha": commit_sha})
        _ensure_ok(create_ref, "Failed to create branch ref")
    else:
        _ensure_ok(ref_exists, "Failed to inspect branch ref")
        update_ref = sess.patch(ref_url, json={"sha": commit_sha, "force": True})
        _ensure_ok(update_ref, "Failed to update branch ref")

    pr_resp = sess.post(
        f"{_GITHUB_API}/repos/{owner}/{repo}/pulls",
        json={"title": title or branch, "head": branch, "base": base, "body": body},
    )
    _ensure_ok(pr_resp, "Failed to open pull request")
    data = pr_resp.json()
    return data.get("html_url") or data.get("url") or ""


__all__ = ["open_pr_from_paths"]
