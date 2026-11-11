/** Opt-in disposable VM bootstrap acceptance; never invoked by unit tests. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { bootstrapRemote } from '../../../src/remote-bootstrap';
import { runCommand } from '../../../src/runner';

const [artifacts, source] = process.argv.slice(2);
if (!artifacts || !source) throw new Error('Fixture directories required');
const revision = (await readFile(join(source, 'revision'), 'utf8')).trim();
const bundle = await readFile(join(source, 'source.bundle'));
const sshConfig = join(artifacts, 'bootstrap-ssh-config');
await writeFile(
  sshConfig,
  [
    'Host fixture-vm',
    '  HostName 127.0.0.1',
    '  Port 2222',
    '  User fleettest',
    '  IdentitiesOnly yes',
    '  IdentityFile ' + join(artifacts, 'client'),
    '  UserKnownHostsFile ' + join(artifacts, 'known_hosts'),
  ].join('\n') + '\n',
  { mode: 0o600 }
);
const result = await bootstrapRemote(
  { id: 'fixture-vm', ssh: 'fixture-vm', workspace: '/unused', required: [] },
  {
    revision,
    digest: createHash('sha256').update(bundle).digest('hex'),
    bundle: bundle.toString('base64'),
    script: await readFile(join(source, 'bootstrap.sh'), 'utf8'),
  },
  (args, options) =>
    runCommand(
      args[0] === 'ssh' ? ['ssh', '-F', sshConfig, ...args.slice(1)] : args,
      options
    )
);
process.stdout.write(
  JSON.stringify({ revision, fixture: true, ...result }) + '\n'
);
// Missing live auth is expected. Reaching node-level convergence establishes that
// source transfer, exact checkout and shared tool/dependency bootstrap completed.
process.exitCode = result.checks.some(
  (check) => check.id === 'ubuntu:baseline' && check.status === 'pass'
)
  ? 0
  : 1;
