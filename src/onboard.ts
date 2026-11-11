import { shellQuote } from './ssh';
import { syncPlan } from './sync';
import type { FleetNode } from './types';

export function onboarding(node: FleetNode, launcher = 'devfleet'): object {
  return {
    version: 1,
    node: node.id,
    applied: false,
    steps: [
      'On the new node, review and run bootstrap/bootstrap.sh (or bootstrap.ps1 for native Windows). Use docs/machine-setup.md. This installs the shared locked toolchain; it does not enable SSH.',
      'Enable the OS SSH service as the operator on a trusted private network. Do not expose SSH publicly or create cloud resources.',
      'Create a distinct per-machine SSH key and authorize its PUBLIC key on the destination. Verify host fingerprints out of band. Keep private keys and auth tokens on their original machines.',
      'In the manager SSH config, configure this alias with the real HostName, User, IdentityFile, optional Port/ProxyJump and IdentitiesOnly yes. Fleet will not write or overwrite SSH configuration.',
      'Test ssh ALIAS manually once after fingerprint verification. Ensure noninteractive shell startup writes no stdout. Set runtime to an absolute Node/Bun executable/shim if SSH PATH omits it.',
      'Authenticate separately on the node: gh auth login; gh auth setup-git; vault login using the approved method. Configure coding-provider sessions independently; never copy auth directories.',
      'For T3 Connect, review t3 status and t3 service status, then complete t3 up --connect and operator pairing/linking. T3 pairing/auth state is not an SSH credential.',
      'For VS Code, install Remote-SSH in the LOCAL editor profile, use the same SSH alias/client/config, enable the login terminal temporarily, and read Output → Remote - SSH. Restart the editor after PATH/agent changes.',
      'VS Code needs TCP forwarding and compatible remote server prerequisites. Test with ssh -N -L 127.0.0.1:18080:127.0.0.1:REMOTE_PORT ALIAS against a known loopback service, then curl localhost:18080 from a second terminal. Review server policy; never loosen it automatically.',
      'Run devfleet fleet-status --node NODE --json from every intended manager. This is directed connectivity, not an all-pairs proof. Review skipped T3/VS Code end-to-end checks manually.',
    ],
    sshTemplate: `Host ${node.ssh}\n  HostName REPLACE_WITH_PRIVATE_HOST\n  User REPLACE_WITH_USER\n  IdentityFile ~/.ssh/REPLACE_WITH_NODE_KEY\n  IdentitiesOnly yes\n  ForwardAgent no\n`,
    vscodeSettings: {
      'remote.SSH.path': 'REPLACE_WITH_SAME_OPENSSH_BINARY',
      'remote.SSH.configFile': 'REPLACE_WITH_ABSOLUTE_SSH_CONFIG',
      'remote.SSH.showLoginTerminal': true,
    },
    workspaceCommand: `cd -- ${shellQuote(node.workspace)}`,
    verifyCommand: `${launcher} fleet-status --node ${node.id} --json`,
    sync: {
      command: `${launcher} fleet-repair --node ${node.id} --repair workspace`,
      steps: syncPlan(false),
    },
  };
}
