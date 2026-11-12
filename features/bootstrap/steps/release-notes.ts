import { expect } from 'bun:test';
import { releaseNotes } from '../../../bootstrap/release-notes';
import { steps } from '../../support/gherkin';
import { lines, part, type BootstrapWorld } from './world';

export const notes = steps<BootstrapWorld>();
const { When, Then } = notes;

const written = part(() => ({ text: '' }));

When('the notes are written for these commits:', (world, commits: string) => {
  written(world).text = releaseNotes(
    commits.split(/^---$/m).map((message) => message.trim())
  );
});

Then('the notes are:', (world, expected: string) => {
  expect(written(world).text).toBe(lines(expected));
});
