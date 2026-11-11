import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const guard = join(import.meta.dir, 'disk-guard.py');
/** Runs the guard's own selection logic against a fixture cgroup tree. */
function decide(root: string, previous: Record<string, number>, low: boolean) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('guard', sys.argv[1])
guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
current = guard.leaf_writes(sys.argv[2])
print(json.dumps({'current': current, 'victim': guard.choose_victim(json.loads(sys.argv[3]), current, sys.argv[4] == '1', 32 * 1024 * 1024)}))`;
  const out = Bun.spawnSync([
    'python3',
    '-I',
    '-B',
    '-c',
    script,
    guard,
    root,
    JSON.stringify(previous),
    low ? '1' : '0',
  ]);
  expect(out.exitCode).toBe(0);
  return JSON.parse(out.stdout.toString()) as {
    current: Record<string, number>;
    victim: [string, number] | null;
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'disk-guard-'));
  const leaf = (path: string, wbytes: number) => {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(
      join(root, path, 'io.stat'),
      `259:0 rbytes=1 wbytes=${wbytes} rios=1 wios=1\n`
    );
  };
  const MiB = 1024 * 1024;
  leaf('user-1000.slice/app.slice/t3code.service', 10 * MiB);
  leaf('user-1000.slice/app.slice/board-relay.service', 900 * MiB);
  leaf('user-1000.slice/app.slice/t3code-claude-a.scope', 100 * MiB);
  writeFileSync(
    join(root, 'user-1000.slice/io.stat'),
    'parent totals are ignored\n'
  );
  return { root, MiB };
}

test('below the floor, only the top runaway writer is chosen', () => {
  const { root, MiB } = fixture();
  const first = decide(root, {}, true);
  expect(first.victim).toBeNull();
  const previous = Object.fromEntries(
    Object.entries(first.current).map(([path, total]) => [
      path,
      path.endsWith('board-relay.service') ? total - 800 * MiB : total - MiB,
    ])
  );
  const { victim } = decide(root, previous, true);
  expect(victim?.[0]).toEndWith('board-relay.service');
  expect(victim?.[1]).toBe(800 * MiB);
});
test('with free space, or with only slow writers, nothing is killed', () => {
  const { root, MiB } = fixture();
  const current = decide(root, {}, false).current;
  const previous = Object.fromEntries(
    Object.entries(current).map(([p, t]) => [p, t - 800 * MiB])
  );
  expect(decide(root, previous, false).victim).toBeNull();
  const slow = Object.fromEntries(
    Object.entries(current).map(([p, t]) => [p, t - MiB])
  );
  expect(decide(root, slow, true).victim).toBeNull();
});
