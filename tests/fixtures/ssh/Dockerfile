ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea
FROM ${UBUNTU_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
      ca-certificates curl openssh-server sudo systemd systemd-sysv && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --create-home --shell /bin/bash passwordrunner && \
    useradd --create-home --shell /bin/bash pamrunner && \
    printf '%s\n' \
      'passwordrunner:Password!Runner123' \
      'pamrunner:Keyboard!Runner123' | chpasswd && \
    usermod --append --groups sudo passwordrunner && \
    usermod --append --groups sudo pamrunner && \
    ssh-keygen -A && \
    systemctl enable ssh.service

COPY sshd-autoforge.conf /etc/ssh/sshd_config.d/99-autoforge-acceptance.conf

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
