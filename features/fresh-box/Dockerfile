# Disposable stand-in for a brand-new Ubuntu machine right after someone set
# up SSH on it: an SSH server and a non-root account that can use sudo, and
# nothing else (no Git, curl, Python, Ansible, mise, Bun). Pinned by index
# digest so it runs natively on amd64 and arm64 hosts. Test tooling only;
# never a fleet node image.
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo openssh-server && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/sh fleettest \
  && printf 'fleettest ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/fleettest && chmod 0440 /etc/sudoers.d/fleettest \
  && mkdir -p /run/sshd
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
