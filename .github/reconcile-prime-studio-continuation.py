from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

REPOSITORY = os.environ.get("REPOSITORY", "Nice6042/prime-studio")
TOKEN = os.environ["GH_TOKEN"]
API = "https://api.github.com"
DEADLINE = time.time() + int(os.environ.get("RECONCILE_SECONDS", str(5 * 60 * 60)))
OWN_BRANCH = "audit/reconcile-continuation-20260818"

HOST_PR = 20
HOST_EXPECTED_HEAD = "8574308d47be0227594db39d338971037cc861a3"
HOST_FILES = {
    ".github/workflows/ci.yml",
    "app/scripts/windows-host-verification/Collect-WindowsHostPreflight.ps1",
    "app/scripts/windows-host-verification/New-WindowsHostEvidenceBundle.ps1",
    "app/scripts/windows-host-verification/Test-WindowsHostVerificationKit.ps1",
    "app/scripts/windows-host-verification/WindowsHostVerification.psm1",
    "docs/windows-host-preflight.schema.json",
    "docs/windows-host-review-template.md",
    "docs/windows-host-verification.md",
    "tests/windows-host-verification-kit.test.mjs",
}

ED06_ISSUE = 21
ED06_PR = 22
ED06_CONTROLLER = {
    "name": "ED-06 native-draft controller",
    "branch": "audit/ed06-native-drafts-controller-20260818",
    "workflow": ".github/workflows/audit-ed06-native-drafts-controller.yml",
}
NEXT_TITLE = "Select and implement the next bounded source-owned Prime Studio acceptance gap"
NEXT_CONTROLLER = {
    "name": "next source-slice controller",
    "branch": "audit/next-source-slice-controller-20260818",
    "workflow": ".github/workflows/audit-next-source-slice-controller.yml",
}

EXPECTED_CHECKS = {
    "Source policy and acceptance",
    "Frontend checks",
    "Rust checks (Windows)",
    "Strict browser shell",
    "npm audit",
    "Locked dependency policy",
    "Dependency review",
}
PASSING_CONCLUSIONS = {"success", "neutral", "skipped"}
ACTIVE_RUN_STATES = {"queued", "in_progress", "requested", "waiting", "pending"}
INFRASTRUCTURE_CONCLUSIONS = {
    "cancelled",
    "timed_out",
    "startup_failure",
    "action_required",
    "stale",
}


class ReconcileError(RuntimeError):
    pass


@dataclass
class ControllerOutcome:
    state: str
    run: dict[str, Any] | None
    detail: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "run": None
            if self.run is None
            else {
                "id": self.run.get("id"),
                "status": self.run.get("status"),
                "conclusion": self.run.get("conclusion"),
                "attempt": self.run.get("run_attempt"),
                "headSha": self.run.get("head_sha"),
                "url": self.run.get("html_url"),
                "updatedAt": self.run.get("updated_at"),
            },
            "detail": self.detail,
        }


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


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
        "User-Agent": "prime-studio-continuation-reconciler",
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
        raise ReconcileError(f"{method} {path}: HTTP {exc.code}: {detail[:4000]}") from exc


def bounded_json(value: Any, limit: int = 45_000) -> str:
    text = json.dumps(value, indent=2, sort_keys=True)
    if len(text) <= limit:
        return text
    return text[: limit - 200] + "\n... <TRUNCATED> ..."


def comment(number: int, heading: str, payload: Any, footer: str = "") -> None:
    body = f"### {heading}\n\n```json\n{bounded_json(payload)}\n```"
    if footer:
        body += f"\n\n{footer}"
    request("POST", f"/repos/{REPOSITORY}/issues/{number}/comments", {"body": body})


def get_pull(number: int) -> dict[str, Any] | None:
    return request("GET", f"/repos/{REPOSITORY}/pulls/{number}", missing_ok=True)


def get_issue(number: int) -> dict[str, Any] | None:
    return request("GET", f"/repos/{REPOSITORY}/issues/{number}", missing_ok=True)


def main_sha() -> str:
    return str(request("GET", f"/repos/{REPOSITORY}/branches/main")["commit"]["sha"])


def pull_files(number: int) -> list[str]:
    output: list[str] = []
    page = 1
    while True:
        batch = request("GET", f"/repos/{REPOSITORY}/pulls/{number}/files?per_page=100&page={page}")
        output.extend(str(item["filename"]) for item in batch)
        if len(batch) < 100:
            return output
        page += 1


