import { expect, test } from 'bun:test';
import {
  bumpFor,
  bumpVersion,
  decide,
  latestTag,
  type Git,
} from './release-version';

function repo(options: {
  tags?: string[];
  released?: boolean;
  messages?: string[];
}): Git {
  return (args) => {
    const [command] = args;
    if (command === 'tag') return (options.tags ?? []).join('\n');
    if (command === 'merge-base') return options.released ? '' : null;
    if (command === 'log')
      return (options.messages ?? []).map((m) => `${m}\n\0`).join('\n');
    return null;
  };
}

test('anything that is not a feature or a breaking change is a patch', () => {
  expect(
    bumpFor(['fix: a', 'chore: b', 'Merge pull request #1 from x/y'])
  ).toBe('patch');
  expect(bumpFor(['docs: a'])).toBe('patch');
});

test('a feature is a minor bump', () => {
  expect(bumpFor(['fix: a', 'feat(cli): b'])).toBe('minor');
});

test('a breaking change is a major bump, from the subject or the footer', () => {
  expect(bumpFor(['feat!: drop x'])).toBe('major');
  expect(bumpFor(['refactor(cli)!: rename'])).toBe('major');
  expect(bumpFor(['fix: a\n\nBREAKING CHANGE: b'])).toBe('major');
  expect(bumpFor(['fix: mention feat!: in passing'])).toBe('patch');
});

test('bumps follow semver, with breaking changes staying minor below 1.0', () => {
  expect(bumpVersion('v0.1.0', 'patch')).toBe('0.1.1');
  expect(bumpVersion('v0.1.3', 'minor')).toBe('0.2.0');
  expect(bumpVersion('v0.1.3', 'major')).toBe('0.2.0');
  expect(bumpVersion('v1.2.3', 'major')).toBe('2.0.0');
  expect(bumpVersion('v1.2.3', 'minor')).toBe('1.3.0');
  expect(() => bumpVersion('v1.2', 'patch')).toThrow();
});

test('the newest release tag wins and other v* tags are ignored', () => {
  expect(latestTag(repo({ tags: ['v1.10.0', 'v1.9.0', 'v0.1.0'] }))).toBe(
    'v1.10.0'
  );
  expect(latestTag(repo({ tags: ['v2-beta', 'v1.0.0'] }))).toBe('v1.0.0');
  expect(latestTag(repo({ tags: [] }))).toBeNull();
});

test('no tag means the one-time bootstrap has not run', () => {
  const decision = decide(repo({ messages: ['feat: a'] }));
  expect(decision.release).toBe(false);
  if (!decision.release) expect(decision.reason).toContain('bootstrap');
});

test('a commit that is already in a release is not released again', () => {
  expect(
    decide(repo({ tags: ['v0.2.0'], released: true, messages: ['feat: a'] }))
  ).toEqual({ release: false, reason: 'HEAD is already in v0.2.0.' });
});

test('no commits since the tag means nothing to release', () => {
  expect(decide(repo({ tags: ['v0.2.0'] })).release).toBe(false);
});

test('every merge after the tag releases the next version', () => {
  expect(
    decide(
      repo({
        tags: ['v0.2.0'],
        messages: ['Merge pull request #7 from x/y', 'feat: add a flag'],
      })
    )
  ).toEqual({ release: true, version: '0.3.0', previous: 'v0.2.0' });
});
