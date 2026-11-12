# Disposable stand-in for a manager or a worker on a private network: a stock
# Ubuntu that boots with systemd and has what the Tailscale play and the
# fleet firewall need (Ansible, its APT bindings, nftables, an SSH server).
# The play installs the pinned Tailscale itself. Pinned by index digest. Test
# tooling only; never a fleet node image.
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv ansible-core python3 python3-apt ca-certificates curl iproute2 nftables openssh-server util-linux && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
