#!/usr/bin/env python3
"""Dependency-aware dispatcher; GitHub is authoritative, reservations are durable.

This module uses only Python's standard library. Provider containers cannot access
its state or GitHub credentials. Organizer output is data, never executable code.
"""
from __future__ import annotations
import argparse
import base64
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import quote


class SchedulerError(RuntimeError):
    pass


def log(message):
    print(f"{dt.datetime.now(dt.timezone.utc).isoformat()} [aiws] {message}", file=sys.stderr, flush=True)


def secret(name):
    filename = os.environ.get(name + "_FILE")
    value = Path(filename).read_text().strip() if filename else os.environ.get(name, "").strip()
    if "\n" in value or "\r" in value:
        raise SchedulerError("Invalid multiline credential")
    return value


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".aiws-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def workflow_name(variable, default):
    """Workflow file names come from the environment; only a plain file name may reach a URL."""
    workflow = os.environ.get(variable, default)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", workflow):
        raise SchedulerError("Invalid workflow name")
    return workflow


class GitHub:
    def __init__(self, repository):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise SchedulerError("Invalid repository")
        self.repository = repository
        self.token = secret("AIWS_AUTOMATION_TOKEN") or secret("AIWS_PROJECT_TOKEN")
        if not self.token:
            raise SchedulerError("Scheduler requires AIWS_AUTOMATION_TOKEN_FILE or AIWS_AUTOMATION_TOKEN")
        # (issue, labels, updated_at) -> trust; a new label event always changes updated_at.
        self._trusted = {}

    def api(self, path, data=None, method=None):
        args = ["gh", "api", "-H", "Accept: application/vnd.github+json", "-H",
                "X-GitHub-Api-Version: " + os.environ.get("AIWS_GITHUB_API_VERSION", "2026-03-10"), path]
        if method:
            args += ["--method", method]
        if data is not None:
            args += ["--input", "-"]
        env = {key: value for key, value in os.environ.items()
               if key not in ("GH_TOKEN", "GITHUB_TOKEN", "AIWS_AUTOMATION_TOKEN", "AIWS_PROJECT_TOKEN")}
        env["GH_TOKEN"] = self.token
        result = subprocess.run(args, input=json.dumps(data) if data is not None else None,
                                text=True, capture_output=True, env=env, timeout=120)
        if result.returncode:
            raise SchedulerError(result.stderr.strip().replace(self.token, "[redacted]")[:1000] or "GitHub command failed")
        return json.loads(result.stdout) if result.stdout.strip() else None

    def pages(self, path, key=None):
        separator = "&" if "?" in path else "?"
        page = 1
        while True:
            response = self.api(f"{path}{separator}per_page=100&page={page}")
            items = response[key] if key else response
            if not isinstance(items, list):
                raise SchedulerError("Unexpected paginated API response")
            yield from items
            if len(items) < 100:
                return
            page += 1

    def trusted_label(self, issue, labels, config, updated_at=None):
        allowed = {actor.lower() for actor in config['security']['allowedActors']}
        if '*' in allowed:
            return True
        key = (issue, frozenset(labels), frozenset(allowed), updated_at)
        if updated_at and key in self._trusted:
            return self._trusted[key]
        latest = {}
        for event in self.pages(self.repo(f'issues/{issue}/events')):
            label = (event.get('label') or {}).get('name')
            if label in labels and event.get('event') == 'labeled':
                latest[label] = (event.get('actor') or {}).get('login', '').lower()
        trusted = any(actor in allowed for actor in latest.values())
        if updated_at:
            if len(self._trusted) > 5000:
                self._trusted.clear()
            self._trusted[key] = trusted
        return trusted

    def repo(self, suffix):
        return f"repos/{self.repository}/{suffix}"

    def dependencies(self, issue):
        return list(self.pages(self.repo(f"issues/{issue}/dependencies/blocked_by")))

    def project_items(self, config):
        with tempfile.TemporaryDirectory(prefix="aiws-project-") as directory:
            path = Path(directory) / "config.json"
            atomic_json(path, config)
            env = dict(os.environ, AIWS_CONFIG_PATH=str(path), AIWS_REPOSITORY=self.repository,
                       AIWS_AUTOMATION_TOKEN=self.token,
                       AIWS_PROJECT_TOKEN=secret("AIWS_PROJECT_TOKEN") or self.token)
            result = subprocess.run(["/opt/aiws/bin/project.sh", "items"], capture_output=True,
                                    text=True, env=env, timeout=180)
            if result.returncode:
                raise SchedulerError("Project snapshot failed; no tasks dispatched")
            return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]

    def labels(self, issue, *, add=(), remove=()):
        if add:
            self.api(self.repo(f"issues/{issue}/labels"), {"labels": list(add)}, "POST")
        for label in remove:
            self.api(self.repo(f"issues/{issue}/labels/{quote(label, safe='')}"), method="DELETE")

    def dispatch(self, workflow, branch, issue, dispatch_id):
        return self.api(self.repo(f"actions/workflows/{quote(workflow, safe='')}/dispatches"),
                        {"ref": branch, "inputs": {"issue_number": str(issue), "dispatch_id": dispatch_id}}, "POST")

    def active_issues(self):
        workflow = workflow_name('AIWS_RUN_WORKFLOW', 'aiws-agent-task.yml')
        active = set()
        for status in ('queued', 'in_progress', 'waiting', 'pending', 'requested'):
            for run in self.pages(self.repo(f'actions/workflows/{workflow}/runs?event=workflow_dispatch&status={status}'), 'workflow_runs'):
                match = re.match(r'^AIWS issue #(\d+)(?:\s|$)', run.get('display_title', ''))
                if match and run.get('status') != 'completed':
                    active.add(int(match[1]))
        return active


