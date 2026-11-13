import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import unittest.mock

spec = importlib.util.spec_from_file_location('aiws_scheduler', Path(__file__).parents[2] / 'assets/runtime/bin/scheduler.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)

CONFIG = {'repository': {'slug': 'owner/repo', 'defaultBranch': 'main'},
          'security': {'allowedActors': ['owner']},
          'queue': {'mode': 'label', 'labels': {'ready': 'ready', 'run': 'agent-run', 'continue': 'continue',
                      'organize': 'organize', 'running': 'running', 'failed': 'failed', 'done': 'done', 'waiting': 'waiting'}},
          'orchestration': {'enabled': True, 'maxConcurrent': 6}, 'organization': {'enabled': True}}

class FakeGitHub:
    repository = 'owner/repo'
    def __init__(self, count=6):
        self.issues = {n: {'number': n, 'id': n + 100, 'state': 'open', 'title': str(n), 'labels': ['ready']}
                       for n in range(1, count + 1)}
        self.edges, self.runs, self.dispatched, self.mutations = {}, [], [], []
        self.reject = False
    def repo(self, suffix): return suffix
    def trusted_label(self, *_): return True
    def pages(self, path, key=None):
        if path.startswith('issues?'): return list(copy.deepcopy(self.issues).values())
        raise AssertionError(path)
    def api(self, path, data=None, method=None):
        if path.startswith('actions/workflows/'): return {'workflow_runs': self.runs}
        if path.startswith('actions/runs/'): return next(r for r in self.runs if str(r['id']) == path.rsplit('/', 1)[1])
        if '/dependencies/' in path:
            self.mutations.append((path, data)); return None
        if path.startswith('issues/'): return copy.deepcopy(self.issues[int(path.split('/')[1])])
        raise AssertionError(path)
    def dependencies(self, issue):
        return [copy.deepcopy(self.issues[n]) for n in self.edges.get(issue, [])]
    def labels(self, issue, add=(), remove=()):
        self.issues[issue]['labels'] = sorted((set(self.issues[issue]['labels']) | set(add)) - set(remove))
    def dispatch(self, workflow, branch, issue, dispatch_id):
        self.dispatched.append(issue)
        if self.reject: raise s.SchedulerError('response lost')
        kind = 'organize' if 'organize' in workflow else 'issue'
        run = {'id': len(self.runs) + 1, 'display_title': f'AIWS {kind} #{issue} [{dispatch_id}]', 'status': 'queued', 'conclusion': None}
        self.runs.append(run)
        return {'workflow_run_id': run['id']}

class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'state.json'
        self.api = FakeGitHub()
        self.config = copy.deepcopy(CONFIG)
        self.scheduler = s.Scheduler(self.api, self.path, now=lambda: 1000)
    def test_six_independent_tasks_start_and_restart_does_not_duplicate(self):
        self.scheduler.cycle(self.config)
        self.assertEqual(self.api.dispatched, list(range(1, 7)))
        s.Scheduler(self.api, self.path).cycle(self.config)
        self.assertEqual(len(self.api.dispatched), 6)
    def test_dependency_waits_then_runs_when_closed(self):
        self.api.edges[1] = [2]
        self.scheduler.cycle(self.config)
        self.assertNotIn(1, self.api.dispatched)
        self.assertIn(2, self.api.dispatched)
        self.assertEqual(self.scheduler.state['tasks']['1']['blockedBy'], [2])
        self.api.issues[2]['state'] = 'closed'
        self.api.issues[2]['labels'] = ['done']
        self.api.runs[0].update(status='completed', conclusion='success')
        self.scheduler.cycle(self.config)
        self.assertIn(1, self.api.dispatched)
    def test_capacity_limits_and_refills(self):
        self.config['orchestration']['maxConcurrent'] = 2
        self.scheduler.cycle(self.config)
        self.assertEqual(self.api.dispatched, [1, 2])
        self.api.runs[0].update(status='completed', conclusion='success')
        self.api.issues[1]['labels'] = ['done']
        self.scheduler.cycle(self.config)
        self.assertEqual(self.api.dispatched, [1, 2, 3])
    def test_uncertain_dispatch_survives_restart_and_does_not_retry(self):
        self.api.reject = True
        with self.assertRaises(s.SchedulerError): self.scheduler.cycle(self.config)
        self.api.reject = False
        self.config['orchestration']['maxConcurrent'] = 1
        s.Scheduler(self.api, self.path).cycle(self.config)
        self.assertEqual(self.api.dispatched, [1])
        self.assertEqual(json.loads(self.path.read_text())['reservations']['issue:1']['phase'], 'uncertain')
    def test_failed_run_settles_and_explicit_requeue_can_retry(self):
        self.config['orchestration']['maxConcurrent'] = 1
        self.scheduler.cycle(self.config)
        self.api.runs[0].update(status='completed', conclusion='failure')
        self.scheduler.cycle(self.config)
        self.assertIn('failed', self.api.issues[1]['labels'])
        self.assertEqual(self.api.dispatched.count(1), 1)
    def test_cycle_and_dependents_never_start(self):
        self.api.edges = {1: [2], 2: [1], 3: [2]}
        self.scheduler.cycle(self.config)
        self.assertEqual(self.api.dispatched, [4, 5, 6])
        self.assertTrue(self.scheduler.state['tasks']['3']['cycle'])
    def test_organization_serializes_planning_before_execution(self):
        self.api.issues[1]['labels'] = ['organize']
        self.api.issues[2]['labels'] = ['organize']
        self.scheduler.cycle(self.config)
        self.assertEqual(self.api.dispatched, [1])
    def test_disabled_scheduler_starts_nothing(self):
        self.config['orchestration']['enabled'] = False
        self.scheduler.cycle(self.config)
        self.assertFalse(self.api.dispatched)
    def test_control_center_owned_issue_never_enters_the_legacy_queue(self):
        self.api.issues[1]['body'] = 'Control task\n\n<!-- aiws-task:task_owned -->'
        self.api.issues[1]['labels'] = ['ready', 'agent-run']
        self.scheduler.cycle(self.config)
        self.assertNotIn(1, self.api.dispatched)
        self.assertNotIn(1, self.scheduler.snapshot(self.config)['eligible'])

class PlannerTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {'issues': [{'number': n, 'id': n + 100} for n in (1, 2, 3)],
                         'eligible': [1, 2], 'targets': [1], 'graph': {1: [], 2: []}, 'items': {}}
    def test_valid_additive_plan(self):
        self.assertEqual(s.validate_plan({'dependencies': [{'issue': 1, 'blockedBy': [2]}], 'ready': [1, 2]}, self.snapshot)['ready'], [1, 2])
    def test_unknown_running_self_and_duplicate_edges_rejected(self):
        for edge in [{'issue': 99, 'blockedBy': []}, {'issue': 3, 'blockedBy': []}, {'issue': 1, 'blockedBy': [1]}, {'issue': 1, 'blockedBy': [99]}, {'issue': 1, 'blockedBy': [2, 2]}]:
            with self.subTest(edge=edge), self.assertRaises(s.SchedulerError):
                s.validate_plan({'dependencies': [edge], 'ready': [1]}, self.snapshot)
    def test_existing_cycle_rejected_before_apply(self):
        self.snapshot['graph'] = {2: [1]}
        with self.assertRaises(s.SchedulerError):
            s.validate_plan({'dependencies': [{'issue': 1, 'blockedBy': [2]}], 'ready': [1]}, self.snapshot)
    def test_target_must_be_promoted(self):
        with self.assertRaises(s.SchedulerError): s.validate_plan({'dependencies': [], 'ready': [2]}, self.snapshot)

class TrustedLabelTests(unittest.TestCase):
    def setUp(self):
        self.api = object.__new__(s.GitHub)
        self.api.repository, self.api.token, self.api._trusted, self.calls = 'owner/repo', 'token', {}, []
        self.events = [{'event': 'labeled', 'label': {'name': 'ready'}, 'actor': {'login': 'Owner'}}]
        self.api.pages = lambda path, key=None: (self.calls.append(path), self.events)[1]
    def test_label_trust_is_cached_until_the_issue_changes(self):
        self.assertTrue(self.api.trusted_label(1, {'ready'}, CONFIG, '2026-01-01T00:00:00Z'))
        self.assertTrue(self.api.trusted_label(1, {'ready'}, CONFIG, '2026-01-01T00:00:00Z'))
        self.assertEqual(len(self.calls), 1)
        self.events = [{'event': 'labeled', 'label': {'name': 'ready'}, 'actor': {'login': 'outsider'}}]
        self.assertFalse(self.api.trusted_label(1, {'ready'}, CONFIG, '2026-01-02T00:00:00Z'))
        self.assertEqual(len(self.calls), 2)
    def test_workflow_names_are_plain_file_names(self):
        with unittest.mock.patch.dict(s.os.environ, {'AIWS_RUN_WORKFLOW': '../x?y'}):
            with self.assertRaises(s.SchedulerError): s.workflow_name('AIWS_RUN_WORKFLOW', 'aiws-agent-task.yml')

if __name__ == '__main__': unittest.main()
