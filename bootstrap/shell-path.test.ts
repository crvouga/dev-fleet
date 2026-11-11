import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configurePosixShellPath } from './shell-path';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const bin = join(home, "tool's bin");
  const shims = join(home, 'tool shims');
  mkdirSync(bin);
  mkdirSync(shims);
  writeFileSync(join(shims, 'fleet-tool'), '#!/bin/sh\nprintf managed', {
    mode: 0o755,
  });
  return { home, bin, shims };
}

test.skipIf(!existsSync('/bin/bash'))(
  'PATH setup migrates old blocks before Bash early returns without clobbering user config',
  () => {
    const { home, bin, shims } = fixture();
    const startup = join(home, '.bashrc');
    const paths = `'${`${shims}:${bin}`.replaceAll("'", "'\\''")}'`;
    const legacy = `# dev-fleet toolchain\nexport PATH=${paths}:"$PATH"`;
    const user = 'case $- in *i*) ;; *) return ;; esac\n# user config\n';
    writeFileSync(startup, `${user}\n${legacy}\n`);
    writeFileSync(join(home, '.bash_profile'), '# existing login config\n');
    try {
      configurePosixShellPath(bin, shims, home, home);
      const first = readFileSync(startup, 'utf8');
      configurePosixShellPath(bin, shims, home, home);
      expect(readFileSync(startup, 'utf8')).toBe(first);
      expect(first).toContain(user);
      expect(first.match(/# dev-fleet toolchain/g)).toHaveLength(1);
      expect(readFileSync(join(home, '.bash_profile'), 'utf8')).toContain(
        '# existing login config'
      );
      const result = spawnSync('/bin/bash', ['-c', 'fleet-tool'], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { HOME: home, PATH: '/usr/bin:/bin', BASH_ENV: startup },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('managed');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
);

test.skipIf(!existsSync('/bin/zsh'))(
  'noninteractive zsh finds shims quietly and honors ZDOTDIR',
  () => {
    const { home, bin, shims } = fixture();
    const zdotdir = join(home, 'zsh config');
    try {
      configurePosixShellPath(bin, shims, home, zdotdir);
      expect(readdirSync(home)).not.toContain('.bash_profile');
      expect(readdirSync(home)).not.toContain('.zshenv');
      const result = spawnSync(
        '/bin/zsh',
        ['-c', 'fleet-tool; zsh -c \'fleet-tool; print -r -- "$PATH"\''],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: { HOME: home, ZDOTDIR: zdotdir, PATH: '/usr/bin:/bin' },
        }
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `managedmanaged${shims}:${bin}:/usr/bin:/bin\n`
      );
      expect(result.stderr).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
);

test.skipIf(!existsSync('/bin/bash'))(
  'pinned shims stay first even after later PATH edits in the same file',
  () => {
    const { home, bin, shims } = fixture();
    const stray = join(home, 'stray');
    mkdirSync(stray);
    writeFileSync(join(stray, 'fleet-tool'), '#!/bin/sh\nprintf stray', {
      mode: 0o755,
    });
    const startup = join(home, '.bashrc');
    // e.g. nvm or a vendor installer prepending its own bin later in the file
    writeFileSync(startup, `export PATH='${stray}':"$PATH"\n`);
    try {
      configurePosixShellPath(bin, shims, home, home);
      const first = readFileSync(startup, 'utf8');
      configurePosixShellPath(bin, shims, home, home);
      expect(readFileSync(startup, 'utf8')).toBe(first);
      const result = spawnSync('/bin/bash', ['-c', 'fleet-tool'], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { HOME: home, PATH: '/usr/bin:/bin', BASH_ENV: startup },
      });
      expect(result.stdout).toBe('managed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
);
