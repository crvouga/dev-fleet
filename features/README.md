# Features

What dev-fleet does is specified here, in Gherkin. A `.feature` file says what
is true in the words of someone who runs a fleet; the step definitions beside
it hold the mechanics. The TypeScript has no other tests; the CLI proxy's
Python package keeps its own under `cliproxy/tests`.

```sh
bun test                                 # every feature
bun test features/state                  # one area
DEVFLEET_TEST_FRESH_BOX=1 bun test features/fresh-box
```

## Layout

| Path                       | What                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| `<area>/*.feature`         | The specification of one area                                              |
| `<area>/steps.ts`          | That area's step definitions and its world (or `steps/*.ts` when large)    |
| `<area>/features.test.ts`  | Three lines that hand the area's features and steps to `bun test`          |
| `<area>/support/`          | Stand-ins and fixtures only that area uses                                 |
| `support/gherkin.ts`       | The runner: `steps()`, `World`, `DataTable`, `runFeatures()`               |
| `support/commands.ts`      | `Commands`: a scripted stand-in for every subprocess                       |
| `support/command-steps.ts` | Steps that say what each command answers, shared by areas that need them   |
| `support/fixtures.ts`      | A sample worker, commit and checkout                                       |
| `support/setup.ts`         | Loaded before every run: an empty fleet state and the example `fleet.json` |

Steps are scoped to their area: two areas may word a step the same way.

## Writing a feature

- **Say what is true, not how it is checked.** `Then the worker is refused` and
  not `Then parseWorker throws`. Use the words of the product: manager,
  workers, fleet configuration, fleet state, bucket, revision.
- **A scenario is a rule with an example.** Its name states the rule. Put the
  reason under the name when it is not obvious; that is where the comment of
  the test it replaces belongs.
- **Given** sets up a situation, **When** is the one thing that happens,
  **Then** is what can be observed afterwards. One `When` in a scenario.
- **Values live in the feature.** Inputs and expected results are written in
  the scenario: in the step, in a table, or in a doc string. A step must not
  hide them in code behind a name like `the usual fixture`.
- **A table of cases is a `Scenario Outline`.** Several inputs that follow one
  rule are rows of `Examples`, not copies of a scenario.
- **Shared situation is a `Background`,** or a `Rule` with its own background.
- **A `Then` asserts exactly what it says,** and nothing more quietly. If it
  says a file holds no secret, it reads the file.

## Writing steps

```ts
import { expect } from 'bun:test';
import { World, steps, type DataTable } from '../support/gherkin';

export class StateWorld extends World {
  report?: Report;
}
export const state = steps<StateWorld>();
const { Given, When, Then } = state;

Given('a bucket that holds no fleet state', (world) => { … });
When('the operator runs {string}', async (world, command: string) => { … });
Then('the report lists these checks:', (world, table: DataTable) => { … });
```

- A step gets the scenario's world, then what its expression captured
  (`{string}`, `{int}`, `{float}`, `{word}`, or the groups of a regular
  expression), then the table or doc string under it.
- Every scenario gets a new world. Anything to undo goes through
  `world.defer(() => …)`: temporary directories, environment variables, a
  changed working directory.
- Nothing real runs. A subprocess is answered by `Commands`, and no scenario
  contacts a machine, a bucket or an account. The exceptions say so in a tag
  and are skipped unless asked for: `@fresh-box` (a disposable container),
  and the Litestream scenarios in `state/`.
- Keep a step short and reusable. When two steps differ by a value, capture
  the value.

## Tags

A scenario that cannot run everywhere says so in a tag, and is reported as
skipped where it cannot.

| Tag           | Runs                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| `@slow`       | With ten times the area's timeout                                            |
| `@fresh-box`  | When `DEVFLEET_TEST_FRESH_BOX` is set; needs Docker and an SSH client        |
| `@litestream` | Where the pinned Litestream is installed; required in CI                     |
| `@s3`         | Where `DEVFLEET_TEST_S3` names a throwaway S3 service                        |
| `@required`   | Only where `DEVFLEET_TEST_LITESTREAM=required`, to prove nothing was skipped |
| `@posix`      | Not on Windows                                                               |
| `@linux`      | On Linux only                                                                |
| `@bash`       | Where `/bin/bash` exists                                                     |
| `@zsh`        | Where `/bin/zsh` exists                                                      |
