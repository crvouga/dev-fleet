export type AutomatedRepair = 'workspace' | 'workstation' | 'providers';
export interface RepairRecipe {
  id: string;
  title: string;
  owner: string;
  automatic: boolean;
  action: string;
  commands: string[][];
}
const login = (
  id: string,
  title: string,
  commands: string[][],
  action: string
): RepairRecipe => ({
  id: `login:${id}`,
  title,
  owner: `${id} native CLI`,
  automatic: false,
  action,
  commands,
});
export const REPAIR_RECIPES: RepairRecipe[] = [
  {
    id: 'workspace',
    title: 'Install locked tools and frozen dependencies',
    owner: 'mise / bootstrap/setup.ts',
    automatic: true,
    action:
      'Runs the existing shared setup and trusted checkout lifecycle scripts. Updates user mise/PATH configuration and writes a sync receipt. Does not pull or reset Git.',
    commands: [
      [
        'mise',
        'exec',
        '--locked',
        'bun',
        '--',
        'bun',
        'bootstrap/setup.ts',
        '--non-interactive',
      ],
    ],
  },
  {
    id: 'workstation',
    title: 'Install the devfleet launcher',
    owner: 'dev-fleet',
    automatic: true,
    action:
      'Links ~/.local/bin/devfleet to this checkout of dev-fleet (refused for an installed package, which is not one). Nothing is copied and no configuration is changed.',
    commands: [['sh', 'bootstrap/install-launcher.sh']],
  },
  {
    id: 'providers',
    title: "Refresh this machine's own service credentials",
    owner: 'dev-fleet',
    automatic: true,
    action:
      "Renews this machine's own secrets-provider session and the service logins derived from it. No credentials are copied from another computer.",
    commands: [['bun', 'bootstrap/worker-auth.ts']],
  },
  login(
    'codex',
    'Sign in to Codex on this machine',
    [['codex', 'login', '--device-auth']],
    'Approve the device flow in your browser. Run codex login status afterward; retain this machine’s own credential store.'
  ),
  login(
    'claude',
    'Sign in to Claude Code on this machine',
    [['claude', 'auth', 'login']],
    'Complete the native browser login, then run claude auth status --json. API-key and subscription contexts can differ.'
  ),
  login(
    'github',
    'Sign in to GitHub and configure Git',
    [
      [
        'gh',
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--web',
        '--git-protocol',
        'https',
      ],
      ['gh', 'auth', 'setup-git'],
    ],
    'Approve GitHub in the browser on the intended account, then run gh auth status --active. Environment tokens can override stored login; inspect their source locally.'
  ),
  login(
    'vault',
    'Authorize this machine for the shared Vault',
    [],
    'Run vault login -method=userpass username=YOUR_USERNAME in your own terminal. The native CLI prompts privately for the password. Use the existing permitted project/config; never copy VAULT_TOKEN between computers.'
  ),
  login(
    'railway',
    'Sign in to Railway',
    [['railway', 'login', '--browserless']],
    'Complete the browserless native flow, then run railway whoami --json.'
  ),
  login(
    'vercel',
    'Sign in to Vercel',
    [['vercel', 'login']],
    'Complete native login, then run vercel whoami. Select the intended team/project separately; do not create resources as a login repair.'
  ),
  login(
    'cloudflare',
    'Sign in to Cloudflare',
    [['wrangler', 'login', '--browser=false']],
    'Complete native OAuth login, then run wrangler whoami --json. For headless SSH, prefer an existing scoped API token injected by the approved Vault config. --browser=false suppresses browser launch; it does not make a remote loopback callback reachable. Any OAuth callback tunnel needs explicit operator setup. Resource access still depends on account permissions.'
  ),
  login(
    'aws',
    'Refresh the selected AWS SSO session',
    [['aws', 'sso', 'login']],
    'Configure the intended profile with aws configure sso first if needed. Login and the health check use this shell’s current profile; no access keys are cloned.'
  ),
  login(
    'npm',
    'Sign in to npm on this machine',
    [
      [
        'npm',
        'login',
        '--auth-type=web',
        '--registry=https://registry.npmjs.org/',
      ],
    ],
    'Complete the specific CLI approval and run npm whoami. Prefer the existing trusted-publisher CI workflow for releases.'
  ),
  login(
    'opencode',
    'Authorize an OpenCode provider',
    [['opencode', 'auth', 'login']],
    'Prefer the existing Vault-backed providers repair for managed API keys. Native auth login handles an operator-owned OAuth provider. Credential listing alone does not prove live provider access.'
  ),
  login(
    'copilot',
    'Sign in to Copilot',
    [['copilot', 'login']],
    'Complete native login; provider authorization still needs supported operator diagnostics. No model prompt is used for health checking.'
  ),
  login(
    'gemini',
    'Sign in to Gemini',
    [],
    'Open Gemini interactively and choose its supported sign-in flow. Provider authorization remains unverified without a supported read-only status adapter.'
  ),
  {
    id: 't3',
    title: 'Enable and authorize T3 Connect',
    owner: 'T3',
    automatic: false,
    action:
      'Run t3 up --connect in this machine’s terminal and approve the intended connection. Treat pairing material as private. Then check t3 status --json and perform an operator peer test.',
    commands: [['t3', 'up', '--connect']],
  },
  {
    id: 'docker',
    title: 'Start the intended Docker runtime',
    owner: 'OS / Docker',
    automatic: false,
    action:
      'Start Docker Desktop on desktop systems, or the already-installed Docker service using the OS service manager on Linux. Confirm the intended context with docker context ls. This repair never installs a daemon, invokes sudo, changes contexts or exposes a TCP socket.',
    commands: [
      ['docker', 'context', 'ls'],
      ['docker', 'info'],
    ],
  },
  {
    id: 'password-manager',
    title: 'Review shared human login onboarding',
    owner: 'password-manager / Bitwarden',
    automatic: false,
    action:
      'Use the existing password-manager doctor and actions list on this computer. Its setup guides native consent and Bitwarden enrollment. Keep its private state and OS credential store local. Password vault access does not authorize native CLI OAuth sessions; imports and rotations remain separate reviewed workflows.',
    commands: [
      ['bun', 'run', 'password-manager', 'doctor'],
      ['bun', 'run', 'password-manager', 'actions', 'list'],
    ],
  },
  {
    id: 'operator',
    title: 'Resolve the check with its owning tool',
    owner: 'operator / existing owner',
    automatic: false,
    action:
      'Follow the check’s remedy on the affected machine. Verify host fingerprints, register real SSH aliases/checkouts, reconcile Git changes, or perform the named end-to-end test. Infrastructure changes remain OpenTofu-owned.',
    commands: [],
  },
];
export const AUTOMATED_REPAIRS: AutomatedRepair[] = [
  'workspace',
  'workstation',
  'providers',
];
export function recipe(id: string): RepairRecipe {
  return (
    REPAIR_RECIPES.find((entry) => entry.id === id) ??
    REPAIR_RECIPES.find((entry) => entry.id === 'operator')!
  );
}
