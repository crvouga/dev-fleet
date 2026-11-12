# Provider accounts

**The rule.** Provider accounts exist only as the CLI proxy's credential files
on the manager. Every node and IDE gets a view derived from them, and nothing
on a node holds a provider login of its own. T3 offers one instance per
account, named `<Provider> <account email>`, and every launcher reaches the
provider through the proxy.

## The roster

```sh
npx devfleet fleet-accounts            # provider, index, label, state, when a cooldown clears
npx devfleet fleet-accounts --diff     # and what this machine offers against it
```

Each account has one state, derived from its credential file and the proxy's
management API:

| State             | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `usable`          | Serves requests                                                            |
| `cooling-down`    | The provider limited it; `until` says when it clears, when the proxy knows |
| `refresh-failing` | Its token refresh fails for now, and its access token is still valid       |
| `needs-login`     | The provider refused its refresh token: only signing in again helps        |
| `removed`         | Disabled on the proxy                                                      |

The index of an account is its position among its provider's accounts, sorted
by sign-in email. Checks name accounts by provider and index only.

The **roster version** is a digest of the routing prefixes of the accounts.
The manager computes it from the credential files and every node from the
proxy's model list, so the two agree exactly when a node offers what the
proxy holds.

## Checks

| Check                              | Fails when                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `proxy:account:<provider>`         | The provider has no usable account; it warns below `services.proxy.accounts.minimumUsable` (default 2) |
| `accounts:roster-current`          | The node offers another roster version than the proxy's                                                |
| `accounts:native-login`            | (warns) An agent CLI on the node keeps a provider login of its own                                     |
| `proxy:reachable-from`             | The node gets no answer from the proxy; it warns above two seconds                                     |
| `agent:<tool>:account-<n>:session` | That account's instance does not run a session; it warns while the account is cooling down             |
| `agent:<tool>:removed-<n>:session` | The node still offers an instance for an account the proxy no longer holds                             |

Session results are cached for six hours under a key that holds the roster
version and the version of the client key, so any account change or key
rotation re-verifies at once.

## Adding, signing in again, removing

```sh
npx devfleet fleet-accounts --add claude
npx devfleet fleet-accounts --relogin codex 2
npx devfleet fleet-accounts --remove codex 2
```

A sign-in writes into a staging directory beside the credentials; only a
complete credential is moved in, with one rename, so an interrupted sign-in
leaves nothing behind. Routing prefixes are applied in the same command. Every
change is then propagated to every node.

## Propagation without a full sync

```sh
npx devfleet fleet-sync --only accounts
```

On the manager and every worker at once, each node re-reads the proxy's
roster and rewrites only its per-account T3 instances. T3 watches its
settings, so nothing restarts and no running turn ends. Instance ids derive
from the account's routing prefix and stay the same. A node that cannot be
reached catches up on the next propagation or sync; until then
`accounts:roster-current` reports the version it has.

## Choosing an account

Unpinned requests go through a loopback relay on every node. When the fleet
declares a policy for a provider, the relay picks the account of each request:

```json
"services": {
  "proxy": {
    "endpoint": "https://cli-proxy.example.com",
    "accounts": {
      "minimumUsable": 2,
      "selection": {
        "codex": { "strategy": "fill-first", "order": ["a@example.com"] }
      }
    }
  }
}
```

| Strategy                 | Order                                            |
| ------------------------ | ------------------------------------------------ |
| `fill-first`             | The same order for every request                 |
| `round-robin`            | Each request starts one account further along    |
| `least-recently-limited` | The account limited longest ago (or never) first |

The order is the accounts `order` names, in that order, then the others in
the order of their routing prefix. A quota or authentication refusal sends
the request on to the next account, and the refused one cools down for its
`Retry-After` (a minute without one). Without a policy the proxy's own
fill-first pool chooses. An instance pinned to one account answers "This
account is cooling down until …" and names the other instances of its
provider.

## Proxy outages

Every relayed launch (Claude, Codex, Gemini and Antigravity, pinned or not)
retries a proxy that does not answer for about a minute. If it stays down,
the agent gets one distinct, retryable error: "The CLI proxy has been
unreachable since …".

## Checkpoints and the proxy state

Each checkpoint records a short digest of every credential's refresh token,
never the token. After restoring an older checkpoint, `restore-verify
RESTORED --newest NEWEST` names exactly the accounts whose refresh token the
provider has since replaced (`needs-login: <provider> <index>`).

`cliproxy/scripts/lease.py` is a fencing lease on the proxy state: a second
proxy cannot take it while the first holds it, and taking over an expired
lease fences the old holder.

## Client keys

`devfleet cliproxy issue-key|rotate-key|retire-key|revoke-key NODE` keep one
proxy client key per node in the manager's key ring. A rotation keeps the old
key accepted until `retire-key`, so no running agent fails while nodes move
over. Revoking one node's key leaves the others working.
`devfleet cliproxy client-keys` reports each node's key by fingerprint only.

## Not yet done

- The proxy does not notify anyone when an account turns `needs-login`, and
  no watcher on the manager triggers propagation or a checkpoint when a
  credential file changes. Run `fleet-sync --only accounts` or
  `fleet-accounts` instead.
- Nothing forces a refresh of every account after a restore. The digest
  comparison above is offline.
- The lease is not yet taken by the proxy service at start, and its
  production store (the checkpoint bucket) is not wired.
- Per-node client keys are not yet distributed to nodes through the secrets
  provider, so nodes still present the shared key. No
  `proxy:client-key-current` check exists yet.
- OpenCode and Grok read the proxy's address from rendered configuration and
  are not relayed yet. There is no warm standby proxy.
- The selection policy is applied by the client relay; the proxy itself stays
  fill-first.
- A sign-in uses the provider's device code where the proxy offers one.
  Other providers print a callback URL, and no loopback forward is managed
  for them.
