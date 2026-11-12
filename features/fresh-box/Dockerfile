# Disposable stand-in for a brand-new Ubuntu machine right after someone set
# up SSH on it: an SSH server and a non-root account that can use sudo, and
# nothing else (no Git, curl, Python, Ansible, mise, Bun). One stage per
# accepted Ubuntu release, each pinned by index digest so it runs natively on
# amd64 and arm64 hosts; RELEASE chooses one (features/fresh-box/support/
# boxes.ts passes the release under test). Test tooling only; never a fleet
# node image.
ARG RELEASE=26.04
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS ubuntu-26.04
FROM ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5 AS ubuntu-24.04
# hadolint ignore=DL3006
FROM ubuntu-${RELEASE}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo openssh-server && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/sh fleettest \
  && printf 'fleettest ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/fleettest && chmod 0440 /etc/sudoers.d/fleettest \
  && mkdir -p /run/sshd \
  && echo 'ANSIBLE_LOG_PATH=/tmp/fleet-ansible.log' >>/etc/environment
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
