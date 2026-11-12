# Workers from infrastructure as code: an example, with a local virtual
# machine (libvirt) standing in for the provider. Any tool or provider that
# can boot a stock Ubuntu image with cloud-init user data and write a file
# works the same way; dev-fleet never calls a provider and never creates a
# machine. It reads the worker records this writes (worker-records.json, see
# schema/worker-record.schema.json) because fleet.json names the file:
#
#   "workerRecords": [{ "file": "infra/worker-records.json" }]
#
# The handoff, from the fleet project (OpenTofu installed, libvirt on this
# machine):
#
#   1. Declare the worker. With only `tailnet_name` and `user` set, this
#      writes its record and creates nothing else:
#        tofu -chdir=infra apply -var-file=workers.tfvars
#   2. Seed it. dev-fleet generates its host key, pins it in the fleet state
#      and writes the cloud-init user data:
#        npx devfleet fleet-node-seed --id rented-one \
#          --output infra/seed/rented-one.yaml --apply --yes --json
#      Put the path in `seed` (and, if you like, the printed hostKey in
#      `host_key`, so that the record carries it too).
#   3. Create the machine, then converge it:
#        tofu -chdir=infra apply -var-file=workers.tfvars
#        npx devfleet fleet-sync --non-interactive
#   4. Remove it: drop it from `workers` and apply, or `tofu destroy`. Its
#      record is gone, so the next `npx devfleet fleet-sync` retires it: its
#      token, pinned host key, monitoring system and T3 link are removed.
#
# This example cannot be applied in dev-fleet's CI (it needs a libvirt host
# and a tailnet), so it is not proven there; the record format and what
# fleet-sync does with records are (features/cli/fleet-validate.feature,
# features/fleet-sync/node-lifecycle.feature). Pin the provider in your own
# project: `tofu init` writes .terraform.lock.hcl.

terraform {
  required_providers {
    libvirt = { source = "dmacvicar/libvirt" }
    local   = { source = "hashicorp/local" }
  }
}

provider "libvirt" {
  uri = "qemu:///system"
}

variable "ubuntu_image" {
  description = "A stock Ubuntu cloud image (a URL or a local path) of the release fleet.json names."
  type        = string
}

variable "workers" {
  description = "The workers, by fleet ID. A worker with a seed is created; one without is only declared."
  type = map(object({
    tailnet_name = string
    user         = string
    seed         = optional(string)
    host_key     = optional(string)
    memory_mib   = optional(number, 8192)
    vcpus        = optional(number, 4)
    hourly_rate  = optional(number)
  }))
}

locals {
  seeded = { for id, worker in var.workers : id => worker if worker.seed != null }
}

resource "libvirt_volume" "image" {
  name   = "devfleet-ubuntu.qcow2"
  source = var.ubuntu_image
}

resource "libvirt_volume" "disk" {
  for_each       = local.seeded
  name           = "${each.key}.qcow2"
  base_volume_id = libvirt_volume.image.id
  size           = 64 * 1024 * 1024 * 1024
}

resource "libvirt_cloudinit_disk" "seed" {
  for_each  = local.seeded
  name      = "${each.key}-seed.iso"
  user_data = file(each.value.seed)
}

resource "libvirt_domain" "worker" {
  for_each  = local.seeded
  name      = each.key
  memory    = each.value.memory_mib
  vcpu      = each.value.vcpus
  cloudinit = libvirt_cloudinit_disk.seed[each.key].id

  disk {
    volume_id = libvirt_volume.disk[each.key].id
  }

  network_interface {
    network_name = "default"
  }
}

# The handoff: one record per declared worker. Only what dev-fleet needs to
# reach the machine, and nothing that names this tool or the provider.
resource "local_file" "worker_records" {
  filename        = "${path.module}/worker-records.json"
  file_permission = "0644"
  content = jsonencode({
    version = 1
    workers = [
      for id, worker in var.workers : merge(
        { id = id, tailnetName = worker.tailnet_name, user = worker.user },
        worker.host_key == null ? {} : { hostKey = worker.host_key },
        worker.hourly_rate == null ? {} : { billing = { hourlyRate = worker.hourly_rate } },
        { labels = { source = "local-vm" } },
      )
    ]
  })
}

output "fleet_workers" {
  description = "The same records, for a fleet.json that runs a command instead: { \"command\": [\"tofu\", \"-chdir=infra\", \"output\", \"-json\", \"fleet_workers\"] }."
  value       = jsondecode(local_file.worker_records.content)
}
