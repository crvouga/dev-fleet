import policy from '../ansible/ubuntu/policy.json';
import {
  DEFAULT_FEATURES,
  workerFeatures,
  type WorkerFeatures,
} from '../bootstrap/worker-features';
import type { Check, Runner } from './types';

export { DEFAULT_FEATURES, workerFeatures, type WorkerFeatures };

/** What dev-fleet installs for a feature, as `features` in
 * ansible/ubuntu/policy.json declares it. */
export interface FeatureParts {
  packages: string[];
  services: string[];
  groups: string[];
  tools: string[];
}

const NONE: FeatureParts = {
  packages: [],
  services: [],
  groups: [],
  tools: [],
};

function parts(name: keyof typeof policy.features): FeatureParts {
  return { ...NONE, ...policy.features[name] };
}

/** What a worker with these features does not get: the parts of each
 * feature that is off. The same lists `tasks/features.yml` leaves out. */
export function partsOff(features: WorkerFeatures): FeatureParts {
  const off = [
    ...(features.containers ? [] : [parts('containers')]),
    ...(features.session === 'headless' ? [parts('desktop')] : []),
  ];
  return {
    packages: off.flatMap((entry) => entry.packages),
    services: off.flatMap((entry) => entry.services),
    groups: off.flatMap((entry) => entry.groups),
    tools: off.flatMap((entry) => entry.tools),
  };
}

/** Why a part is not on this worker, for the summary of its check. */
export function offReason(features: WorkerFeatures, part: string): string {
  const containers = parts('containers');
  if (
    !features.containers &&
    Object.values(containers).some((list: string[]) => list.includes(part))
  )
    return 'containers are off for this worker (features.containers)';
  return 'this worker runs a headless session (features.session), which has no desktop';
}

/** A check that does not apply to this worker, with the reason. */
export function notApplicable(id: string, reason: string): Check {
  return {
    id,
    status: 'not-applicable',
    summary: `Not applicable: ${reason}.`,
  };
}

/** The packages and always-on services a worker with these features is
 * measured against: the policy's, less the parts of the features it lacks. */
export function declaredFor<
  T extends { packages: Record<string, string>; alwaysOnServices: string[] },
>(declared: T, features: WorkerFeatures): T {
  const off = partsOff(features);
  return {
    ...declared,
    packages: Object.fromEntries(
      Object.entries(declared.packages).filter(
        ([name]) => !off.packages.includes(name)
      )
    ),
    alwaysOnServices: declared.alwaysOnServices.filter(
      (name) => !off.services.includes(name)
    ),
  };
}

/** What switching a worker from one set of features to another removes,
 * in the words `fleet-sync --dry-run` prints. Turning a feature on removes
 * nothing; turning the session to headless retires the desktop unit and keeps
 * ~/.t3. */
export function featureRemovals(
  before: WorkerFeatures,
  after: WorkerFeatures,
  user: string
): string[] {
  const removed: string[] = [];
  if (before.containers && !after.containers) {
    const off = parts('containers');
    removed.push(
      ...off.packages.map((name) => `package ${name}`),
      ...off.services.map(
        (name) => `service ${name}.service (with its package)`
      ),
      ...off.groups.map((name) => `${user}'s membership of the ${name} group`),
      ...off.tools.map((name) => `tool ${name}`),
      'the Docker step of the disk GC'
    );
  }
  if (before.session !== after.session)
    removed.push(
      after.session === 'headless'
        ? 'user unit t3code-desktop.service (the T3 desktop app stops; ~/.t3 is kept)'
        : 'user unit t3code-headless.service (the T3 server stops; ~/.t3 is kept)'
    );
  return removed;
}

/** What of a feature's parts is on this machine now. */
export interface PresentParts {
  packages: string[];
  groups: string[];
}

/** Reads which parts of a `containers` feature that is off are still
 * installed: the packages dpkg holds as installed, and the developer's
 * groups. A headless worker installs no desktop package but removes none
 * either: a desktop the machine came with may depend on them. */
export async function presentParts(
  run: Runner,
  user: string,
  features: WorkerFeatures
): Promise<PresentParts> {
  const off = features.containers ? NONE : parts('containers');
  if (!off.packages.length && !off.groups.length)
    return { packages: [], groups: [] };
  const listed = off.packages.length
    ? await run([
        'dpkg-query',
        '-W',
        '-f=${Package}\t${db:Status-Abbrev}\n',
        ...off.packages,
      ])
    : { stdout: '' };
  const installed = listed.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(
      ([name, status]) =>
        off.packages.includes(name ?? '') && status?.startsWith('ii')
    )
    .map(([name]) => name!);
  const groups = off.groups.length ? await run(['id', '-nG', user]) : null;
  const member = groups?.ok ? groups.stdout.trim().split(/\s+/) : [];
  return {
    packages: installed,
    groups: off.groups.filter((group) => member.includes(group)),
  };
}

const REMOVAL_INCOMPLETE = 'WORKER_FEATURE_REMOVAL_INCOMPLETE';

/** `worker:features`: the worker has the features fleet.json declares, and
 * nothing dev-fleet installed for a feature it turned off remains. `before`,
 * when given, is what was present before this run: the difference is what
 * the run removed, and it is reported. */
export function featuresCheck(
  features: WorkerFeatures,
  present: PresentParts,
  before?: PresentParts
): Check {
  const declared = `containers ${features.containers ? 'on' : 'off'}, ${features.session} session`;
  const remaining = [
    ...present.packages.map((name) => `package ${name}`),
    ...present.groups.map((name) => `membership of the ${name} group`),
  ];
  if (remaining.length)
    return {
      id: 'worker:features',
      status: 'fail',
      summary: `${REMOVAL_INCOMPLETE}: ${declared}; still present: ${remaining.join(', ')}.`,
      remedy: {
        action:
          'Rerun fleet-sync, which removes what dev-fleet installed for a feature that is off, and read the ubuntu:baseline output. A package another package depends on stays until a person removes that one.',
      },
    };
  const removed = before
    ? [
        ...before.packages
          .filter((name) => !present.packages.includes(name))
          .map((name) => `package ${name}`),
        ...before.groups
          .filter((name) => !present.groups.includes(name))
          .map((name) => `membership of the ${name} group`),
      ]
    : [];
  return {
    id: 'worker:features',
    status: 'pass',
    summary: removed.length
      ? `Declared features (${declared}); this run removed ${removed.join(', ')}.`
      : `Declared features (${declared}); nothing of a feature that is off is installed.`,
  };
}