def latest_check_runs(sha: str) -> dict[str, dict[str, Any]]:
    all_runs: list[dict[str, Any]] = []
    page = 1
    while True:
        response = request(
            "GET",
            f"/repos/{REPOSITORY}/commits/{sha}/check-runs?per_page=100&page={page}",
        )
        batch = response.get("check_runs", [])
        all_runs.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    latest: dict[str, dict[str, Any]] = {}
    for run in all_runs:
        name = str(run["name"])
        if name not in latest or int(run["id"]) > int(latest[name]["id"]):
            latest[name] = run
    return latest


def check_snapshot(sha: str) -> dict[str, Any]:
    latest = latest_check_runs(sha)
    missing = sorted(EXPECTED_CHECKS - set(latest))
    pending = sorted(name for name, run in latest.items() if run.get("status") != "completed")
    failing = {
        name: {
            "status": run.get("status"),
            "conclusion": run.get("conclusion"),
            "url": run.get("html_url"),
        }
        for name, run in sorted(latest.items())
        if run.get("status") == "completed"
        and run.get("conclusion") not in PASSING_CONCLUSIONS
    }
    bad_expected = {
        name: {
            "status": latest[name].get("status"),
            "conclusion": latest[name].get("conclusion"),
            "url": latest[name].get("html_url"),
        }
        for name in sorted(EXPECTED_CHECKS & set(latest))
        if latest[name].get("status") != "completed"
        or latest[name].get("conclusion") not in PASSING_CONCLUSIONS
    }
    return {
        "missingExpected": missing,
        "pendingLatest": pending,
        "failingLatest": failing,
        "expectedNotPassing": bad_expected,
        "latest": {
            name: {
                "id": run.get("id"),
                "status": run.get("status"),
                "conclusion": run.get("conclusion"),
                "url": run.get("html_url"),
            }
            for name, run in sorted(latest.items())
        },
    }


def wait_checks(sha: str, seconds: int = 90 * 60) -> dict[str, Any]:
    deadline = min(DEADLINE, time.time() + seconds)
    last: dict[str, Any] = {}
    while time.time() < deadline:
        last = check_snapshot(sha)
        if last["failingLatest"]:
            return {"state": "failed", "snapshot": last}
        if not last["missingExpected"] and not last["pendingLatest"] and not last["expectedNotPassing"]:
            statuses = request("GET", f"/repos/{REPOSITORY}/commits/{sha}/status")
            if statuses.get("statuses") and statuses.get("state") in {"failure", "error", "pending"}:
                return {
                    "state": "commit-status-not-successful",
                    "snapshot": last,
                    "commitStatus": statuses.get("state"),
                }
            return {"state": "passed", "snapshot": last}
        time.sleep(20)
    return {"state": "timeout", "snapshot": last}


def ensure_host_kit() -> dict[str, Any]:
    pull = get_pull(HOST_PR)
    if pull is None:
        raise ReconcileError("Host-verification PR #20 is missing.")
    if pull.get("merged"):
        for path in HOST_FILES - {".github/workflows/ci.yml"}:
            encoded = urllib.parse.quote(path, safe="/")
            request("GET", f"/repos/{REPOSITORY}/contents/{encoded}?ref=main")
        return {
            "state": "merged",
            "mergeCommit": pull.get("merge_commit_sha"),
            "main": main_sha(),
        }
    if pull.get("state") != "open":
        raise ReconcileError("Host-verification PR #20 is closed without a recorded merge.")
    if (pull.get("head") or {}).get("sha") != HOST_EXPECTED_HEAD:
        raise ReconcileError(
            f"Host-verification head changed: {(pull.get('head') or {}).get('sha')}."
        )
    files = pull_files(HOST_PR)
    if len(files) != len(HOST_FILES) or set(files) != HOST_FILES:
        raise ReconcileError(f"Host-verification diff changed: {sorted(files)}")
    checks = wait_checks(HOST_EXPECTED_HEAD, 100 * 60)
    if checks["state"] != "passed":
        raise ReconcileError(f"Host-verification checks are not passing: {bounded_json(checks)}")
    result = request(
        "PUT",
        f"/repos/{REPOSITORY}/pulls/{HOST_PR}/merge",
        {
            "sha": HOST_EXPECTED_HEAD,
            "merge_method": "squash",
            "commit_title": "Add clean Windows host verification and redacted evidence kit (#20)",
            "commit_message": (
                "Add fail-closed Windows preflight and bounded, pseudonymous redacted evidence tooling.\n\n"
                "Source tooling only: no user-host, installed Prime, provider-session, interaction-worker, "
                "signing, credential, or release attestation."
            ),
        },
    )
    if not result.get("merged"):
        raise ReconcileError(f"Host-verification merge was rejected: {bounded_json(result)}")
    return {"state": "merged-now", "mergeCommit": result.get("sha"), "main": main_sha()}


