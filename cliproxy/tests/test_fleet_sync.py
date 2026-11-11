import importlib.util
import json
import pathlib
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
DEFINITION = pathlib.Path(__file__).resolve().parents[2] / 'examples/fleet.json'
spec = importlib.util.spec_from_file_location('fleet_sync', SCRIPTS / 'fleet_sync.py')
fleet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fleet)
host = fleet.cliproxy_host
SHA = 'a' * 40
MANAGER = 'manager-mac'
WORKER = 'worker-one'


class FleetSingleton(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.home = self.root / 'home'
        self.calls = []
        self.launchd = host.Launchd(uid=501, home=self.home)

    def command(self, args, timeout=120):
        self.calls.append(args)
        return False

    def active(self, args, timeout=120):
        self.calls.append(args)
        return True

    @staticmethod
    def declared_check(call):
        return 'declared' in call and '--apply' not in call and call[call.index('declared') - 1].endswith('scripts/ops')

    def owner(self, **kwargs):
        kwargs.setdefault('backend', self.launchd)
        kwargs.setdefault('identity', MANAGER)
        return fleet.reconcile(self.root, MANAGER, MANAGER, SHA, True, **kwargs)

    def runtime(self, endpoint=True):
        (self.root / 'state/runtime').mkdir(parents=True)
        (self.root / 'state/runtime/config.yaml').write_text('fixture')
        if endpoint:
            (self.root / 'state/public-endpoint-enabled').touch()

    def link_agents(self):
        self.launchd.unit_directory.mkdir(parents=True)
        for label in [host.LAUNCHD_SERVICE, *host.LAUNCHD_SCHEDULED]:
            self.launchd.plist(label).symlink_to(self.root / 'tracked.plist')

    def test_definition_v3_manager_owns_proxy(self):
        owner, workers = fleet.roles(json.loads(DEFINITION.read_text()))
        self.assertEqual(owner, MANAGER)
        self.assertIn(WORKER, workers)
        self.assertNotIn(owner, workers)
        with self.assertRaises(ValueError):
            fleet.roles({**json.loads(DEFINITION.read_text()), 'version': 2})

    def test_missing_state_never_seeds_or_restores_identity(self):
        result = self.owner(run=self.command)
        self.assertEqual(result['phases'][0]['code'], 'PROXY_RECOVERY_REQUIRED')
        self.assertEqual((result['role'], result['backend']), ('manager', 'launchd'))
        self.assertFalse(result['ok'])
        self.assertEqual(self.calls, [])

    def test_wrong_host_or_platform_never_acts_as_manager(self):
        self.runtime()
        result = self.owner(run=self.active, identity='worker-one')
        self.assertEqual(result['phases'][0]['code'], 'PROXY_IDENTITY_MISMATCH')
        result = self.owner(run=self.active, backend=host.Systemd())
        self.assertEqual(result['phases'][0]['code'], 'PROXY_PLATFORM_MISMATCH')
        self.assertEqual(self.calls, [])

    def test_clean_worker_is_client(self):
        result = fleet.reconcile(self.root, WORKER, MANAGER, SHA, True, run=self.command,
                                 backend=host.Systemd())
        self.assertTrue(result['ok'])
        self.assertEqual(result['role'], 'worker')
        self.assertEqual(result['phases'][0]['code'], 'PROXY_CLIENT_ROLE')
        self.assertTrue(all(call[0] == 'systemctl' and call[1] in ['is-active', 'is-enabled']
                            for call in self.calls))

    def test_worker_hosting_proxy_is_reported_never_stopped(self):
        (self.root / 'INSTALLATION.json').write_text('{}')
        result = fleet.reconcile(self.root, WORKER, MANAGER, SHA, True,
                                 run=self.active, backend=host.Systemd())
        phase = result['phases'][0]
        self.assertEqual(phase['code'], 'PROXY_DUPLICATE_OWNER')
        self.assertIn('migration.md', phase['remedy']['action'])
        self.assertFalse(result['ok'])
        self.assertTrue(all(call[1] in ['is-active', 'is-enabled'] for call in self.calls))

    def test_fenced_worker_install_awaits_decommission(self):
        (self.root / 'INSTALLATION.json').write_text('{}')
        result = fleet.reconcile(self.root, WORKER, MANAGER, SHA, True, run=self.command,
                                 backend=host.Systemd())
        self.assertEqual(result['phases'][0]['code'], 'PROXY_DECOMMISSION_PENDING')
        self.assertFalse(result['ok'])

    def test_every_sync_installs_a_pending_revision_without_sudo(self):
        self.runtime()
        result = self.owner(run=self.command, audit_fn=lambda root: (True, 'b' * 40),
                            compatible_fn=lambda installed, desired: False)
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn('sudo', self.calls[0])
        self.assertTrue(self.calls[0][2].endswith('install.py'))
        self.assertEqual(self.calls[0][-2:], ['--revision', SHA])
        # The fake install failed, so the update is still reported.
        self.assertEqual(result['phases'][0]['code'], 'PROXY_UPDATE_PENDING')
        self.assertNotIn('--maintenance', result['phases'][0]['remedy']['action'])

    def test_endpoint_check_retries_a_reconnecting_route(self):
        self.runtime()
        self.link_agents()
        answers = iter([False, False, True])
        waits = []
        result = self.owner(run=self.active, audit_fn=lambda root: (True, SHA),
                            endpoint_check=lambda root: next(answers), sleep=waits.append)
        self.assertTrue(result['ok'])
        self.assertEqual(waits, [10, 10])

    def test_endpoint_failure_is_reported_after_bounded_retries(self):
        self.runtime()
        self.link_agents()
        waits = []
        result = self.owner(run=self.active, audit_fn=lambda root: (True, SHA),
                            endpoint_check=lambda root: False, sleep=waits.append)
        self.assertFalse(result['ok'])
        self.assertEqual(len(waits), 5)

    def test_declared_config_applies_on_every_sync(self):
        self.runtime()
        self.link_agents()
        state = {'applied': False}

        def proxy(args, timeout=120):
            self.calls.append(args)
            if 'declared' in args and args[-1] == '--apply':
                state['applied'] = True
                return True
            if self.declared_check(args):
                return state['applied']
            return True

        result = self.owner(run=proxy, audit_fn=lambda root: (True, SHA),
                            endpoint_check=lambda root: True)
        self.assertTrue(any('declared' in call and call[-1] == '--apply' for call in self.calls))
        self.assertNotIn('PROXY_CONFIG_PENDING', [p['code'] for p in result['phases']])
        self.assertTrue(result['ok'])

    def test_declared_config_failure_is_reported(self):
        self.runtime()
        self.link_agents()
        pending = lambda args, timeout=120: (self.calls.append(args) or not (
            self.declared_check(args) or args[-1] == '--apply'))
        result = self.owner(run=pending, audit_fn=lambda root: (True, SHA),
                            endpoint_check=lambda root: True)
        codes = [p['code'] for p in result['phases']]
        self.assertIn('PROXY_CONFIG_PENDING', codes)
        self.assertFalse(result['ok'])

    def test_stopped_agents_are_bootstrapped_in_gui_domain(self):
        self.runtime()
        self.link_agents()
        result = self.owner(run=self.command, audit_fn=lambda root: (True, SHA),
                            endpoint_check=lambda root: True)
        loads = [call for call in self.calls if call[1] == 'bootstrap']
        self.assertEqual(
            [call[3] for call in loads],
            [str(self.launchd.plist(label)) for label in [*host.LAUNCHD_SCHEDULED[:2], host.LAUNCHD_SERVICE]])
        self.assertTrue(all(call[2] == 'gui/501' for call in loads))
        self.assertFalse(any('sudo' in call for call in self.calls))
        self.assertFalse(result['ok'])

    def test_correct_manager_does_not_restart_or_probe_management(self):
        self.runtime()
        self.link_agents()
        result = self.owner(run=self.active, audit_fn=lambda root: (True, SHA),
                            endpoint_check=lambda root: True)
        self.assertTrue(result['ok'])
        self.assertFalse(result['changed'])
        self.assertEqual(result['phases'][-1]['code'], 'PROXY_ENDPOINT_AUTH')
        self.assertIn('PROXY_UNIT_DEV_DEVFLEET_CLIPROXY_FLEET', {p['code'] for p in result['phases']})
        self.assertTrue(all(call[:2] == ['launchctl', 'print'] or self.declared_check(call)
                            for call in self.calls))

    def test_unrelated_monorepo_update_does_not_restart_identical_gateway_source(self):
        self.runtime()
        self.link_agents()
        result = self.owner(run=self.active, audit_fn=lambda root: (True, 'b' * 40),
                            endpoint_check=lambda root: True,
                            compatible_fn=lambda installed, desired: True)
        self.assertTrue(result['ok'])
        self.assertFalse(result['changed'])
        self.assertTrue(all(call[:2] == ['launchctl', 'print'] or self.declared_check(call)
                            for call in self.calls))

    def test_proxy_claims_the_claude_code_version_the_fleet_runs(self):
        repository = self.root / 'repo'
        repository.mkdir()
        self.assertIsNone(fleet.claude_pin(repository))
        (repository / 'mise.toml').write_text('[tools]\nclaude = "9.8.7"\ncodex = "1.0.0"\n')
        self.assertEqual(fleet.claude_pin(repository), '9.8.7')
        command = fleet.declared(self.root, apply=True)
        pin = fleet.claude_pin()
        self.assertRegex(pin, r'^\d+\.\d+\.\d+$')
        self.assertEqual(command[command.index('declared') + 1:], ['--claude-version', pin, '--apply'])
