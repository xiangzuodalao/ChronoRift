#!/usr/bin/env bash
set -euo pipefail

install -d -o root -g root -m 0755 /usr/lib/chronorift-ci/bin
install -o root -g root -m 0755 /host-tools/node /usr/lib/chronorift-ci/bin/node-22.23.1
install -o root -g root -m 0755 /host-tools/godot /usr/lib/chronorift-ci/bin/godot-4.7.1
test "$(/usr/lib/chronorift-ci/bin/node-22.23.1 --version)" = "v22.23.1"
test "$(/usr/lib/chronorift-ci/bin/godot-4.7.1 --version)" = "4.7.1.stable.official.a13da4feb"

chown ubuntu:ubuntu /task-storage /evidence
chmod 0700 /task-storage /evidence

mkdir /sys/fs/cgroup/driver
echo "$$" >/sys/fs/cgroup/driver/cgroup.procs
echo "+cpu +memory +pids" >/sys/fs/cgroup/cgroup.subtree_control
mkdir /sys/fs/cgroup/driver/runner
mkdir /sys/fs/cgroup/driver/chronorift-vnext-godot
echo "$$" >/sys/fs/cgroup/driver/runner/cgroup.procs
echo "+cpu +memory +pids" >/sys/fs/cgroup/driver/cgroup.subtree_control
echo "+cpu +memory +pids" >/sys/fs/cgroup/driver/chronorift-vnext-godot/cgroup.subtree_control
chown ubuntu:ubuntu /sys/fs/cgroup/driver/cgroup.procs
chown -R ubuntu:ubuntu /sys/fs/cgroup/driver/chronorift-vnext-godot

exec runuser -u ubuntu -- env \
  HOME=/home/ubuntu \
  PATH=/usr/lib/chronorift-ci/bin:/usr/bin:/bin \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  PI_CODING_AGENT_DIR=/pi-agent \
  GITHUB_WORKSPACE=/workspace \
  CHRONORIFT_TEST_PE_A_LIVE=1 \
  CHRONORIFT_TEST_PE_A_PROVIDER=openai-codex \
  CHRONORIFT_TEST_PE_A_MODEL=gpt-5.6-luna \
  CHRONORIFT_TEST_PE_A_THINKING_LEVEL=max \
  CHRONORIFT_TEST_PE_A_HOST_CONFIG=/workspace/.chronorift/pe-a-live/host-config.v1.json \
  CHRONORIFT_TEST_PE_A_AGENT_DIR=/pi-agent \
  CHRONORIFT_TEST_PE_A_EVIDENCE_OUTPUT_DIR=/evidence \
  /usr/lib/chronorift-ci/bin/node-22.23.1 \
  /workspace/node_modules/vitest/vitest.mjs run \
  --config /workspace/vitest.live.config.ts \
  /workspace/apps/cli/src/vnext/project-environment-pe-a.live.test.ts