def all_workflow_runs() -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    page = 1
    while page <= 10:
        response = request("GET", f"/repos/{REPOSITORY}/actions/runs?per_page=100&page={page}")
        batch = response.get("workflow_runs", [])
        output.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return output


def latest_controller_run(controller: dict[str, str]) -> dict[str, Any] | None:
    candidates = [
        run
        for run in all_workflow_runs()
        if run.get("path") == controller["workflow"]
    ]
    return max(candidates, key=lambda run: int(run["id"])) if candidates else None


def wait_run_terminal(run_id: int, seconds: int = 150 * 60) -> dict[str, Any]:
    deadline = min(DEADLINE, time.time() + seconds)
    last: dict[str, Any] = {}
    while time.time() < deadline:
        last = request("GET", f"/repos/{REPOSITORY}/actions/runs/{run_id}")
        if last.get("status") not in ACTIVE_RUN_STATES:
            return last
        time.sleep(45)
    raise ReconcileError(f"Workflow run {run_id} was still active at the reconciliation deadline.")


def branch_payload(branch: str) -> dict[str, Any] | None:
    encoded = urllib.parse.quote(branch, safe="")
    return request("GET", f"/repos/{REPOSITORY}/branches/{encoded}", missing_ok=True)


def restore_controller_branch(controller: dict[str, str], sha: str) -> None:
    current = branch_payload(controller["branch"])
    if current is not None:
        current_sha = str((current.get("commit") or {}).get("sha"))
        if current_sha != sha:
            raise ReconcileError(
                f"{controller['name']} branch exists at {current_sha}, not recorded run head {sha}."
            )
        return
    request(
        "POST",
        f"/repos/{REPOSITORY}/git/refs",
        {"ref": f"refs/heads/{controller['branch']}", "sha": sha},
    )


def rerun_controller(controller: dict[str, str], run: dict[str, Any], reason: str) -> dict[str, Any]:
    restore_controller_branch(controller, str(run["head_sha"]))
    request("POST", f"/repos/{REPOSITORY}/actions/runs/{int(run['id'])}/rerun", {})
    return wait_run_terminal(int(run["id"]), 180 * 60)


def issue_comments(number: int) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    page = 1
    while True:
        batch = request("GET", f"/repos/{REPOSITORY}/issues/{number}/comments?per_page=100&page={page}")
        output.extend(batch)
        if len(batch) < 100:
            return output
        page += 1


def latest_blocked_head(number: int) -> str | None:
    patterns = [
        re.compile(r'"head"\s*:\s*"([0-9a-f]{40})"', re.IGNORECASE),
        re.compile(r'"auditedHead"\s*:\s*"([0-9a-f]{40})"', re.IGNORECASE),
        re.compile(r"exact head `([0-9a-f]{40})`", re.IGNORECASE),
    ]
    for item in reversed(issue_comments(number)):
        body = item.get("body") or ""
        if "BLOCKED" not in body and "TERMINAL_BLOCK" not in body:
            continue
        for pattern in patterns:
            match = pattern.search(body)
            if match:
                return match.group(1).lower()
    return None


