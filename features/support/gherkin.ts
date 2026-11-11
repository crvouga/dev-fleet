import { describe, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { generateMessages } from '@cucumber/gherkin';
import {
  IdGenerator,
  SourceMediaType,
  type Pickle,
  type PickleStep,
} from '@cucumber/messages';
import {
  CucumberExpression,
  ParameterTypeRegistry,
  RegularExpression,
} from '@cucumber/cucumber-expressions';

/** What dev-fleet does is written as Gherkin features; this runs them under
 * `bun test`. Each `.feature` file is a group of tests, each scenario (and
 * each row of a scenario outline) one test. A scenario gets a new world, runs
 * its steps in order and stops at the first that fails.
 */

/** A table written under a step. */
export class DataTable {
  constructor(private readonly cells: string[][]) {}
  /** Every row, the header included. */
  raw(): string[][] {
    return this.cells.map((row) => [...row]);
  }
  /** The rows under the header. */
  rows(): string[][] {
    return this.raw().slice(1);
  }
  /** One object for each row under the header, keyed by the header. */
  hashes(): Record<string, string>[] {
    const [header = [], ...rows] = this.cells;
    return rows.map((row) =>
      Object.fromEntries(header.map((key, index) => [key, row[index] ?? '']))
    );
  }
  /** A table of two columns, as one object: first column to second. */
  rowsHash(): Record<string, string> {
    return Object.fromEntries(
      this.cells.map((row) => [row[0] ?? '', row[1] ?? ''])
    );
  }
  /** A table of one column, as a list. */
  list(): string[] {
    return this.cells.map((row) => row[0] ?? '');
  }
}

/** The state of one scenario. A step keeps what a later step needs on it and
 * registers anything to undo with `defer`.
 */
export class World {
  private readonly deferred: (() => unknown)[] = [];
  /** Runs after the scenario, pass or fail, last registered first. */
  defer(undo: () => unknown): void {
    this.deferred.push(undo);
  }
  async cleanup(): Promise<void> {
    for (const undo of this.deferred.splice(0).reverse()) await undo();
  }
}

// A step receives the world, then what its expression captured, then the
// table or text written under it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StepFunction<W> = (world: W, ...captured: any[]) => unknown;
interface Definition<W> {
  source: string;
  expression: CucumberExpression | RegularExpression;
  run: StepFunction<W>;
}
type Define<W> = (expression: string | RegExp, run: StepFunction<W>) => void;

export interface Steps<W> {
  /** The same registry under three names, so a definition reads as its step. */
  Given: Define<W>;
  When: Define<W>;
  Then: Define<W>;
  definitions: Definition<W>[];
}

const parameters = new ParameterTypeRegistry();

/** The step definitions of one area. `{string}`, `{int}`, `{float}` and
 * `{word}` capture; a regular expression captures its groups.
 */
export function steps<W extends World = World>(): Steps<W> {
  const definitions: Definition<W>[] = [];
  const define: Define<W> = (expression, run) => {
    definitions.push({
      source: String(expression),
      expression:
        typeof expression === 'string'
          ? new CucumberExpression(expression, parameters)
          : new RegularExpression(expression, parameters),
      run,
    });
  };
  return { Given: define, When: define, Then: define, definitions };
}

function argument(step: PickleStep): unknown[] {
  const { dataTable, docString } = step.argument ?? {};
  if (dataTable)
    return [
      new DataTable(
        dataTable.rows.map((row) => row.cells.map((cell) => cell.value))
      ),
    ];
  return docString ? [docString.content] : [];
}

function bind<W>(
  step: PickleStep,
  definitions: Definition<W>[]
): (world: W) => unknown {
  const matches = definitions.flatMap((definition) => {
    const captured = definition.expression.match(step.text);
    return captured ? [{ definition, captured }] : [];
  });
  if (matches.length === 0)
    throw new Error(`No step is defined for: ${step.text}`);
  if (matches.length > 1)
    throw new Error(
      `More than one step matches "${step.text}": ${matches
        .map((match) => match.definition.source)
        .join(' and ')}`
    );
  const { definition, captured } = matches[0]!;
  return (world) =>
    definition.run(
      world,
      ...captured.map((value) => value.getValue(null)),
      ...argument(step)
    );
}

interface Feature {
  name: string;
  pickles: Pickle[];
}

function parse(path: string, uri: string): Feature {
  const envelopes = generateMessages(
    readFileSync(path, 'utf8'),
    uri,
    SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
    {
      includeGherkinDocument: true,
      includePickles: true,
      newId: IdGenerator.incrementing(),
    }
  );
  const errors = envelopes.flatMap((envelope) => envelope.parseError ?? []);
  if (errors.length > 0)
    throw new Error(
      `${uri}: ${errors.map((error) => error.message).join('; ')}`
    );
  const feature = envelopes.find((envelope) => envelope.gherkinDocument)
    ?.gherkinDocument?.feature;
  if (!feature) throw new Error(`${uri}: no feature`);
  return {
    name: feature.name,
    pickles: envelopes.flatMap((envelope) => envelope.pickle ?? []),
  };
}

function featureFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.feature'))
    .sort()
    .map((path) => join(directory, path));
}

