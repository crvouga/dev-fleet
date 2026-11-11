#!/usr/bin/env bun
/** Internal entry fleet-sync runs on each node for agent profile commands
 * (`agents apply|status|verify|run`). People use `devfleet workstation agents`.
 */
import { Command } from 'commander';
import { registerAgents } from './command';

const program = new Command('fleet-agents')
  .option('--json', 'Machine-readable output')
  .option('--yes', 'Apply without confirmation')
  .option('--non-interactive', 'Fail instead of prompting');
registerAgents(program, () => program.opts());
await program.parseAsync(process.argv);
