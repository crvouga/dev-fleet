# Disposable stand-in for a worker that has the operating system packages the
# Ubuntu baseline installs (Ansible among them) and boots with systemd, so the
# monitoring agent's playbook runs as it does on a worker. Pinned by index
# digest. Test tooling only; never a fleet node image.
FROM ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv ansible-core ca-certificates python3 util-linux && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