def issue_labels(issue):
    return {label["name"] if isinstance(label, dict) else label for label in issue.get("labels", [])}


def graph_cycles(graph):
    """Return cyclic nodes and every task transitively depending on them."""
    nodes = set(graph) | {blocker for blockers in graph.values() for blocker in blockers}
    pending = {node: len(set(graph.get(node, []))) for node in nodes}
    dependents = {node: set() for node in nodes}
    for node, blockers in graph.items():
        for blocker in blockers:
            dependents[blocker].add(node)
    ready = [node for node in nodes if pending[node] == 0]
    while ready:
        node = ready.pop()
        for dependent in dependents[node]:
            pending[dependent] -= 1
            if pending[dependent] == 0:
                ready.append(dependent)
    return {node for node, count in pending.items() if count > 0}


def validate_plan(plan, snapshot):
    """Validate the complete additive plan before any remote mutation."""
    if not isinstance(plan, dict) or set(plan) - {"dependencies", "ready", "summary"}:
        raise SchedulerError("Plan must contain only dependencies, ready and summary")
    issues = {item["number"]: item for item in snapshot["issues"]}
    eligible, targets = set(snapshot["eligible"]), set(snapshot["targets"])
    edges, ready = plan.get("dependencies"), plan.get("ready")
    if not isinstance(edges, list) or not isinstance(ready, list) or len(edges) > len(eligible):
        raise SchedulerError("Invalid dependency/ready arrays")
    if not all(type(number) is int and number in eligible for number in ready):
        raise SchedulerError("Plan may only queue eligible issues from the snapshot")
    if not targets.issubset(ready) or len(ready) != len(set(ready)):
        raise SchedulerError("Plan must promote every organization target exactly once")
    graph = {int(number): set(blockers) for number, blockers in snapshot["graph"].items()}
    changed, normalized = set(), []
    for edge in edges:
        if not isinstance(edge, dict) or set(edge) != {"issue", "blockedBy"}:
            raise SchedulerError("Each dependency must contain issue and blockedBy")
        number, blockers = edge["issue"], edge["blockedBy"]
        if type(number) is not int or number not in eligible or number in changed:
            raise SchedulerError("Dependency target is unknown, duplicated or running")
        if not isinstance(blockers, list) or not all(type(item) is int and item in issues for item in blockers):
            raise SchedulerError("Unknown dependency reference")
        if number in blockers or len(blockers) != len(set(blockers)):
            raise SchedulerError("Self dependency or duplicate dependency")
        graph.setdefault(number, set()).update(blockers)
        changed.add(number)
        normalized.append({"issue": number, "blockedBy": sorted(blockers)})
    if graph_cycles(graph):
        raise SchedulerError("Dependency plan contains a cycle, including existing dependencies")
    summary = plan.get("summary", "")
    if not isinstance(summary, str) or len(summary) > 5000:
        raise SchedulerError("Plan summary must be a short string")
    return {"dependencies": normalized, "ready": ready, "summary": summary}


