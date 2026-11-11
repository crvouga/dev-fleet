/**
 * Prints the version the Release workflow should publish for `HEAD`, or
 * nothing when there is nothing to release (the reason goes to stderr).
 *
 * The newest `vX.Y.Z` tag is the last release. Without one, the newest
 * version on npm is: it was published by hand before the workflow tagged
 * anything, and npm may not have recorded its commit, so every commit up to
 * `HEAD` counts. Commits since the last release pick the bump, Conventional
 * Commits style:
 *
 *   `feat!:` / `BREAKING CHANGE:`  major (minor while the major is 0)
 *   `feat:`                         minor
 *   anything else                   patch
 *
 * Exits 1 when nothing can be released because publishing was never set up
 * (no tag and nothing on npm), so the Release workflow does not report a
 * skipped release as a success.
 *
 *   bun bootstrap/release-version.ts
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Git {
  /** Run git and return stdout, or null when it exits non-zero. */
  (args: string[]): string | null;
}

export type Decision =
  | { release: true; version: string; previous: string }
  | { release: false; reason: string; setup?: true };

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const BREAKING_SUBJECT = /^\w+(\([^)]*\))?!:/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;
const FEATURE = /^feat(\([^)]*\))?:/;

export type Bump = 'major' | 'minor' | 'patch';

export function bumpFor(messages: string[]): Bump {
  let bump: Bump = 'patch';
  for (const message of messages) {
    const subject = message.split('\n', 1)[0]!.trim();
    if (BREAKING_SUBJECT.test(subject) || BREAKING_FOOTER.test(message))
      return 'major';
    if (FEATURE.test(subject)) bump = 'minor';
  }
  return bump;
}

export function bumpVersion(tag: string, bump: Bump): string {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`Not a release tag: ${tag}`);
  const [major, minor, patch] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  if (bump === 'major' && major > 0) return `${major + 1}.0.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return `${major}.${minor + 1}.0`;
}

export function latestTag(git: Git): string | null {
  const tags = git(['tag', '--list', 'v*', '--sort=-v:refname']) ?? '';
  return (
    tags
      .split('\n')
      .map((tag) => tag.trim())
      .find((tag) => TAG.test(tag)) ?? null
  );
}

/** The newest stable `X.Y.Z` of these npm versions, or null. */
export function newestPublished(versions: string[]): string | null {
  const stable = versions
    .filter((version) => TAG.test(`v${version}`))
    .map((version) => version.split('.').map(Number) as number[]);
  stable.sort((a, b) => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!);
  return stable[0]?.join('.') ?? null;
}

/**
 * `published` is the newest stable version on npm, or null when the package
 * is not there.
 */
export function decide(git: Git, published: string | null = null): Decision {
  const tag = latestTag(git);
  if (!tag && !published)
    return {
      release: false,
      setup: true,
      reason:
        'No vX.Y.Z tag and nothing on npm yet: run `bun run bootstrap` once first.',
    };
  const previous = tag ?? `v${published}`;
  if (tag && git(['merge-base', '--is-ancestor', 'HEAD', tag]) !== null)
    return { release: false, reason: `HEAD is already in ${tag}.` };
  const log =
    git(['log', '--format=%B%x00', tag ? `${tag}..HEAD` : 'HEAD']) ?? '';
  const messages = log
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean);
  if (messages.length === 0)
    return { release: false, reason: `No commits since ${previous}.` };
  return {
    release: true,
    version: bumpVersion(previous, bumpFor(messages)),
    previous,
  };
}

const system: Git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout ?? '') : null;
};

/** The versions of the package on npm; empty when it is not there. */
function npmVersions(): string[] {
  const name = (
    JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')
    ) as { name: string }
  ).name;
  const result = spawnSync('npm', ['view', name, 'versions', '--json'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  const versions: unknown = JSON.parse(result.stdout || '[]');
  return Array.isArray(versions)
    ? versions.filter((v): v is string => typeof v === 'string')
    : typeof versions === 'string'
      ? [versions]
      : [];
}

if (import.meta.main) {
  const decision = decide(system, newestPublished(npmVersions()));
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  const note = (line: string) => {
    if (summary) appendFileSync(summary, `${line}\n`);
  };
  if (decision.release) {
    console.error(`${decision.previous} -> v${decision.version}`);
    note(`Releasing v${decision.version} (after ${decision.previous}).`);
    console.log(decision.version);
  } else if (decision.setup) {
    console.error(`::error::${decision.reason}`);
    note(`**Nothing was released.** ${decision.reason}`);
    process.exitCode = 1;
  } else {
    console.error(decision.reason);
    note(`Nothing to release: ${decision.reason}`);
  }
}
