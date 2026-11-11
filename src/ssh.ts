import type { CommandResult, FleetNode, Check } from './types';

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sshArgs(node: FleetNode): string[] {
  return [
    'ssh',
    '-T',
    '-a',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ServerAliveInterval=5',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    node.ssh,
  ];
}

export function remoteCommand(node: FleetNode, request: object): string[] {
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
  const command = `cd -- ${shellQuote(node.workspace)} && export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH" && exec ${shellQuote(node.runtime ?? 'node')} --input-type=module - ${shellQuote(encoded)}`;
  return [...sshArgs(node), command];
}

const FAILURES = [
  {
    pattern:
      /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i,
    id: 'ssh:host-key',
    summary: 'SSH host key is unknown or changed.',
    action:
      'Verify the host fingerprint out of band, then update known_hosts manually. Never disable host-key checking.',
  },
  {
    pattern:
      /Could not resolve hostname|Name or service not known|nodename nor servname/i,
    id: 'ssh:dns',
    summary: 'SSH hostname or jump-host resolution failed.',
    action:
      'Check the alias in ~/.ssh/config, DNS/VPN/Tailscale connectivity, and ProxyJump host resolution.',
  },
  {
    pattern:
      /Permission denied|sign_and_send_pubkey|agent refused|Too many authentication failures/i,
    id: 'ssh:auth',
    summary: 'SSH key/agent authentication failed.',
    action:
      'Use ssh-add -l and ssh -vvv ALIAS locally; check User, IdentityFile, IdentitiesOnly, agent/keychain access and authorized_keys. Do not share debug logs without review.',
  },
  {
    pattern: /Connection refused|No route to host|Network is unreachable/i,
    id: 'ssh:network',
    summary: 'SSH endpoint or jump host is unreachable/refused.',
    action:
      'Verify the node is awake, VPN is connected, sshd is enabled and the configured port is reachable. Do not open a public SSH port automatically.',
  },
  {
    pattern:
      /(?:bun|node).*not found|No such file or directory|cannot cd|can.t cd/i,
    id: 'ssh:runtime',
    summary:
      'Remote workspace or Node/Bun runtime is missing from the non-login SSH environment.',
    action:
      'Follow fleet-nodes --onboard; configure absolute workspace/runtime paths. GUI terminals and SSH shells may have different PATHs.',
  },
];

export function sshFailure(result: CommandResult): Check {
  if (
    /Tailscale SSH requires an additional check|To authenticate, visit: https:\/\/login\.tailscale\.com\//i.test(
      result.stderr
    )
  )
    return {
      id: 'ssh:tailscale-check',
      status: 'fail',
      summary: 'TAILSCALE_INTERACTIVE_AUTHORIZATION_REQUIRED',
      remedy: {
        action:
          'The current Tailscale SSH policy requires interactive reauthentication. Update the tailnet policy for the enrolled manager/worker scope, or enroll a separately verified OpenSSH key route. Fleet never bypasses trust or prompts for a password.',
      },
    };
  if (result.reason === 'timeout')
    return {
      id: 'ssh:timeout',
      status: 'fail',
      summary: 'SSH or remote probe exceeded its deadline.',
      remedy: {
        action:
          'Check sleeping nodes, VPN, ProxyJump, network reachability and noninteractive shell startup. Increase --timeout only after diagnosis.',
      },
    };
  if (result.reason === 'missing')
    return {
      id: 'ssh:missing',
      status: 'fail',
      summary: 'Cannot launch the local SSH client.',
      remedy: {
        action:
          'Install/enable the OS OpenSSH client and expose it to the terminal/editor PATH.',
      },
    };
  const match = FAILURES.find((failure) => failure.pattern.test(result.stderr));
  return {
    id: match?.id ?? 'ssh:probe',
    status: 'fail',
    summary:
      match?.summary ??
      `Remote probe failed (${result.reason}); raw output withheld.`,
    remedy: {
      action:
        match?.action ??
        'Run ssh ALIAS manually; verify workspace/runtime, shell startup output and CLI compatibility. Never paste credentials or full logs into agent context.',
    },
  };
}
