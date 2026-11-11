# Cloud ownership and initial adoption

The initial workstation setup created runtime/cloud state before this package existed. Its operational code is now maintained here; installed copies are generated from committed blobs. The one-off Tailscale API provisioning and Vault secret-writing helpers are retired and removed during first package installation. They must not return as parallel infrastructure controllers.

Existing external resources are retained:

- Tailscale Service `svc:ai-proxy`, endpoint `tcp:443`, stable MagicDNS origin `https://ai-proxy.tail0a1b2c.ts.net`.
- Dedicated host tag `tag:ai-proxy` and optional client tag `tag:ai-client`, with owner/service approval and private access rules already in the tailnet. The original workstation identity/SSH/service route was preserved.
- Existing production R2 bucket and prefix `cliproxy-fleet/restic`; bucket and credentials already belong to the OpenTofu platform.
- Existing Vault `secret/personal/prd` fields `CLIPROXY_FLEET_RESTIC_PASSWORD`, `CLIPROXY_FLEET_CLIENT_API_KEY`, `CLIPROXY_FLEET_MANAGEMENT_KEY`, and operator-added `TAILSCALE_API_TOKEN`.

The new Vault field names still require reconciliation into `packages/infra/tofu/modules/inventory/inventory.tf.json` and the **complete** OpenTofu `vault_inputs` map before a later Vault apply. Preserve their existing values and every unrelated field. Use the established `bun run vault:fix`/`vault:edit` adoption workflow and a reviewed saved plan; never seed secrets directly from this package. The Tailscale admin token is no longer consumed by the runtime package and is not mounted into containers.

Before changing existing Tailscale cloud resources, adopt their identities and full policy through the platform's OpenTofu workflow. Do not replace the tailnet policy wholesale, recreate the Service/TailVIP, retag the workstation, or delete existing grants. Local `tailscale up` authorization and `serve` advertisement of an already defined resource are runtime operations; policy, tag ownership and Service definitions are infrastructure.

These are outstanding cloud-IaC reconciliation items, not hidden local scripts. Provider/authentication state, source-manifest metadata and the dedicated node identity are encrypted in R2 backups; recovery credentials are independently in Vault. Do not put live state, secrets, provider tokens or infrastructure plans into Git.
