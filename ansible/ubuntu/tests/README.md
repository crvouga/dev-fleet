# Disposable Ubuntu reliability tests

Run from the repository root on Linux amd64 with Docker, KVM, the pinned Bun,
network access to the official release archives, and enough disk for a 12 GiB
sparse guest. This uses an isolated Ubuntu 26.04 VM; it never targets fleet hosts.
The test image is tooling, not a replacement OS image for development machines.

One command runs either test, the way the Ubuntu VM workflow runs it weekly
and before every release:

```sh
bun ansible/ubuntu/tests/run-vm.ts baseline    # the baseline tests below
bun ansible/ubuntu/tests/run-vm.ts bootstrap   # the full SSH bootstrap of HEAD
```

By hand, with a T3 archive as well:

```sh
fleet_test_dir=$(mktemp -d)
mkdir -p "$fleet_test_dir/vm" "$fleet_test_dir/t3" "$fleet_test_dir/verification"
docker build -t personal-fleet-test-tools ansible/ubuntu/tests
bun build ansible/ubuntu/tests/runtime-check.ts --compile --outfile "$fleet_test_dir/verification/verify"
curl --fail --location --proto '=https' https://github.com/pingdotgg/t3code/releases/download/v0.1.7/t3-0.1.7-linux-x64.tar.gz --output "$fleet_test_dir/t3/t3.tar.gz"
docker run --rm --device /dev/kvm \
  -v "$PWD:/workspace:ro" \
  -v "$fleet_test_dir/vm:/artifacts" \
  -v "$fleet_test_dir/t3:/t3:ro" \
  -v "$fleet_test_dir/verification:/verification:ro" \
  personal-fleet-test-tools
```

The harness verifies the Ubuntu image and T3 checksums before use. It generates
fixture SSH identities, trusts only that explicit host key, and uses QEMU's
private forwarded SSH port. It does not mount host credentials, host networking,
the Docker socket, or production application data. All VM logs and fixture keys
remain under the private temporary directory; do not publish that directory.
Reuse the directory for an existing-machine rerun; use a new directory for a
fresh-machine test. VM termination is bounded even after a failed assertion.

The tracked test covers:

- Real Ansible baseline application, a second no-change application, validated
  sudoers, sleep masks, lingering, fresh SSH after reboot, and preserved work.
- Injected owned SSH/power drift repaired by the unchanged source baseline,
  followed by a no-change run. A capacity-policy fault refuses changes without
  filling the disk or killing user work.
- Pinned native T3 installation, unchanged service PID on repeated setup,
  injected service crash recovery, loaded administrator policy, and reboot.
- Pinned stock Beszel hub, missing native Docker/Compose installation, repeated
  no-op, and container restart after reboot.
- Native Beszel agent installation through the production private-variable-file
  adapter, repeated no-op with unchanged PID, bounded crash recovery, and reboot.
  Injected nonsecret connection-setting drift is repaired by the production owner,
  followed by another no-change application.
  Its fixture hub deliberately resolves to guest loopback with no HTTPS listener.
  This proves failure isolation and service lifecycle, **not** authenticated metrics.
- The production boot-policy observer compiled into a disposable test executable
  and run after the guest reboot. That executable is never a deployed service.

Separately, `python3 ansible/monitoring/tests/upstream.py` runs real
pinned Beszel binaries with a disposable loopback hub. It checks supported account
and enrollment APIs, authenticated metrics, preserved registration/fingerprint,
and the supported backup/restore API. It uses no production accounts.

These tests do not prove multi-target manager bootstrap, intended-tailnet
connectivity, private TLS reachability, paired T3 execution, live provider accounts,
off-host disaster recovery, or every hardware/desktop configuration. Track those
separately in Fleet's acceptance issues. Never replace missing evidence with a
mocked pass, or run destructive fault injection against a live development box.

## Full SSH source/tool bootstrap

This opt-in variant calls the production `bootstrapRemote` transport against a
fresh guest. It removes the image's preinstalled Git **inside the disposable VM**
and asserts that Node, Bun, mise and Git are absent. It transfers a Git bundle at
one exact commit, runs the shared installer, requires a passing Ubuntu baseline,
then repeats to check preserved work, SSH identity and managed-file timestamps.
Missing Tailscale/provider credentials and paired T3 acceptance remain incomplete.
The test does not convert those failures into full fleet readiness.

Use a fresh private directory on a disk with at least 20 GiB free (the guest is a
64 GiB sparse disk; do not use a small `/tmp` tmpfs). The tested commit must contain
the implementation. Uncommitted edits are not included in the bundle.

```sh
fleet_test_dir=$(mktemp -d "$HOME/.cache/fleet-bootstrap.XXXXXX")
mkdir -p "$fleet_test_dir/vm" "$fleet_test_dir/source" "$fleet_test_dir/verification"
git rev-parse HEAD > "$fleet_test_dir/source/revision"
git bundle create "$fleet_test_dir/source/source.bundle" HEAD
git show HEAD:bootstrap/fleet-remote-bootstrap.sh > "$fleet_test_dir/source/bootstrap.sh"
bun build ansible/ubuntu/tests/bootstrap-check.ts --compile --outfile "$fleet_test_dir/verification/bootstrap"
docker run --rm --device /dev/kvm \
  -v "$PWD:/workspace:ro" \
  -v "$fleet_test_dir/vm:/artifacts" \
  -v "$fleet_test_dir/source:/bootstrap:ro" \
  -v "$fleet_test_dir/verification:/verification:ro" \
  personal-fleet-test-tools
```

Inspect `bootstrap-result.json` and `bootstrap-repeat-result.json` for redacted
phase evidence. A failed assertion preserves the guest disk for diagnosis and
terminates the VM. Keep fixture keys and raw diagnostic logs private. This is a
single-target production transport test; multi-target promotion and manager
restart/interruption scenarios remain separate gates.

## A fresh machine over SSH (any host with Docker)

The fastest check that a brand-new worker needs nothing but SSH and sudo is a
feature, [`features/fresh-box`](../../../features/fresh-box/fresh-box.feature).
It runs on amd64 and arm64 (including a Mac with Docker Desktop), needs no KVM,
takes about three minutes, and runs on every pull request:

```sh
DEVFLEET_TEST_FRESH_BOX=1 bun test features/fresh-box
```

It starts a disposable Ubuntu 26.04 container whose only extras are an SSH
server, a non-root user and `sudo` (it asserts Git, curl, Python, Ansible,
mise, Bun and Node are absent). It authorizes a new key, trusts the machine's
host key, and sends the committed `HEAD` through the production
`prepareBootstrap` and `bootstrapRemote` code over a real SSH connection with
the production options. It passes when the machine reaches node convergence
with the commit, the pinned toolchain, the exact operating system packages and
the fleet configuration in place, and when a second run transfers nothing and
finishes within two minutes. `DEVFLEET_TEST_FRESH_BOX=keep` leaves the
container for inspection.

A container has no systemd, desktop session, Tailscale or Vault login, so the
node checks that need them (baseline services, T3, provider accounts) are
printed, not asserted; the VM tests above cover the OS baseline and T3.
Uncommitted edits are not part of the tested revision.