class Scheduler:
    def __init__(self, api, state_path, now=time.time):
        self.api, self.path, self.now = api, Path(state_path), now
        self.state = {"version": 1, "reservations": {}, "tasks": {}}
        if self.path.exists():
            self.state = json.loads(self.path.read_text(encoding="utf-8"))
            if self.state.get("version") != 1 or not isinstance(self.state.get("reservations"), dict):
                raise SchedulerError("Unsupported scheduler state; refusing unsafe reset")

    def save(self):
        self.state["updatedAt"] = self.now()
        atomic_json(self.path, self.state)

    def config(self):
        branch = self.api.api(self.api.repo(""))["default_branch"]
        content = self.api.api(self.api.repo("contents/.aiworkspace/config.json?ref=" + quote(branch, safe="")))
        config = json.loads(base64.b64decode(content["content"]))
        if config["repository"]["slug"] != self.api.repository or config["repository"]["defaultBranch"] != branch:
            raise SchedulerError("Tracked config does not match repository/default branch")
        concurrency = config.get("orchestration", {}).get("maxConcurrent", 6)
        if type(concurrency) is not int or not 1 <= concurrency <= 50:
            raise SchedulerError("maxConcurrent must be between 1 and 50")
        with tempfile.TemporaryDirectory(prefix='aiws-config-') as directory:
            path = Path(directory) / 'config.json'
            atomic_json(path, config)
            subprocess.run(['/opt/aiws/bin/load-config.sh', str(path)], check=True,
                           stdout=subprocess.DEVNULL, timeout=30)
        return config

    def snapshot(self, config):
        issues = {item["number"]: item for item in self.api.pages(self.api.repo("issues?state=open"))
                  if "pull_request" not in item and "<!-- aiws-task:" not in (item.get("body") or "")}
        labels, mode = config["queue"]["labels"], config["queue"]["mode"]
        ready, organize, items = set(), set(), {}
        for number, issue in issues.items():
            tags = issue_labels(issue)
            trigger_labels = tags & {labels.get("run", "agent-run"), labels["continue"],
                                    *([labels['ready']] if mode in ('label', 'both') else [])}
            updated_at = issue.get("updated_at")
            if trigger_labels and self.api.trusted_label(number, trigger_labels, config, updated_at):
                ready.add(number)
            if labels.get("organize", "agent-organize") in tags and self.api.trusted_label(
                    number, {labels.get('organize', 'agent-organize')}, config, updated_at):
                organize.add(number)
        if mode in ("project", "both"):
            project = config["queue"]["project"]
            for item in self.api.project_items(config):
                content = item.get("content") or {}
                if content.get("repository", {}).get("nameWithOwner") != self.api.repository:
                    continue
                number = content.get("number")
                if number not in issues:
                    continue
                items[number] = item["id"]
                status = (item.get("fieldValueByName") or {}).get("name")
                if status == project["ready"]:
                    ready.add(number)
                if status == project.get("organization", "Organization"):
                    organize.add(number)
        terminal = {labels["running"], labels["done"], labels["failed"]}
        for number, issue in issues.items():
            if issue_labels(issue) & terminal:
                ready.discard(number)
                organize.discard(number)
        ready -= organize
        graph, external, pending = {}, {}, list(issues)
        while pending:
            number = pending.pop()
            if number in graph:
                continue
            graph[number], external[number] = [], []
            for blocker in self.api.dependencies(number):
                if blocker.get("state", "").lower() == "closed":
                    continue
                expected_url = f"https://api.github.com/repos/{self.api.repository}"
                if blocker.get("repository_url", expected_url).lower() != expected_url.lower():
                    external[number].append(blocker.get("html_url", "external dependency"))
                    continue
                graph[number].append(blocker["number"])
                if blocker["number"] in issues and blocker["number"] not in graph:
                    pending.append(blocker["number"])
        return {"issues": list(issues.values()), "ready": sorted(ready), "targets": sorted(organize),
                "eligible": sorted(ready | organize), "graph": graph, "external": external, "items": items}

    def reconcile(self, runs):
        """An ambiguous dispatch never expires into an automatic duplicate."""
        active = {}
        reservations = self.state["reservations"]
        for run in runs:
            title = run.get("display_title", "")
            match = re.match(r"^AIWS (issue|organize) #(\d+)(?:\s|$)", title)
            if match and run.get("status") != "completed":
                active[run["id"]] = (match[1], int(match[2]))
            for reservation in reservations.values():
                if reservation.get("runId") == run["id"] or f"[{reservation['dispatchId']}]" in title:
                    reservation["runId"] = run["id"]
                    reservation["phase"] = "completed" if run.get("status") == "completed" else "running"
                    reservation["conclusion"] = run.get("conclusion")
        for reservation in reservations.values():
            if reservation["phase"] == "reserved" and self.now() - reservation["at"] > 900:
                reservation["phase"] = "uncertain"
                log(f"Dispatch for #{reservation['issue']} has not appeared; retained, no duplicate sent")
        self.save()
        return active

    def cycle(self, config):
        run_workflow = workflow_name("AIWS_RUN_WORKFLOW", "aiws-agent-task.yml")
        org_workflow = workflow_name("AIWS_ORGANIZE_WORKFLOW", "aiws-agent-organize.yml")
        runs = []
        for workflow in (run_workflow, org_workflow):
            # Bounded recent history; retained active IDs are checked separately below.
            response = self.api.api(self.api.repo(f"actions/workflows/{workflow}/runs?event=workflow_dispatch&per_page=100"))
            runs.extend(response['workflow_runs'])
        active = self.reconcile(runs)
        for reservation in self.state["reservations"].values():
            if reservation.get("runId") and reservation["phase"] != "completed":
                run = self.api.api(self.api.repo(f"actions/runs/{reservation['runId']}"))
                active.update(self.reconcile([run]))
        labels = config['queue']['labels']
        for reservation in self.state['reservations'].values():
            if reservation['phase'] == 'completed' and not reservation.get('settled'):
                issue = self.api.api(self.api.repo(f"issues/{reservation['issue']}"))
                tags = issue_labels(issue)
                if reservation.get('conclusion') != 'success':
                    self.api.labels(reservation['issue'], add=[labels['failed']],
                                    remove=[labels['running']] if labels['running'] in tags else [])
                reservation['settled'] = True
                self.save()
        retries = self.path.parent / 'retries'
        if retries.exists():
            for request_path in sorted(retries.glob('*.json')):
                request = json.loads(request_path.read_text())
                number = request['issue']
                if any(issue == number for _, issue in active.values()):
                    continue
                previous = [item for item in self.state['reservations'].values() if item['issue'] == number]
                if any(item['phase'] != 'completed' for item in previous) and not request.get('force'):
                    log(f'Retry #{number} requires --force because dispatch is unresolved')
                    request_path.unlink()
                    continue
                current = self.api.api(self.api.repo(f'issues/{number}'))
                if current.get('state') == 'open':
                    tags = issue_labels(current)
                    organization = labels.get('organize', 'agent-organize') in tags
                    self.api.labels(number, add=[] if organization else [labels['continue']],
                                    remove=tags & {labels['failed'], labels['done'], labels['running']})
                    for key in [key for key, item in self.state['reservations'].items() if item['issue'] == number]:
                        del self.state['reservations'][key]
                    self.save()
                request_path.unlink()
        snapshot = self.snapshot(config)
        self.state["tasks"] = {}
        labels = config["queue"]["labels"]
        issues = {issue["number"]: issue for issue in snapshot["issues"]}
        for number, issue in issues.items():
            tags = issue_labels(issue)
            for label, state in [(labels['running'], 'running'), (labels['failed'], 'failed'), (labels['done'], 'in_review')]:
                if label in tags:
                    self.state['tasks'][str(number)] = {'state': state}
                    break
        cyclic, reservations = graph_cycles(snapshot["graph"]), self.state["reservations"]
        occupied = len(active) + sum(1 for item in reservations.values()
                                     if item["phase"] in ("reserved", "uncertain") and item.get("runId") not in active)
        capacity = max(0, config.get("orchestration", {}).get("maxConcurrent", 6) - occupied)
        enabled = config.get("orchestration", {}).get("enabled", True)
        org_enabled = config.get("organization", {}).get("enabled", True)
        org_active = any(kind == "organize" for kind, _ in active.values()) or any(
            item["kind"] == "organize" and item["phase"] != "completed" for item in reservations.values())
        candidates = [("organize", number) for number in snapshot["targets"]] if org_enabled else []
        candidates += [("issue", number) for number in snapshot["ready"]]
        for kind, number in candidates:
            task_key, key = str(number), f"{kind}:{number}"
            tags, old = issue_labels(issues[number]), reservations.get(key)
            if old and old["phase"] != "completed":
                self.state["tasks"][task_key] = {"state": old["phase"], "kind": kind, "runId": old.get("runId")}
                continue
            if old and old.get('settled') and old.get('conclusion') == 'success' and old.get('at', 0) + 30 > self.now():
                # Let label/project writes from the finished job become visible.
                self.state['tasks'][task_key] = {'state': 'settling', 'kind': kind}
                continue
            if (kind, number) in active.values():
                self.state["tasks"][task_key] = {"state": "running", "kind": kind}
                continue
            blockers, external = snapshot["graph"].get(number, []), snapshot["external"].get(number, [])
            if kind == "issue" and (blockers or external or number in cyclic):
                self.state["tasks"][task_key] = {"state": "waiting", "blockedBy": blockers,
                                                  "external": external, "cycle": number in cyclic}
                waiting = labels.get("waiting", "agent:waiting")
                if waiting not in tags:
                    self.api.labels(number, add=[waiting])
                continue
            if not enabled or capacity == 0 or org_active:
                self.state["tasks"][task_key] = {"state": "queued", "kind": kind}
                continue
            waiting = labels.get("waiting", "agent:waiting")
            if waiting in tags:
                self.api.labels(number, remove=[waiting])
            dispatch_id = uuid.uuid4().hex
            reservation = {"kind": kind, "issue": number, "dispatchId": dispatch_id,
                           "at": self.now(), "phase": "reserved"}
            reservations[key] = reservation
            self.save()  # Write-ahead: crash after acceptance cannot cause blind retry.
            try:
                response = self.api.dispatch(org_workflow if kind == "organize" else run_workflow,
                                             config["repository"]["defaultBranch"], number, dispatch_id)
                if isinstance(response, dict) and response.get("workflow_run_id"):
                    reservation["runId"] = response["workflow_run_id"]
            except Exception:
                reservation["phase"] = "uncertain"
                self.save()
                raise
            self.state["tasks"][task_key] = {"state": "reserved", "kind": kind}
            self.save()
            capacity -= 1
            if kind == "organize":
                org_active = True
            log(f"Dispatched {kind} #{number}; {capacity} free slots remain")
        self.save()
        return self.state