def linked_pull_candidates(issue_number: int) -> dict[int, dict[str, Any]]:
    candidates: dict[int, dict[str, Any]] = {}
    try:
        timeline = request(
            "GET",
            f"/repos/{REPOSITORY}/issues/{issue_number}/timeline?per_page=100",
            accept="application/vnd.github+json",
        )
        for event in timeline:
            if event.get("event") != "cross-referenced":
                continue
            source = ((event.get("source") or {}).get("issue") or {})
            if "pull_request" not in source or not source.get("number"):
                continue
            pull = get_pull(int(source["number"]))
            if pull and pull.get("state") == "open":
                candidates[int(pull["number"])] = pull
    except ReconcileError:
        pass
    pulls = request("GET", f"/repos/{REPOSITORY}/pulls?state=open&per_page=100")
    markers = [f"#{issue_number}", f"/issues/{issue_number}"]
    for pull in pulls:
        text = f"{pull.get('title') or ''}\n{pull.get('body') or ''}".lower()
        if any(marker.lower() in text for marker in markers):
            candidates[int(pull["number"])] = pull
    return candidates


def controller_state_advanced(
    *,
    controller: dict[str, str],
    run: dict[str, Any],
    issue_number: int,
    current_pull: dict[str, Any] | None,
    state_marker: str,
) -> tuple[bool, dict[str, Any]]:
    blocked_head = latest_blocked_head(issue_number)
    current_head = None if current_pull is None else (current_pull.get("head") or {}).get("sha")
    infrastructure = run.get("conclusion") in INFRASTRUCTURE_CONCLUSIONS
    head_advanced = bool(blocked_head and current_head and blocked_head.lower() != current_head.lower())
    no_prior_head_but_new_state = blocked_head is None and bool(state_marker)
    detail = {
        "blockedHead": blocked_head,
        "currentHead": current_head,
        "infrastructureConclusion": infrastructure,
        "headAdvanced": head_advanced,
        "stateMarker": state_marker,
        "runConclusion": run.get("conclusion"),
        "runAttempt": run.get("run_attempt"),
    }
    return infrastructure or head_advanced or no_prior_head_but_new_state, detail


def ensure_controller(
    *,
    controller: dict[str, str],
    issue_number: int,
    current_pull: dict[str, Any] | None,
    state_marker: str,
) -> ControllerOutcome:
    run = latest_controller_run(controller)
    if run is None:
        return ControllerOutcome(
            "missing-run",
            None,
            {"reason": f"No recorded run exists for {controller['workflow']}."},
        )
    if run.get("status") in ACTIVE_RUN_STATES:
        run = wait_run_terminal(int(run["id"]), 180 * 60)
    if run.get("conclusion") == "success":
        return ControllerOutcome("success", run, {})

    allowed, detail = controller_state_advanced(
        controller=controller,
        run=run,
        issue_number=issue_number,
        current_pull=current_pull,
        state_marker=state_marker,
    )
    if not allowed:
        return ControllerOutcome("terminal-block", run, detail)

    notice = {
        "controller": controller["name"],
        "reason": (
            "infrastructure failure"
            if detail["infrastructureConclusion"]
            else "repository state advanced since the recorded block"
        ),
        **detail,
        "previousRun": run.get("html_url"),
    }
    comment(
        issue_number,
        f"Bounded rerun of {controller['name']}",
        notice,
        "The same unchanged failed source head is not being reinterpreted as passing.",
    )
    rerun = rerun_controller(controller, run, notice["reason"])
    if rerun.get("conclusion") == "success":
        return ControllerOutcome("success-after-bounded-rerun", rerun, notice)
    return ControllerOutcome(
        "blocked-after-bounded-rerun",
        rerun,
        {**notice, "rerunConclusion": rerun.get("conclusion")},
    )


