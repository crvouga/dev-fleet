/**
 * Prints the version the Release workflow should publish for `HEAD`, or
 * nothing when there is nothing to release (the reason goes to stderr).
 *
 * The newest `vX.Y.Z` tag is the last release. Commits since then pick the
 * bump, Conventional Commits style:
 *
 *   `feat!:` / `BREAKING CHANGE:`  major (minor while the major is 0)
 *   `feat:`                         minor
 *   anything else                   patch
 *
 *   bun bootstrap/release-version.ts
 */
import { spawnSync } from 'node:child_process';

export interface Git {
  /** Run git and return stdout, or null when it exits non-zero. */
  (args: string[]): string | null;
}

export type Decision =
  | { release: true; version: string; previous: string }
  | { release: false; reason: string };

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

export function decide(git: Git): Decision {
  const previous = latestTag(git);
  if (!previous)
    return {
      release: false,
      reason: 'No vX.Y.Z tag yet: run `bun run bootstrap` once first.',
    };
  if (git(['merge-base', '--is-ancestor', 'HEAD', previous]) !== null)
    return { release: false, reason: `HEAD is already in ${previous}.` };
  const log = git(['log', '--format=%B%x00', `${previous}..HEAD`]) ?? '';
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

if (import.meta.main) {
  const decision = decide(system);
  if (decision.release) {
    console.error(`${decision.previous} -> v${decision.version}`);
    console.log(decision.version);
  } else {
    console.error(decision.reason);
  }
}
