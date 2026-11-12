import type { CommandResult, FleetNode, Check } from './types';
import { fleet } from './fleet-config';
import {
  connectionOptions,
  declaredConnection,
  renderKnownHosts,
  SSH_SESSION,
  SSH_TRANSPORT,
  sshOptionArgs,
} from './ssh-connection';

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The worker fleet.json declares for a roster entry that is reached from
 * declared data, if it is one. No configuration (a fresh machine) is none.
 */
function declaredWorker(node: Pick<FleetNode, 'id' | 'ssh'>) {
  try {
    const worker = declaredConnection(
      fleet.workers.find((entry) => entry.id === node.id)
    );
    return worker && worker.network.tailscaleName === node.ssh ? worker : null;
  } catch {
    return null;
  }
}

/** One SSH session to a node: unattended, strict about the host key,
 * forwarding nothing. A worker without an alias is reached from its declared
 * user, port and tailnet name, against the fleet-owned known_hosts.
 */
export function sshArgs(node: Pick<FleetNode, 'id' | 'ssh'>): string[] {
  const declared = declaredWorker(node);
  return [
    'ssh',
    '-T',
    '-a',
    ...sshOptionArgs(SSH_TRANSPORT),
    ...(declared
      ? sshOptionArgs(connectionOptions(declared, renderKnownHosts(fleet)))
      : []),
    ...sshOptionArgs(SSH_SESSION),
    node.ssh,
  ];
}

/** How a package playbook that addresses a worker over SSH itself
 * (ansible/ubuntu/worker-account.yml, ansible/ubuntu/reboot.yml) reaches it:
 * the options every direct session takes, as one `ansible_ssh_common_args`
 * value, and the account a worker reached from declared data logs in as. The
 * play names the login itself (root, or the declared account), so the
 * declared user is not among the options.
 */
export function playbookConnection(node: Pick<FleetNode, 'id' | 'ssh'>): {
  options: string;
  user: string | null;
} {
  const declared = declaredWorker(node);
  const options = [
    ...SSH_TRANSPORT,
    ...(declared
      ? connectionOptions(declared, renderKnownHosts(fleet)).filter(
          ([name]) => name !== 'User'
        )
      : []),
  ];
  return {
    options: sshOptionArgs(options)
      .map((arg) => (arg === '-o' ? arg : shellQuote(arg)))
      .join(' '),
    user: declared?.network.user ?? null,
  };
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
      'The worker presented a host key other than the pinned one. Verify its fingerprint out of band, then pin the new key: devfleet fleet-node-replace --id ID --host-key "TYPE BASE64" --apply --yes, or change hostKey in its worker record. A worker reached through your own SSH alias is checked against your known_hosts instead. Never disable host-key checking.',
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
    pattern:
      /Connection (?:to \S+ )?closed|Connection reset|Broken pipe|Timeout, server \S+ not responding|client_loop: send disconnect/i,
    id: 'ssh:disconnected',
    summary: 'The SSH session was lost while the operation ran.',
    action:
      'The worker keeps running what it started. Rerun fleet-sync: it follows the operation of the same revision to its end. Check the network between the manager and the worker if it repeats.',
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
