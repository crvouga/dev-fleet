# Disposable stand-in for a brand-new Ubuntu box right after SSH is set up: a
# non-root user with sudo and nothing else (no Git, curl, Python, mise, Bun).
# Pinned by index digest so the box runs natively on amd64 and arm64 hosts.
# Test tooling only; never a fleet node image.
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/sh fleettest \
  && printf 'fleettest ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/fleettest && chmod 0440 /etc/sudoers.d/fleettest
USER fleettest
CMD ["sleep", "infinity"]