def apply_plan(api, config, snapshot, plan):
    plan = validate_plan(plan, snapshot)
    issues = {issue["number"]: issue for issue in snapshot["issues"]}
    labels = config["queue"]["labels"]
    touched = set(plan["ready"]) | {edge["issue"] for edge in plan["dependencies"]}
    if touched & api.active_issues():
        raise SchedulerError('A planned issue has already been dispatched; organize again after it finishes')
    for number in touched:
        current = api.api(api.repo(f"issues/{number}"))
        if current.get("state") != "open" or issue_labels(current) & {labels["running"], labels["done"]}:
            raise SchedulerError(f"Issue #{number} changed during organization; plan discarded")
    graph = {int(number): set(blockers) for number, blockers in snapshot["graph"].items()}
    # Refresh dependency graph to include concurrent human changes before validation.
    for number in graph:
        graph[number] = {item["number"] for item in api.dependencies(number)
                         if item.get("state") == "open" and item.get("repository_url", "").endswith("/" + api.repository)}
    validate_plan(plan, dict(snapshot, graph=graph))
    for edge in plan["dependencies"]:
        for blocker in edge["blockedBy"]:
            if blocker not in graph.get(edge["issue"], set()):
                api.api(api.repo(f"issues/{edge['issue']}/dependencies/blocked_by"),
                        {"issue_id": issues[blocker]["id"]}, "POST")
    # Edges must all succeed before any task enters Ready. Partial failure leaves
    # Organization intact and is retryable, since existing edges are never removed.
    for number in plan["ready"]:
        if config["queue"]["mode"] in ("project", "both"):
            item = snapshot["items"].get(number) or snapshot["items"].get(str(number))
            if item:
                env = dict(os.environ, AIWS_CONFIG_PATH=os.environ["AIWS_CONFIG"], AIWS_REPOSITORY=api.repository)
                subprocess.run(["/opt/aiws/bin/project.sh", "status", item, config["queue"]["project"]["ready"]],
                               check=True, env=env, timeout=120)
        label = labels.get("organize", "agent-organize")
        api.labels(number, add=[labels["ready"]], remove=[label] if label in issue_labels(issues[number]) else [])
    return plan


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["run", "once", "snapshot", "apply", "check", "retry"])
    parser.add_argument("--issue", type=int)
    parser.add_argument("--snapshot")
    parser.add_argument("--plan")
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    api = GitHub(os.environ.get("AIWS_REPOSITORY", ""))
    state_dir = Path(os.environ.get("AIWS_SCHEDULER_STATE_DIR", "/var/lib/aiws/scheduler"))
    if args.command == 'retry':
        if not args.issue or args.issue < 1:
            raise SchedulerError('A positive issue number is required')
        state = Scheduler(api, state_dir / 'state.json').state
        unresolved = [item for item in state['reservations'].values() if item['issue'] == args.issue and item['phase'] != 'completed']
        if unresolved and not args.force:
            raise SchedulerError('Dispatch is active or uncertain. Inspect GitHub first; --force permits recovery only after no active run remains.')
        atomic_json(state_dir / 'retries' / f'{args.issue}.json', {'issue': args.issue, 'force': args.force})
        return
    if args.command in ("snapshot", "apply", "check"):
        config = json.loads(Path(os.environ["AIWS_CONFIG"]).read_text())
        # One-shot commands never persist state; a private directory keeps a planted file out.
        with tempfile.TemporaryDirectory(prefix="aiws-organizer-") as directory:
            one_shot(args, api, config, Scheduler(api, Path(directory) / "state.json"))
        return
    state_dir.mkdir(parents=True, exist_ok=True)
    import fcntl
    with (state_dir / "scheduler.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        scheduler = Scheduler(api, state_dir / "state.json")
        while True:
            interval = 60
            try:
                config = scheduler.config()
                interval = max(15, min(3600, int(config["queue"].get("pollSeconds", 60))))
                scheduler.cycle(config)
            except Exception as error:  # A long-running dispatcher survives any single bad cycle.
                log(f"Scheduler cycle failed safely: {str(error).replace(api.token, '[redacted]')}")
                if args.command == "once":
                    raise
            if args.command == "once":
                return
            time.sleep(interval)


def one_shot(args, api, config, scheduler):
    if args.command == 'check':
        snapshot = scheduler.snapshot(config)
        if (args.issue not in snapshot['ready'] or snapshot['graph'].get(args.issue)
                or snapshot['external'].get(args.issue)):
            raise SchedulerError('Issue is no longer ready or has unresolved dependencies')
        return
    if args.command == "snapshot":
        snapshot = scheduler.snapshot(config)
        if args.issue not in snapshot["targets"]:
            raise SchedulerError("Issue is no longer in Organization")
        busy = api.active_issues()
        snapshot['eligible'] = [number for number in snapshot['eligible'] if number not in busy]
        snapshot['targets'] = [number for number in snapshot['targets'] if number not in busy]
        if args.issue not in snapshot['targets']:
            raise SchedulerError('Organization issue is already assigned to an execution worker')
        print(json.dumps(snapshot))
    else:
        snapshot = json.loads(Path(args.snapshot).read_text())
        raw = Path(args.plan).read_text().strip()
        if raw.startswith("```json\n") and raw.endswith("```"):
            raw = raw[8:-3].strip()
        print(json.dumps(apply_plan(api, config, snapshot, json.loads(raw))))


if __name__ == "__main__":
    try:
        main()
    except (SchedulerError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        log(str(error))
        sys.exit(1)