def ensure_ed06() -> dict[str, Any]:
    issue = get_issue(ED06_ISSUE)
    if issue is None:
        raise ReconcileError("ED-06 issue #21 is missing.")
    pull = get_pull(ED06_PR)
    if pull and pull.get("merged"):
        return {
            "state": "merged",
            "issueState": issue.get("state"),
            "head": (pull.get("head") or {}).get("sha"),
            "mergeCommit": pull.get("merge_commit_sha"),
            "main": main_sha(),
        }
    if pull is None:
        candidates = linked_pull_candidates(ED06_ISSUE)
        if len(candidates) == 1:
            pull = next(iter(candidates.values()))
        elif len(candidates) > 1:
            raise ReconcileError(f"Multiple ED-06 PR candidates exist: {sorted(candidates)}")
    if pull is None:
        state_marker = f"issue-updated:{issue.get('updated_at')}"
        outcome = ensure_controller(
            controller=ED06_CONTROLLER,
            issue_number=ED06_ISSUE,
            current_pull=None,
            state_marker=state_marker,
        )
        return {
            "state": "no-pull",
            "controller": outcome.as_dict(),
            "issueState": issue.get("state"),
        }
    if pull.get("state") != "open":
        raise ReconcileError(
            f"ED-06 pull request #{pull.get('number')} is closed without merge."
        )
    outcome = ensure_controller(
        controller=ED06_CONTROLLER,
        issue_number=ED06_ISSUE,
        current_pull=pull,
        state_marker=f"open-pr:{pull.get('number')}:{(pull.get('head') or {}).get('sha')}",
    )
    refreshed = get_pull(int(pull["number"]))
    if refreshed and refreshed.get("merged"):
        return {
            "state": "merged-after-controller",
            "controller": outcome.as_dict(),
            "head": (refreshed.get("head") or {}).get("sha"),
            "mergeCommit": refreshed.get("merge_commit_sha"),
            "main": main_sha(),
        }
    return {
        "state": "still-open",
        "controller": outcome.as_dict(),
        "pullRequest": int(pull["number"]),
        "head": (refreshed or pull).get("head", {}).get("sha"),
        "draft": (refreshed or pull).get("draft"),
    }


def exact_next_issue() -> dict[str, Any] | None:
    query = urllib.parse.quote(
        f'repo:{REPOSITORY} is:issue is:open in:title "{NEXT_TITLE}"',
        safe="",
    )
    results = request("GET", f"/search/issues?q={query}&per_page=50").get("items", [])
    matches = [item for item in results if item.get("title") == NEXT_TITLE]
    if len(matches) > 1:
        raise ReconcileError(f"Multiple open next-slice issues exist: {[item['number'] for item in matches]}")
    if not matches:
        return None
    return get_issue(int(matches[0]["number"]))


def create_next_issue() -> dict[str, Any]:
    body = """## Starting point

Start only from the current `main` after the native restart-draft work is merged. Do not use a stale coding-agent or audit branch.

## Mission

Inspect the current acceptance catalog, design docs, source, tests, open issues, and open pull requests. Select exactly one remaining acceptance gap that is fully source-owned and can be closed with checked-in behavior plus deterministic CI.

Before changing code, comment with: the exact acceptance row/identifier and source; the concrete missing behavior; why the slice is source-owned; what remains unproven; proposed files/tests/commit sequence; and confirmation that no equivalent issue or PR exists.

Then implement only that selected slice and open a draft PR linked with `Fixes #<this issue>`.

## Preferred source-owned gaps

Prefer restart/recovery or authoritative reconciliation; identity/data integrity; local approval/containment/cancellation/replay safety; honest local usage presentation where authoritative data already exists; accessibility/keyboard/deterministic interaction behavior; or bounded performance/resource control with executable limits.

## Forbidden selections and authority

Do not select or claim closure for a real Windows-host run, provider/account authentication or credentials, exact installed Prime closure, a production browser/computer-use worker, installer/signing/updater/release/publication authority, or economic validation. Do not add dependencies, lockfile changes, CI/security changes, package identity changes, or installer/Tauri config changes without stopping for independent re-scope.

Do not promote a partial row by inference. External rows remain partial, unavailable, or unattested.

## Required implementation discipline

Reuse typed boundaries and opaque identities. Preserve stale/replay/cancellation/late-response protections. Keep private content, credentials, full host paths, and environment dumps out of logs, fixtures, comments, and evidence. Use deterministic limits and fail closed on malformed, stale, oversized, unsupported, or unavailable inputs. No browser-storage or permissive fallback to bypass native authority. No unrelated redesign or refactor.

Add targeted happy-path and adversarial tests. Run locked frontend tests, frontend build, Rust formatting, locked Clippy with warnings denied, locked all-target Rust tests with `test-support-bin`, and all existing dependency/publication/browser/accessibility/acceptance gates. Record original failures and exact repairs.

Keep the PR draft, use coherent commits, state the exact head, and never merge or promote authority based only on the coding agent's own report.
"""
    try:
        return request(
            "POST",
            f"/repos/{REPOSITORY}/issues",
            {
                "title": NEXT_TITLE,
                "body": body,
                "assignees": ["copilot-swe-agent"],
            },
        )
    except ReconcileError:
        issue = request(
            "POST",
            f"/repos/{REPOSITORY}/issues",
            {"title": NEXT_TITLE, "body": body},
        )
        try:
            request(
                "POST",
                f"/repos/{REPOSITORY}/issues/{int(issue['number'])}/assignees",
                {"assignees": ["copilot-swe-agent"]},
            )
        except ReconcileError:
            request(
                "POST",
                f"/repos/{REPOSITORY}/issues/{int(issue['number'])}/comments",
                {
                    "body": (
                        "@copilot Please perform the bounded selection and implementation in this issue, "
                        "starting from current `main` and leaving the linked pull request in draft."
                    )
                },
            )
        return get_issue(int(issue["number"])) or issue


