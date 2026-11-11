/** AWS v2's official Windows MSI; aqua only packages AWS for Unix. */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceRoot } from './global-config';

type AwsConfig = {
  tools: { aws: { version: string } };
  vars: { aws_windows_msi_sha256: string };
};
export function awsWindowsArtifact(config: AwsConfig): {
  url: string;
  sha256: string;
  version: string;
} {
  const version = config.tools.aws.version;
  const sha256 = config.vars.aws_windows_msi_sha256;
  if (!/^2\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error('Invalid pinned AWS Windows artifact.');
  return {
    version,
    url: `https://awscli.amazonaws.com/AWSCLIV2-${version}.msi`,
    sha256,
  };
}

export async function installNativeAws(): Promise<void> {
  if (process.platform !== 'win32') return;
  const config = Bun.TOML.parse(
    readFileSync(join(workspaceRoot, 'mise.toml'), 'utf8')
  ) as AwsConfig;
  const artifact = awsWindowsArtifact(config);
  const bin = join(
    process.env['ProgramFiles'] ?? 'C:\\Program Files',
    'Amazon',
    'AWSCLIV2'
  );
  const executable = join(bin, 'aws.exe');
  const probe = () =>
    spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (!probe().stdout?.includes(`aws-cli/${artifact.version} `)) {
    const directory = mkdtempSync(join(tmpdir(), 'workspace-aws-'));
    try {
      const response = await fetch(artifact.url);
      if (!response.ok)
        throw new Error(`AWS MSI download failed (${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
        throw new Error('AWS MSI checksum mismatch.');
      const msi = join(directory, 'aws.msi');
      await Bun.write(msi, bytes);
      const script = String.raw`$arguments = @('/i', ('"' + $env:WORKSPACE_AWS_MSI + '"'), '/qn', '/norestart'); $options = @{FilePath='msiexec.exe'; ArgumentList=$arguments; Wait=$true; PassThru=$true}; if ($env:WORKSPACE_AWS_ELEVATE -eq '1') { $options.Verb = 'RunAs' }; $p = Start-Process @options; exit $p.ExitCode`;
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', script],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            WORKSPACE_AWS_MSI: msi,
            WORKSPACE_AWS_ELEVATE:
              process.argv.includes('--non-interactive') || process.env['CI']
                ? '0'
                : '1',
          },
        }
      );
      if (result.status !== 0 && result.status !== 3010)
        throw new Error(
          `AWS MSI installation failed (exit ${result.status}, signal ${result.signal}, error ${result.error?.message ?? 'none'}); check for a conflicting installed version or run the reviewed bootstrap as Administrator.`
        );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (!probe().stdout?.includes(`aws-cli/${artifact.version} `))
    throw new Error(
      `Expected AWS CLI ${artifact.version}; resolve the existing installation before retrying.`
    );
  process.env['PATH'] = `${bin};${process.env['PATH'] ?? ''}`;
  // Persist across subsequent hosted-runner steps; normal users reopen the shell.
  if (process.env['GITHUB_PATH'])
    appendFileSync(process.env['GITHUB_PATH'], `${bin}\n`);
}
