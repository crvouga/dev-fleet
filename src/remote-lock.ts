/** POSIX lock prelude shared by every remote operation. Linux uses flock(1);
 * macOS lacks it, so the same descriptor is locked through Python's fcntl. The
 * lock belongs to the shell's open descriptor and persists until that exits.
 */
export function remoteLockPrelude(
  root = '"$HOME/.local/share/personal/fleet"'
): string {
  return [
    `exec 9>${root}/remote-operation.lock`,
    'if command -v flock >/dev/null 2>&1; then flock -n 9; else python3 -c "import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)" 9>&9; fi',
  ].join(' && ');
}
