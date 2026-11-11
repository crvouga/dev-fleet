/** Disposable guest test entry; never installed as a production service. */
import { userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { verifyUbuntuBoot } from '../../../src/platform/ubuntu-verify';
import { runAnsible } from '../../../src/platform/ansible';
import { runCommand } from '../../../src/runner';
if (process.argv[2] === 'agent') {
  const result = await runAnsible(runCommand, 'agent.yml', {
    cwd: process.cwd(),
    input: readFileSync(0, 'utf8'),
    timeoutMs: 300_000,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.ok ? 0 : 1;
} else {
  const checks = await verifyUbuntuBoot(userInfo().username, runCommand);
  process.stdout.write(JSON.stringify({ checks }) + '\n');
  process.exitCode = checks.every((check) => check.status === 'pass') ? 0 : 1;
}
