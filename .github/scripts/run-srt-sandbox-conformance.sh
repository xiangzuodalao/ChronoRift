#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'SRT sandbox conformance precondition failed: %s\n' "$1" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

[[ "$(uname -s)" == "Linux" ]] || fail "only Linux is supported"
[[ "$(uname -m)" == "x86_64" ]] || fail "only Linux x86_64 is supported"

for dependency in bwrap socat rg; do
  command -v "${dependency}" >/dev/null 2>&1 || fail "${dependency} is not installed"
done

srt_package_json="${repo_root}/apps/cli/node_modules/@anthropic-ai/sandbox-runtime/package.json"
[[ -f "${srt_package_json}" ]] || fail "@anthropic-ai/sandbox-runtime is not installed for apps/cli"
srt_version="$(node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(value.version));' "${srt_package_json}")"
[[ "${srt_version}" == "0.0.74" ]] || fail "expected @anthropic-ai/sandbox-runtime 0.0.74, found ${srt_version}"

# SRT uses Bubblewrap user namespaces on Linux. Exercise the actual primitive so
# an AppArmor/sysctl denial fails before the Vitest suite with a useful message.
if ! bwrap \
  --ro-bind / / \
  --proc /proc \
  --dev /dev \
  --unshare-user \
  --unshare-pid \
  --die-with-parent \
  /bin/true; then
  fail "unprivileged Bubblewrap user namespaces are unavailable"
fi

default_godot_bin="${repo_root}/.tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64"
export GODOT_BIN="${GODOT_BIN:-${default_godot_bin}}"
[[ -x "${GODOT_BIN}" ]] || fail "Godot is not executable at ${GODOT_BIN}"

corepack pnpm test:sandbox
