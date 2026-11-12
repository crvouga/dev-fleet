/**
 * Moves a pin that carries digests to its newest upstream release, digests
 * included, so an update is one reviewed pull request and never a manual
 * batch. Renovate cannot do this: it bumps a version but cannot compute the
 * checksums beside it. The Pins workflow runs this on a schedule and opens a
 * pull request when the file changed.
 *
 *   bun bootstrap/pins.ts mise     # min_version and mise_*_sha256 in mise.toml
 *   bun bootstrap/pins.ts t3       # t3_version and t3_*_sha256 in mise.toml
 *
 * Prints `<pin> <from> -> <to>`, or `<pin> <version> is current`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where upstream releases are read. Injected by the features. */
export interface Upstream {
  /** Release tags of a GitHub repository, newest first. */
  tags(repository: string): Promise<string[]>;
  /** The body of a file at a URL. */
  text(url: string): Promise<string>;
  /** The SHA-256 of a file at a URL. */
  sha256(url: string): Promise<string>;
}

export interface Change {
  pin: string;
  from: string;
  to: string;
  /** The new text of mise.toml. */
  text: string;
}

const MISE_PLATFORMS = [
  'linux_x64',
  'linux_arm64',
  'macos_x64',
  'macos_arm64',
] as const;
const T3_NIGHTLY = /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)$/;
const MISE_RELEASE = /^v(\d{4}\.\d+\.\d+)$/;

function value(text: string, name: string): string {
  const found = new RegExp(`^${name} = "(.*)"$`, 'm').exec(text)?.[1];
  if (found === undefined) throw new Error(`mise.toml has no ${name}.`);
  return found;
}

function replace(text: string, name: string, next: string): string {
  value(text, name);
  return text.replace(
    new RegExp(`^${name} = ".*"$`, 'm'),
    `${name} = "${next}"`
  );
}

function digest(hex: string, what: string): string {
  if (!/^[a-f0-9]{64}$/.test(hex))
    throw new Error(`Upstream gave no SHA-256 for ${what}.`);
  return hex;
}

async function mise(text: string, upstream: Upstream): Promise<Change> {
  const from = value(text, 'min_version');
  const tag = (await upstream.tags('jdx/mise')).find((candidate) =>
    MISE_RELEASE.test(candidate)
  );
  if (!tag) throw new Error('jdx/mise has no release.');
  const to = MISE_RELEASE.exec(tag)![1]!;
  if (to === from) return { pin: 'mise', from, to, text };
  // The digests mise publishes for its own archives, the ones
  // bootstrap/bootstrap.sh downloads.
  const sums = await upstream.text(
    `https://github.com/jdx/mise/releases/download/${tag}/SHASUMS256.txt`
  );
  let next = replace(text, 'min_version', to);
  for (const platform of MISE_PLATFORMS) {
    const asset = `mise-v${to}-${platform.replace('_', '-')}.tar.gz`;
    const line = sums
      .split('\n')
      .map((entry) => entry.trim().split(/\s+/))
      .find(([, name]) => name?.replace(/^\.\//, '') === asset);
    next = replace(
      next,
      `mise_${platform}_sha256`,
      digest(line?.[0] ?? '', asset)
    );
  }
  return { pin: 'mise', from, to, text: next };
}

async function t3(text: string, upstream: Upstream): Promise<Change> {
  const from = value(text, 't3_version');
  const tag = (await upstream.tags('pingdotgg/t3code')).find((candidate) =>
    T3_NIGHTLY.test(candidate)
  );
  if (!tag) throw new Error('pingdotgg/t3code has no nightly release.');
  const to = T3_NIGHTLY.exec(tag)![1]!;
  if (to === from) return { pin: 't3', from, to, text };
  const base = `https://github.com/pingdotgg/t3code/releases/download/${tag}`;
  // Upstream's SHA256SUMS omits the desktop packages: every artifact is
  // hashed from the release itself, the way bootstrap/native-t3.ts and
  // ansible/ubuntu/t3-desktop.yml check it.
  const artifacts: [string, string][] = [
    ['t3_linux_x64_sha256', `t3-${to}-linux-x64.tar.gz`],
    ['t3_linux_arm64_sha256', `t3-${to}-linux-arm64.tar.gz`],
    ['t3_desktop_amd64_sha256', `T3-Code-${to}-amd64.deb`],
    ['t3_desktop_arm64_sha256', `T3-Code-${to}-arm64.deb`],
  ];
  let next = replace(text, 't3_version', to);
  for (const [name, asset] of artifacts)
    next = replace(
      next,
      name,
      digest(await upstream.sha256(`${base}/${asset}`), asset)
    );
  return { pin: 't3', from, to, text: next };
}

export const PINS: Record<
  string,
  (text: string, upstream: Upstream) => Promise<Change>
> = { mise, t3 };

/** The newest release of one pin, as the new text of mise.toml. */
export async function update(
  pin: string,
  text: string,
  upstream: Upstream
): Promise<Change> {
  const updater = PINS[pin];
  if (!updater)
    throw new Error(
      `Unknown pin ${pin}: one of ${Object.keys(PINS).join(', ')}.`
    );
  return updater(text, upstream);
}

/** GitHub and HTTPS, as the Pins workflow reaches them. */
export function githubUpstream(token = process.env['GH_TOKEN']): Upstream {
  const fetchOk = async (url: string, headers: Record<string, string> = {}) => {
    const response = await fetch(url, { headers, redirect: 'follow' });
    if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
    return response;
  };
  return {
    async tags(repository) {
      const response = await fetchOk(
        `https://api.github.com/repos/${repository}/releases?per_page=100`,
        {
          accept: 'application/vnd.github+json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        }
      );
      const releases = (await response.json()) as {
        tag_name: string;
        draft: boolean;
      }[];
      return releases
        .filter((release) => !release.draft)
        .map((release) => release.tag_name);
    },
    async text(url) {
      return (await fetchOk(url)).text();
    },
    async sha256(url) {
      const bytes = await (await fetchOk(url)).arrayBuffer();
      return createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    },
  };
}

if (import.meta.main) {
  const pin = process.argv[2] ?? '';
  const path = join(import.meta.dir, '..', 'mise.toml');
  const change = await update(
    pin,
    readFileSync(path, 'utf8'),
    githubUpstream()
  );
  if (change.from === change.to) console.log(`${pin} ${change.to} is current`);
  else {
    writeFileSync(path, change.text);
    console.log(`${pin} ${change.from} -> ${change.to}`);
  }
}
