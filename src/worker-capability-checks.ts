import policy from '../ansible/ubuntu/policy.json';
import type { Check, CommandResult, Runner } from './types';

/** What an agent does on a worker, tried the way it does it: start a
 * container, build an image, launch a headless browser. Each check runs as
 * the worker's user, in its session, and reports a code and a remedy, never
 * what a command printed.
 */

function failure(id: string, summary: string, action: string): Check {
  return { id, status: 'fail', summary, remedy: { action } };
}

/** Docker's own words for the causes an agent meets most. */
function dockerFailure(result: CommandResult): {
  code: string;
  action: string;
} {
  const said = `${result.stdout}\n${result.stderr}`;
  if (result.reason === 'timeout')
    return {
      code: 'DOCKER_RUN_TIMEOUT',
      action:
        'A container did not start and exit in time. Inspect the engine (systemctl status docker) and its disk; rerun fleet-sync.',
    };
  if (/permission denied[^\n]*docker\.sock/i.test(said))
    return {
      code: 'DOCKER_SOCKET_ACCESS_DENIED',
      action:
        "This session cannot use the Docker socket. fleet-sync adds the worker's user to the docker group; a session started before that keeps its old groups. Rerun fleet-sync, then restart the session (log out and in, or restart the T3 service).",
    };
  if (/cannot connect to the docker daemon/i.test(said))
    return {
      code: 'DOCKER_DAEMON_UNREACHABLE',
      action:
        'The Docker engine is not running. Rerun fleet-sync, which starts and enables docker.service.',
    };
  if (/no such image|pull access denied|not found/i.test(said))
    return {
      code: 'DOCKER_SMOKE_IMAGE_MISSING',
      action:
        'The pinned smoke-test image is not cached on this worker. Rerun fleet-sync, which pulls it once so this check works offline.',
    };
  if (/no space left on device/i.test(said))
    return {
      code: 'DOCKER_DISK_FULL',
      action:
        'The image store is full. Free space under /var/lib/docker (the disk GC prunes old images) and rerun fleet-sync.',
    };
  return {
    code: 'DOCKER_RUN_FAILED',
    action:
      'Docker answers but cannot run a container here. Inspect cgroups and the engine log (journalctl -u docker), then rerun fleet-sync.',
  };
}

/** Runs the pinned image offline, then builds a one-line image from it. */
export async function dockerRunCheck(run: Runner): Promise<Check> {
  const id = 'worker:docker-run';
  const { image, timeoutSeconds } = policy.dockerSmokeTest;
  const timeoutMs = timeoutSeconds * 1000;
  const started = await run(
    [
      'docker',
      'run',
      '--rm',
      '--network',
      'none',
      '--pull',
      'never',
      image,
      'true',
    ],
    { timeoutMs }
  );
  if (!started.ok) {
    const { code, action } = dockerFailure(started);
    return failure(id, code, action);
  }
  const built = await run(
    ['docker', 'build', '--quiet', '--pull=false', '--network', 'none', '-'],
    { input: `FROM ${image}\nRUN true\n`, timeoutMs }
  );
  if (!built.ok) {
    const { code, action } = dockerFailure(built);
    return failure(
      id,
      code === 'DOCKER_RUN_FAILED' ? 'DOCKER_BUILD_FAILED' : code,
      code === 'DOCKER_RUN_FAILED'
        ? 'A container runs but an image does not build. Inspect Buildx (docker buildx ls) and the image store, then rerun fleet-sync.'
        : action
    );
  }
  return {
    id,
    status: 'pass',
    summary:
      'A container of the pinned image ran and a one-line image built, offline, in this session.',
  };
}

/** Where `ansible/ubuntu/tasks/browser.yml` unpacks the pinned build. */
export function headlessShell(arch: string = process.arch): string {
  const { version, amd64, arm64 } = policy.browser.headlessShell;
  const build = arch === 'arm64' ? arm64 : amd64;
  const directory = build.archive.split('/').pop()!;
  return `/opt/personal-fleet/browser/${version}/${directory}/chrome-headless-shell`;
}

/** A worker with the web profile launches the pinned headless Chromium,
 * loads a blank page and exits, as a browser test would.
 */
export async function browserCheck(
  run: Runner,
  web: boolean,
  arch: string = process.arch
): Promise<Check> {
  const id = 'worker:browser';
  if (!web)
    return {
      id,
      status: 'skip',
      summary:
        'This worker does not select the web tool profile, so no browser is installed for tests.',
    };
  const launched = await run(
    [
      headlessShell(arch),
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--dump-dom',
      'about:blank',
    ],
    { timeoutMs: policy.browser.launchTimeoutSeconds * 1000 }
  );
  if (launched.ok && /<html/i.test(launched.stdout))
    return {
      id,
      status: 'pass',
      summary: `Headless Chromium ${policy.browser.headlessShell.version} launched, loaded a blank page and exited.`,
    };
  const said = `${launched.stdout}\n${launched.stderr}`;
  if (launched.reason === 'missing')
    return failure(
      id,
      'BROWSER_NOT_INSTALLED',
      'The pinned headless Chromium is not installed. Rerun fleet-sync, which installs it on workers with the web profile.'
    );
  if (/error while loading shared libraries/i.test(said))
    return failure(
      id,
      'BROWSER_LIBRARY_MISSING',
      'A system library headless Chromium loads is missing. Rerun fleet-sync, which installs the pinned libraries of the web profile.'
    );
  if (launched.reason === 'timeout')
    return failure(
      id,
      'BROWSER_LAUNCH_TIMEOUT',
      'Headless Chromium did not exit in time. Check the worker for memory pressure, then rerun fleet-sync.'
    );
  return failure(
    id,
    'BROWSER_LAUNCH_FAILED',
    'Headless Chromium did not load a blank page. Run it by hand with --dump-dom about:blank to see why, then rerun fleet-sync.'
  );
}
