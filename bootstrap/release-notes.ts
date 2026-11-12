/**
 * The notes of a release, from the Conventional Commits since the last
 * release tag. A commit whose change restarts T3 on the workers, and so ends
 * the agent turns running there, says so in a footer:
 *
 *   Worker-Restart: the T3 desktop app is replaced
 *
 * and the notes put it first, so whoever installs the release knows to wait
 * for the agents to finish.
 *
 *   bun bootstrap/release-notes.ts > notes.md
 */
import { spawnSync } from 'node:child_process';
import type { Git } from './release-version';

const SUBJECT = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:\s*(.+)$/m;
const RESTART_FOOTER = /^Worker-Restart:\s*(.+)$/m;

const SECTIONS: [string, (type: string) => boolean][] = [
  ['Features', (type) => type === 'feat'],
  ['Fixes', (type) => type === 'fix'],
  ['Other changes', () => true],
];

export function releaseNotes(messages: string[]): string {
  const restarts: string[] = [];
  const breaking: string[] = [];
  const sections = new Map<string, string[]>(
    SECTIONS.map(([title]) => [title, []])
  );
  for (const message of messages) {
    const subject = message.split('\n', 1)[0]!.trim();
    // A merge commit only joins commits already listed.
    if (/^Merge (pull request|branch) /.test(subject)) continue;
    const parsed = SUBJECT.exec(subject);
    const type = parsed?.[1] ?? '';
    const scope = parsed?.[2];
    const text = parsed?.[4] ?? subject;
    const entry = scope ? `**${scope}:** ${text}` : text;
    const restart = RESTART_FOOTER.exec(message)?.[1];
    if (restart) restarts.push(`${entry} (${restart.trim()})`);
    const footer = BREAKING_FOOTER.exec(message)?.[1];
    if (parsed?.[3] || footer)
      breaking.push(footer ? `${entry}: ${footer.trim()}` : entry);
    const [title] = SECTIONS.find(([, matches]) => matches(type))!;
    sections.get(title)!.push(entry);
  }
  const blocks: string[] = [];
  const block = (title: string, entries: string[]) => {
    if (entries.length)
      blocks.push(
        `## ${title}\n\n${entries.map((entry) => `- ${entry}`).join('\n')}`
      );
  };
  block('Requires a worker restart (ends agent turns)', restarts);
  block('Breaking changes', breaking);
  for (const [title] of SECTIONS) block(title, sections.get(title)!);
  return blocks.length ? `${blocks.join('\n\n')}\n` : 'No changes.\n';
}

/** The messages of the commits since the newest release tag, newest first. */
export function messagesSinceRelease(git: Git): string[] {
  // A hand-pushed tag releases HEAD itself: the last release is the one before.
  const tags = (git(['tag', '--list', 'v*', '--sort=-v:refname']) ?? '')
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const tag =
    tags.find(
      (candidate) =>
        git(['merge-base', '--is-ancestor', 'HEAD', candidate]) === null
    ) ?? null;
  const log =
    git(['log', '--format=%B%x00', tag ? `${tag}..HEAD` : 'HEAD']) ?? '';
  return log
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean);
}

if (import.meta.main) {
  const git: Git = (args) => {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    return result.status === 0 ? (result.stdout ?? '') : null;
  };
  process.stdout.write(releaseNotes(messagesSinceRelease(git)));
}
