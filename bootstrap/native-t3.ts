/** Pinned Ubuntu T3 distribution. Shared tool installation owns artifacts;
 * Workstation owns services. Never touches ~/.t3 or replaces an existing launcher.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceRoot } from './global-config';
interface Configuration {
  vars: {
    t3_version: string;
    t3_linux_x64_sha256: string;
    t3_linux_arm64_sha256: string;
    t3_desktop_amd64_sha256: string;
    t3_desktop_arm64_sha256: string;
  };
}
/** Pinned desktop .deb for Ubuntu workers. The GUI app is the worker's only T3
 * process and embeds the server; the CLI tarball stays for policy commands. */
export function desktopT3Artifact(config: Configuration, architecture: string) {
  const deb = { x64: 'amd64', arm64: 'arm64' }[architecture];
  if (!deb) throw new Error('Unsupported T3 architecture.');
  const version = config.vars.t3_version;
  const sha256 =
    deb === 'amd64'
      ? config.vars.t3_desktop_amd64_sha256
      : config.vars.t3_desktop_arm64_sha256;
  if (
    !/^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(version) ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw new Error('Invalid T3 desktop pin.');
  const name = `T3-Code-${version}-${deb}.deb`;
  return {
    version,
    sha256,
    name,
    url: `https://github.com/pingdotgg/t3code/releases/download/v${version}/${name}`,
  };
}
export function managedT3Desktop() {
  const config = Bun.TOML.parse(
    readFileSync(join(workspaceRoot, 'mise.toml'), 'utf8')
  ) as Configuration;
  return desktopT3Artifact(config, process.arch);
}
export function nativeT3Artifact(config: Configuration, architecture: string) {
  if (!['x64', 'arm64'].includes(architecture))
    throw new Error('Unsupported T3 architecture.');
  const version = config.vars.t3_version;
  const sha256 =
    architecture === 'x64'
      ? config.vars.t3_linux_x64_sha256
      : config.vars.t3_linux_arm64_sha256;
  if (
    !/^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(version) ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw new Error('Invalid T3 pin.');
  const name = `t3-${version}-linux-${architecture}`;
  return {
    version,
    sha256,
    name,
    url: `https://github.com/pingdotgg/t3code/releases/download/v${version}/${name}.tar.gz`,
  };
}
export function managedT3(): { path: string; version: string } {
  const config = Bun.TOML.parse(
    readFileSync(join(workspaceRoot, 'mise.toml'), 'utf8')
  ) as Configuration;
  const artifact = nativeT3Artifact(config, process.arch);
  return {
    path: join(homedir(), '.local/share/personal/tools', artifact.name, 't3'),
    version: artifact.version,
  };
}
export async function installNativeT3(): Promise<void> {
  if (process.platform !== 'linux') return;
  const config = Bun.TOML.parse(
    readFileSync(join(workspaceRoot, 'mise.toml'), 'utf8')
  ) as Configuration;
  const artifact = nativeT3Artifact(config, process.arch);
  const root = join(homedir(), '.local/share/personal/tools');
  const archive = join(root, `${artifact.name}.tar.gz`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(archive)) {
    const response = await fetch(artifact.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error('Pinned T3 artifact unavailable.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error('T3 artifact checksum mismatch.');
    writeFileSync(`${archive}.partial`, bytes, { mode: 0o600 });
    renameSync(`${archive}.partial`, archive);
  }
  if (
    createHash('sha256').update(readFileSync(archive)).digest('hex') !==
    artifact.sha256
  )
    throw new Error(
      'T3 cached artifact drift; preserve running service and review maintenance recovery.'
    );
  const directory = join(root, artifact.name);
  if (!existsSync(directory)) {
    const staging = join(root, `${artifact.name}.staging`);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      if (
        spawnSync(
          'tar',
          ['--same-permissions', '-xzf', archive, '-C', staging],
          { timeout: 120_000 }
        ).status !== 0
      )
        throw new Error('T3 extraction failed.');
      verifyArchive(archive, staging);
      renameSync(join(staging, artifact.name), directory);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } else verifyArchive(archive, root);
  const version = spawnSync(join(directory, 't3'), ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (
    version.status !== 0 ||
    version.stdout.trim() !== `t3 v${artifact.version}`
  )
    throw new Error('Pinned T3 executable verification failed.');
}

function verifyArchive(archive: string, root: string): void {
  if (
    spawnSync(
      'python3',
      [join(workspaceRoot, 'bootstrap/verify-t3-archive.py'), archive, root],
      { timeout: 120_000 }
    ).status !== 0
  )
    throw new Error(
      'Managed T3 files differ from the pinned artifact; maintenance is required.'
    );
}
