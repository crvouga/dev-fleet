export type CheckSeverity = 'pass' | 'warn' | 'fail';

/** One human-readable health finding, with an optional fix to run. */
export type DoctorCheck = {
  id: string;
  label: string;
  severity: CheckSeverity;
  detail: string;
  fix?: string | undefined;
};
