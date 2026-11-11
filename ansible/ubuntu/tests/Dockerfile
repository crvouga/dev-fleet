# Disposable test tooling only; never a fleet node image or deployment owner.
FROM ubuntu:26.04@sha256:157dc3d6e4a3e4f2c68d12df9df9ed6e808b59af6d4c3757b432b4f519916725
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils cloud-image-utils openssh-client curl ca-certificates python3 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["python3", "/workspace/ansible/ubuntu/tests/vm.py"]
