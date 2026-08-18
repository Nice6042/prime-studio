from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

REPOSITORY = os.environ.get("REPOSITORY", "Nice6042/prime-studio")
TOKEN = os.environ["GH_TOKEN"]
API = "https://api.github.com"
TITLE = "Select and implement the next bounded source-owned Prime Studio acceptance gap"
GENERATION = int(os.environ["GENERATION"])
REQUIRED_COMPLETED = int(os.environ["REQUIRED_COMPLETED"])
DEADLINE = time.time() + int(os.environ.get("QUEUE_SECONDS", str(5 * 60 * 60)))
CONTROLLER_BRANCH = "audit/next-source-slice-controller-20260818"
CONTROLLER_WORKFLOW = ".github/workflows/audit-next-source-slice-controller.yml"
OWN_BRANCH = "audit/source-slices-generation4-5-20260818"
ACTIVE = {"queued", "in_progress", "requested", "waiting", "pending"}


class QueueError(RuntimeError):
    pass


def request(
    method: str,
    path: str,
    payload: Any | None = None,
    *,
    missing_ok: bool = False,
    accept: str = "application/vnd.github+json",
) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "Accept": accept,
        "Authorization": f"Bearer {TOKEN}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": f"prime-studio-source-generation-{GENERATION}",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = response.read()
            return None if not body else json.loads(body.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if missing_ok and exc.code == 404:
            return None
        detail = exc.read().decode("utf-8", "replace")
        raise QueueError(f"{method} {path}: HTTP {exc.code}: {detail[:3000]}") from exc


def comment(number: int, body: str) -> None:
    request("POST", f"/repos/{REPOSITORY}/issues/{number}/comments", {"body": body})


def exact_issues(state: str) -> list[dict[str, Any]]:
    query = urllib.parse.quote(
        f'repo:{REPOSITORY} is:issue is:{state} in:title "{TITLE}"',
        safe="",
    )
    items = request("GET", f"/search/issues?q={query}&per_page=100").get("items", [])
    return [item for item in items if item.get("title") == TITLE]


def linked_merged_pulls(issue_number: int) -> list[dict[str, Any]]:
    timeline = request(
        "GET",
        f"/repos/{REPOSITORY}/issues/{issue_number}/timeline?per_page=100",
        accept="application/vnd.github+json",
    )
    output: list[dict[str, Any]] = []
    for event in timeline:
        if event.get("event") != "cross-referenced":
            continue
        source = ((event.get("source") or {}).get("issue") or {})
        if "pull_request" not in source or not source.get("number"):
            continue
        pull = request(
            "GET",
            f"/repos/{REPOSITORY}/pulls/{int(source['number'])}",
            missing_ok=True,
        )
        if pull and pull.get("merged"):
            output.append(pull)
    return output


def completed_lineage() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    completed: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for item in sorted(exact_issues("closed"), key=lambda value: int(value["number"])):
        pulls = linked_merged_pulls(int(item["number"]))
        if not pulls:
            continue
        issue = request("GET", f"/repos/{REPOSITORY}/issues/{int(item['number'])}")
        pull = max(pulls, key=lambda value: value.get("merged_at") or "")
        completed.append((issue, pull))
    return completed


def generation_marker() -> str:
    return f"## Continuation generation {GENERATION}"


def discover_or_create_issue() -> tuple[dict[str, Any], list[tuple[dict[str, Any], dict[str, Any]]]]:
    deadline = min(DEADLINE, time.time() + 4 * 60 * 60)
    while time.time() < deadline:
        open_matches = exact_issues("open")
        if len(open_matches) > 1:
            raise QueueError(
                f"Multiple open exact-title issues exist: {[item['number'] for item in open_matches]}"
            )
        if open_matches:
            issue = request(
                "GET",
                f"/repos/{REPOSITORY}/issues/{int(open_matches[0]['number'])}",
            )
            if generation_marker() in (issue.get("body") or ""):
                return issue, completed_lineage()
            time.sleep(45)
            continue

        lineage = completed_lineage()
        if len(lineage) < REQUIRED_COMPLETED:
            time.sleep(45)
            continue

        lineage = lineage[-REQUIRED_COMPLETED:]
        main = request("GET", f"/repos/{REPOSITORY}/branches/main")
        main_sha = main["commit"]["sha"]
        lineage_text = ", ".join(
            f"issue #{issue['number']} / PR #{pull['number']}"
            for issue, pull in lineage
        )
        body = f"""{generation_marker()}

{REQUIRED_COMPLETED} bounded post-ED06 source slice(s) have been independently completed: {lineage_text}. Start this new selection only from current `main` `{main_sha}`.

## Mission

Inspect the current acceptance catalog, design documentation, source, tests, open issues, and open pull requests. Select exactly one remaining acceptance gap that is fully source-owned and can be closed with checked-in behavior plus deterministic CI.

Before changing code, comment with the exact acceptance row/identifier and source; the concrete missing behavior; why it is source-owned; what remains unproven; proposed files, tests, and coherent commit sequence; and confirmation that no equivalent issue or PR exists.

Then implement only that selected slice and open a draft PR linked with `Fixes #<this issue>`.

## Selection priority

Prefer crash/restart recovery or authoritative reconciliation; project/chat/document identity and data integrity; local approval/containment/cancellation/replay safety; honest local usage where authoritative data already exists; accessibility/keyboard/deterministic interaction behavior; or bounded performance/resource-control work with executable limits.

## Forbidden authority and drift

Do not select or claim closure for a real user Windows-host run, provider/account authentication or credentials, exact installed Prime closure, a production browser/computer-use worker, installer/signing/updater/release/publication authority, or economic validation. Do not add dependencies, lockfile changes, CI/security changes, package identity changes, or installer/Tauri config changes without stopping for independent re-scope.

Reuse typed boundaries and opaque identities. Preserve stale/replay/cancellation/late-response protections. Keep private content, credentials, full host paths, and environment dumps out of logs, fixtures, comments, and evidence. Use deterministic limits and fail closed on malformed, stale, oversized, unsupported, or unavailable inputs. No browser-storage or permissive fallback. No unrelated redesign or refactor.

Add happy-path and adversarial tests. Run locked frontend tests, frontend build, Rust formatting, locked Clippy with warnings denied, locked all-target Rust tests with `test-support-bin`, and all existing dependency/publication/browser/accessibility/acceptance gates. Preserve original failures and exact repairs.

Keep the PR draft, use coherent commits, state the exact head, and never merge or promote authority based only on the coding agent's own report.
"""
        try:
            issue = request(
                "POST",
                f"/repos/{REPOSITORY}/issues",
                {
                    "title": TITLE,
                    "body": body,
                    "assignees": ["copilot-swe-agent"],
                },
            )
        except QueueError:
            issue = request(
                "POST",
                f"/repos/{REPOSITORY}/issues",
                {"title": TITLE, "body": body},
            )
            try:
                issue = request(
                    "POST",
                    f"/repos/{REPOSITORY}/issues/{int(issue['number'])}/assignees",
                    {"assignees": ["copilot-swe-agent"]},
                )
            except QueueError:
                comment(
                    int(issue["number"]),
                    (
                        "@copilot Please select and implement the bounded source-owned slice described "
                        "above, starting from current `main` and leaving the linked PR in draft."
                    ),
                )
        return issue, lineage
    raise QueueError(
        f"Generation {GENERATION} could not acquire its serial starting point before timeout."
    )


def all_runs() -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    page = 1
    while page <= 10:
        response = request(
            "GET",
            f"/repos/{REPOSITORY}/actions/runs?per_page=100&page={page}",
        )
        batch = response.get("workflow_runs", [])
        output.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return output


def controller_run_from_comment(issue_number: int) -> int | None:
    pattern = re.compile(r"/actions/runs/(\d+)")
    comments = request(
        "GET",
        f"/repos/{REPOSITORY}/issues/{issue_number}/comments?per_page=100",
    )
    marker = f"Exact-head controller queued for continuation generation {GENERATION}"
    for item in reversed(comments):
        body = item.get("body") or ""
        if marker not in body:
            continue
        match = pattern.search(body)
        if match:
            return int(match.group(1))
    return None


def latest_controller_run() -> dict[str, Any]:
    candidates = [
        run for run in all_runs() if run.get("path") == CONTROLLER_WORKFLOW
    ]
    if not candidates:
        raise QueueError("No recorded generic source-slice controller run exists.")
    return max(candidates, key=lambda value: int(value["id"]))


def restore_controller_branch(run: dict[str, Any]) -> None:
    encoded = urllib.parse.quote(CONTROLLER_BRANCH, safe="")
    branch = request(
        "GET",
        f"/repos/{REPOSITORY}/branches/{encoded}",
        missing_ok=True,
    )
    if branch is None:
        request(
            "POST",
            f"/repos/{REPOSITORY}/git/refs",
            {"ref": f"refs/heads/{CONTROLLER_BRANCH}", "sha": run["head_sha"]},
        )
        return
    current = (branch.get("commit") or {}).get("sha")
    if current != run["head_sha"]:
        raise QueueError(
            f"Generic controller branch is at {current}, not recorded controller head {run['head_sha']}."
        )


def wait_terminal(run_id: int) -> dict[str, Any]:
    while time.time() < DEADLINE:
        run = request(
            "GET",
            f"/repos/{REPOSITORY}/actions/runs/{run_id}",
        )
        if run.get("status") not in ACTIVE:
            return run
        time.sleep(45)
    raise QueueError(f"Controller run {run_id} remained active at the queue deadline.")


def ensure_controller(issue: dict[str, Any]) -> dict[str, Any]:
    issue_number = int(issue["number"])
    existing_run_id = controller_run_from_comment(issue_number)
    if existing_run_id is not None:
        return wait_terminal(existing_run_id)

    latest = latest_controller_run()
    restore_controller_branch(latest)
    comment(
        issue_number,
        (
            f"### Exact-head controller queued for continuation generation {GENERATION}\n\n"
            f"The generic controller run {latest.get('html_url')} is being rerun because a new, "
            "independently created source-slice issue now exists. This is a new repository state, "
            "not a blind retry of an unchanged failed head."
        ),
    )
    request(
        "POST",
        f"/repos/{REPOSITORY}/actions/runs/{int(latest['id'])}/rerun",
        {},
    )
    return wait_terminal(int(latest["id"]))


def delete_own_branch() -> None:
    encoded = urllib.parse.quote(OWN_BRANCH, safe="/")
    request(
        "DELETE",
        f"/repos/{REPOSITORY}/git/refs/heads/{encoded}",
        missing_ok=True,
    )


def main() -> int:
    summary: dict[str, Any] = {
        "generation": GENERATION,
        "requiredCompleted": REQUIRED_COMPLETED,
        "startedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    try:
        issue, lineage = discover_or_create_issue()
        summary["lineage"] = [
            {
                "issue": int(item[0]["number"]),
                "pull": int(item[1]["number"]),
                "mergeCommit": item[1].get("merge_commit_sha"),
            }
            for item in lineage
        ]
        summary["issue"] = {
            "number": int(issue["number"]),
            "state": issue.get("state"),
            "url": issue.get("html_url"),
            "assignees": [item.get("login") for item in issue.get("assignees", [])],
        }
        terminal = ensure_controller(issue)
        summary["controller"] = {
            "id": terminal.get("id"),
            "status": terminal.get("status"),
            "conclusion": terminal.get("conclusion"),
            "attempt": terminal.get("run_attempt"),
            "url": terminal.get("html_url"),
        }
        summary["finishedAtUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if terminal.get("conclusion") != "success":
            summary["result"] = "BLOCKED"
            comment(
                int(issue["number"]),
                (
                    f"### Generation {GENERATION} exact-head controller blocked\n\n"
                    f"```json\n{json.dumps(summary, indent=2, sort_keys=True)[:44000]}\n```\n\n"
                    "No merge or unsupported acceptance/authority promotion occurred."
                ),
            )
            print(json.dumps(summary, indent=2, sort_keys=True))
            return 1

        summary["result"] = "CONTROLLER_COMPLETED"
        print(json.dumps(summary, indent=2, sort_keys=True))
        if os.environ.get("DELETE_OWN_BRANCH", "false").lower() == "true":
            delete_own_branch()
        return 0
    except Exception as exc:
        summary["result"] = "BLOCKED"
        summary["error"] = str(exc)
        summary["finishedAtUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        print(json.dumps(summary, indent=2, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