/** Two rows of an outline share the scenario's name; number the later ones. */
function titles(pickles: Pickle[]): string[] {
  const seen = new Map<string, number>();
  return pickles.map((pickle) => {
    const count = (seen.get(pickle.name) ?? 0) + 1;
    seen.set(pickle.name, count);
    return count === 1 ? pickle.name : `${pickle.name} (example ${count})`;
  });
}

export interface RunOptions<W extends World> {
  /** The directory whose `.feature` files to run, subdirectories included. */
  directory: string;
  /** Every registry these features use. */
  steps: Steps<W>[];
  /** A new world for each scenario. */
  world: () => W;
  /** Scenarios carrying one of these tags are reported as skipped. */
  skip?: (tags: string[]) => boolean;
  /** For one scenario; `@slow` scenarios get ten times as long. */
  timeoutMs?: number;
}

/** Registers every scenario under `directory` as a test. A step with no
 * definition, or with two, fails its scenario when it runs.
 */
export function runFeatures<W extends World>(options: RunOptions<W>): void {
  const definitions = options.steps.flatMap((registry) => registry.definitions);
  const timeout = options.timeoutMs ?? 10_000;
  // A failure names the step it happened in, above the assertion's own text.
  const run = async (step: PickleStep, world: W): Promise<void> => {
    try {
      await bind(step, definitions)(world);
    } catch (error) {
      if (error instanceof Error)
        error.message = `In step: ${step.text}\n${error.message}`;
      throw error;
    }
  };
  for (const path of featureFiles(options.directory)) {
    const feature = parse(path, relative(options.directory, path));
    const names = titles(feature.pickles);
    describe(feature.name, () => {
      feature.pickles.forEach((pickle, index) => {
        const tags = pickle.tags.map((tag) => tag.name);
        const register = options.skip?.(tags) ? test.skip : test;
        register(
          names[index]!,
          async () => {
            const world = options.world();
            try {
              for (const step of pickle.steps) await run(step, world);
            } finally {
              await world.cleanup();
            }
          },
          tags.includes('@slow') ? timeout * 10 : timeout
        );
      });
    });
  }
}

/** The scenarios of one feature's text (each row of an outline is one), with
 * how many steps each has of every keyword. `And` and `But` count as the
 * keyword they continue.
 */
export function scenariosOf(
  source: string
): { name: string; keywords: Record<string, number> }[] {
  const envelopes = generateMessages(
    source,
    'feature',
    SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
    {
      includeGherkinDocument: false,
      includePickles: true,
      newId: IdGenerator.incrementing(),
    }
  );
  const KEYWORD = { Context: 'Given', Action: 'When', Outcome: 'Then' };
  return envelopes.flatMap(({ pickle }) => {
    if (!pickle) return [];
    const keywords: Record<string, number> = {};
    for (const step of pickle.steps) {
      const keyword = KEYWORD[step.type as keyof typeof KEYWORD];
      if (keyword) keywords[keyword] = (keywords[keyword] ?? 0) + 1;
    }
    return [{ name: pickle.name, keywords }];
  });
}
