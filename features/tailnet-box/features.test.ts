import { afterAll } from 'bun:test';
import { runFeatures } from '../support/gherkin';
import { TailnetBoxWorld, discardTailnetBox, tailnetBox } from './steps';

// A self-hosted control plane and three systemd machines on a private Docker
// network; the machines download the pinned Tailscale. Run on request, weekly
// and before every release (`DEVFLEET_TEST_TAILNET_BOX=required` there).
//   DEVFLEET_TEST_TAILNET_BOX=1 bun test features/tailnet-box
runFeatures({
  directory: import.meta.dir,
  steps: [tailnetBox],
  world: () => new TailnetBoxWorld(),
  skip: (tags) =>
    tags.includes('@tailnet-box') && !process.env['DEVFLEET_TEST_TAILNET_BOX'],
  // `@slow` scenarios get ten times this: the first one builds everything.
  timeoutMs: 180_000,
});

// Removing the machines can take longer than a hook's default five seconds.
afterAll(discardTailnetBox, 300_000);
