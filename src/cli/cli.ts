#!/usr/bin/env node
import { main } from './app';
import { useProjectConfig } from './project';
import { actAsOperator } from '../state/operator';
import { databasePath } from '../state/paths';
import { readDocument } from '../state/store';
import { readPinsWith } from '../ssh-connection';
import { readPins } from '../state/workers';

actAsOperator((root) => readDocument(databasePath(root), 'definition'));
// Host keys pinned in the fleet state reach the fleet-owned known_hosts.
readPinsWith(() => readPins());
useProjectConfig();

try {
  process.exitCode = await main();
} catch (error) {
  const cancelled =
    error instanceof Error &&
    ['ExitPromptError', 'AbortPromptError'].includes(error.name);
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      ok: false,
      code: cancelled ? 'cancelled' : 'operation_failed',
      error: cancelled
        ? 'Cancelled; no further actions will run.'
        : 'Command failed. Inspect the local setup; raw errors are withheld to protect credentials.',
    })}\n`
  );
  process.exitCode = cancelled ? 130 : 1;
}
