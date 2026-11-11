# Agent notes

- dev-fleet keeps one macOS **manager** and Ubuntu **workers** in sync. Use
  exactly those words. Read `README.md` first.
- **No fleet's identity in this repository.** No account, email, hostname,
  domain, tailnet name or consumer repository in tracked files; they belong in
  the consumer's `fleet.json`, read only through `src/fleet-config.ts`
  (`cliproxy/scripts/fleet_config.py` for the proxy scripts).
  `tests/identity.test.ts` enforces this.
- **Declare, then measure.** Anything that changes a machine is an Ansible task
  (`ansible/`, builtin modules only) or a mise pin. TypeScript refuses
  conflicts beforehand and measures the result afterwards; it must not run
  `systemctl start|restart|enable`, `tailscale serve`, `apt` or similar itself.
- **Text written to machines is an interface.** Managed-file contents, unit
  names, launchd labels, state paths and ownership markers already exist on
  running machines. Changing one is a migration, never a rename. An ownership
  check compares the marker text only, never a path or repository name.
- **The bucket is the source of truth; local data is disposable.** State the
  manager cannot rebuild from Git is a document in the fleet state
  (`src/state/`, see `docs/state.md`), changed through `mutateState` or
  `refresh` then `push`, never a new file under the home directory. Only the
  devfleet CLI reads it; launchers and the worker probe run under Node and use
  the copy fleet-sync installs, so nothing they import may load `bun:sqlite`.
- Secrets are read by purpose through `src/secrets.ts`. Never put a secret in
  argv, a report, a log or the fleet configuration.
- Diagnostics are read-only. Use stable check IDs and structured remedies;
  never serialize raw subprocess output, environment, SSH config or auth
  responses.
- Keep the CLI flat: `fleet-*`, `t3-*`, `cliproxy`. Add flags, not aliases or
  nested groups.
- Tests inject every subprocess, run against `examples/fleet.json` and never
  contact a real machine. Run `bun run check` before pushing. Verify bootstrap
  changes with `bun ansible/ubuntu/tests/fresh-box.ts`.
