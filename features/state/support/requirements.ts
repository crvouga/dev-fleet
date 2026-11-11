import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/** What the scenarios that run the real Litestream need. They are skipped
 * where a piece is missing (the plain Check job), except where
 * DEVFLEET_TEST_LITESTREAM=required: the Fleet state job in CI installs the
 * toolchain and starts an S3 service, so there a missing piece fails.
 */
export const requirements = {
  /** The Litestream mise.toml pins is installed. */
  installed:
    spawnSync('mise', ['which', 'litestream'], {
      cwd: resolve(import.meta.dir, '../../..'),
      stdio: 'ignore',
    }).status === 0,
  /** Nothing may be skipped. */
  required: process.env['DEVFLEET_TEST_LITESTREAM'] === 'required',
  /** The origin of a throwaway S3 service, such as http://127.0.0.1:5000. */
  s3: process.env['DEVFLEET_TEST_S3'],
};

/** Whether a scenario carrying these tags is skipped here. */
export function skipped(tags: string[]): boolean {
  const { installed, required, s3 } = requirements;
  if (tags.includes('@required')) return !required;
  if (required) return false;
  return (
    (tags.includes('@litestream') && !installed) ||
    (tags.includes('@s3') && !s3)
  );
}
