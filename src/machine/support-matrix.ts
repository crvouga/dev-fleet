import macos from '../../ansible/macos/policy.json';
import platforms from '../../ansible/platforms.json';
import { UBUNTU_RELEASES } from '../platform/ubuntu-release';

export type SupportStatus = 'supported' | 'best effort' | 'refused';
export interface SupportRow {
  role: string;
  platform: string;
  versions: string;
  architectures: string;
  status: SupportStatus;
  note: string;
}

/** Every platform and what dev-fleet does with it, from the policies the code
 * reads: the supported rows from the macOS and Ubuntu policies, the rest from
 * ansible/platforms.json. docs/support-matrix.md is this table. */
export function supportMatrix(): SupportRow[] {
  return [
    {
      role: 'manager',
      platform: 'macOS',
      versions: `${macos.minimumMajorVersion} or newer`,
      architectures: macos.architectures.join(', '),
      status: 'supported',
      note: 'ansible/macos/policy.json',
    },
    ...UBUNTU_RELEASES.map((entry): SupportRow => ({
      role: 'worker',
      platform: 'Ubuntu',
      versions: `${entry.release} (${entry.codename})`,
      architectures: entry.architectures.join(', '),
      status: 'supported',
      note: 'ansible/ubuntu/policy.json; a machine of its own, physical or virtual',
    })),
    ...platforms.rows.map((row): SupportRow => ({
      role: row.role,
      platform: row.platform,
      versions: row.versions,
      architectures: row.architectures,
      status: row.status as SupportStatus,
      note: row.note,
    })),
  ];
}

export function renderSupportMatrix(rows = supportMatrix()): string {
  const header = [
    'Role',
    'Platform',
    'Versions',
    'Architectures',
    'Status',
    'Note',
  ];
  const cells = rows.map((row) => [
    row.role,
    row.platform,
    row.versions,
    row.architectures,
    row.status,
    row.note,
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...cells.map((line) => line[index]!.length))
  );
  const line = (values: string[]) =>
    `| ${values.map((value, index) => value.padEnd(widths[index]!)).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...cells.map(line),
  ].join('\n');
}

if (import.meta.main) process.stdout.write(`${renderSupportMatrix()}\n`);