def wait_for_next_issue_or_create() -> dict[str, Any]:
    issue = exact_next_issue()
    if issue is not None:
        return issue
    return create_next_issue()


def ensure_next_slice() -> dict[str, Any]:
    issue = wait_for_next_issue_or_create()
    issue_number = int(issue["number"])
    candidates = linked_pull_candidates(issue_number)
    if len(candidates) > 1:
        raise ReconcileError(f"Multiple next-slice PR candidates exist: {sorted(candidates)}")
    pull = next(iter(candidates.values())) if candidates else None
    outcome = ensure_controller(
        controller=NEXT_CONTROLLER,
        issue_number=issue_number,
        current_pull=pull,
        state_marker=(
            f"open-pr:{pull.get('number')}:{(pull.get('head') or {}).get('sha')}"
            if pull
            else f"issue-ready:{issue_number}:{issue.get('updated_at')}"
        ),
    )
    if pull:
        refreshed = get_pull(int(pull["number"]))
        if refreshed and refreshed.get("merged"):
            return {
                "state": "merged",
                "issue": issue_number,
                "pullRequest": int(pull["number"]),
                "head": (refreshed.get("head") or {}).get("sha"),
                "mergeCommit": refreshed.get("merge_commit_sha"),
                "controller": outcome.as_dict(),
                "main": main_sha(),
            }
    return {
        "state": "waiting-or-blocked",
        "issue": issue_number,
        "pullRequest": None if pull is None else int(pull["number"]),
        "head": None if pull is None else (pull.get("head") or {}).get("sha"),
        "controller": outcome.as_dict(),
    }


def cleanup_own_branch() -> None:
    encoded = urllib.parse.quote(OWN_BRANCH, safe="/")
    try:
        request("DELETE", f"/repos/{REPOSITORY}/git/refs/heads/{encoded}", missing_ok=True)
    except ReconcileError as exc:
        print(f"Own-branch cleanup warning: {exc}", file=sys.stderr)


def main() -> int:
    summary: dict[str, Any] = {
        "startedAtUtc": utc_now(),
        "repository": REPOSITORY,
    }
    try:
        summary["hostKit"] = ensure_host_kit()
        summary["ed06"] = ensure_ed06()
        if not str(summary["ed06"].get("state", "")).startswith("merged"):
            raise ReconcileError(
                "ED-06 is not merged; the next source slice will not be allowed to race it."
            )
        summary["nextSlice"] = ensure_next_slice()
        summary["result"] = (
            "COMPLETED"
            if summary["nextSlice"].get("state") == "merged"
            else "ACTIVE_OR_BLOCKED"
        )
        summary["main"] = main_sha()
        summary["finishedAtUtc"] = utc_now()
        target = int(summary["nextSlice"].get("issue") or ED06_ISSUE)
        comment(
            target,
            "Continuation reconciler snapshot",
            summary,
            "No unchanged failed head was blindly retried and no external authority was promoted.",
        )
        print(bounded_json(summary), flush=True)
        if summary["result"] == "COMPLETED":
            cleanup_own_branch()
            return 0
        return 2
    except Exception as exc:
        summary["result"] = "BLOCKED"
        summary["error"] = str(exc)
        summary["main"] = main_sha()
        summary["finishedAtUtc"] = utc_now()
        try:
            comment(
                ED06_ISSUE,
                "Continuation reconciler blocked",
                summary,
                "No merge, source-status promotion, provider/session claim, host claim, worker claim, signing claim, or release claim was invented.",
            )
        except Exception:
            pass
        print(bounded_json(summary), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
