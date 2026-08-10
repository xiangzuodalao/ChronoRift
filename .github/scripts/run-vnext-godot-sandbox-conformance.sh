#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'vNext Godot sandbox conformance precondition failed: %s\n' "$1" >&2
  exit 1
}

require_environment() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "${name} is required"
}

assert_canonical_path() {
  local label="$1"
  local path="$2"
  local canonical

  [[ "${path}" == /* ]] || fail "${label} must be absolute"
  canonical="$(realpath -e -- "${path}")" || fail "${label} does not exist"
  [[ "${canonical}" == "${path}" ]] || fail "${label} must be canonical"
}

assert_root_owned_executable() {
  local label="$1"
  local path="$2"
  local current
  local mode

  assert_canonical_path "${label}" "${path}"
  [[ -f "${path}" && -x "${path}" ]] || fail "${label} must be an executable file"
  current="${path}"
  while :; do
    [[ "$(stat -c '%u' -- "${current}")" == "0" ]] ||
      fail "${label} and every ancestor must be root-owned"
    mode="$(stat -c '%a' -- "${current}")"
    (( (8#${mode} & 0022) == 0 )) ||
      fail "${label} and every ancestor must not be group/world writable"
    [[ "${current}" == "/" ]] && break
    current="$(dirname -- "${current}")"
  done
}

for name in \
  PATH \
  HOME \
  GITHUB_WORKSPACE \
  CHRONORIFT_NODE_BIN \
  GODOT_BIN \
  CHRONORIFT_GODOT_ADDON_ROOT \
  CHRONORIFT_TEST_NODE_BIN \
  CHRONORIFT_TEST_GODOT_BIN \
  CHRONORIFT_TEST_GODOT_ADDON_ROOT \
  CHRONORIFT_TEST_TASK_STORAGE_ROOT \
  CHRONORIFT_TEST_BWRAP_BIN \
  CHRONORIFT_TEST_PRLIMIT_BIN \
  CHRONORIFT_TEST_BUSYBOX_BIN \
  CHRONORIFT_TEST_LDD_BIN \
  CHRONORIFT_TEST_FONTCONFIG_PROBE_BIN \
  CHRONORIFT_TEST_XDG_USER_DIR_BIN \
  CHRONORIFT_TEST_BASH_BIN \
  CHRONORIFT_TEST_RG_BIN \
  CHRONORIFT_TEST_FIND_BIN \
  CHRONORIFT_TEST_LS_BIN; do
  require_environment "${name}"
done

[[ "${CHRONORIFT_NODE_BIN}" == "${CHRONORIFT_TEST_NODE_BIN}" ]] ||
  fail "Node Host path aliases disagree"
[[ "${GODOT_BIN}" == "${CHRONORIFT_TEST_GODOT_BIN}" ]] ||
  fail "Godot Host path aliases disagree"
[[ "${CHRONORIFT_GODOT_ADDON_ROOT}" == "${CHRONORIFT_TEST_GODOT_ADDON_ROOT}" ]] ||
  fail "Godot addon Host path aliases disagree"

assert_canonical_path "GITHUB_WORKSPACE" "${GITHUB_WORKSPACE}"
[[ "$(pwd -P)" == "${GITHUB_WORKSPACE}" ]] ||
  fail "the process working directory must be GITHUB_WORKSPACE"
assert_root_owned_executable "managed Node" "${CHRONORIFT_TEST_NODE_BIN}"
assert_root_owned_executable "managed Godot" "${CHRONORIFT_TEST_GODOT_BIN}"
for entry in \
  "bwrap:${CHRONORIFT_TEST_BWRAP_BIN}" \
  "prlimit:${CHRONORIFT_TEST_PRLIMIT_BIN}" \
  "busybox:${CHRONORIFT_TEST_BUSYBOX_BIN}" \
  "ldd:${CHRONORIFT_TEST_LDD_BIN}" \
  "fontconfig probe:${CHRONORIFT_TEST_FONTCONFIG_PROBE_BIN}" \
  "xdg-user-dir:${CHRONORIFT_TEST_XDG_USER_DIR_BIN}" \
  "bash:${CHRONORIFT_TEST_BASH_BIN}" \
  "ripgrep:${CHRONORIFT_TEST_RG_BIN}" \
  "find:${CHRONORIFT_TEST_FIND_BIN}" \
  "ls:${CHRONORIFT_TEST_LS_BIN}"; do
  assert_root_owned_executable "${entry%%:*}" "${entry#*:}"
done

assert_canonical_path "managed Godot addon" "${CHRONORIFT_TEST_GODOT_ADDON_ROOT}"
[[ -d "${CHRONORIFT_TEST_GODOT_ADDON_ROOT}" ]] ||
  fail "managed Godot addon must be a directory"
[[ "${CHRONORIFT_TEST_GODOT_ADDON_ROOT}" == "${GITHUB_WORKSPACE}/godot/addons/chronorift" ]] ||
  fail "managed Godot addon must come from this checkout"
[[ "$("${CHRONORIFT_TEST_NODE_BIN}" --version)" == "v22.23.1" ]] ||
  fail "managed Node must be exactly v22.23.1"
godot_version="$("${CHRONORIFT_TEST_GODOT_BIN}" --version)"
[[ "${godot_version}" =~ ^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$ ]] ||
  fail "managed Godot must be the exact official 4.7.1 stable build"

assert_canonical_path "bounded Task storage" "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}"
[[ -d "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" ]] ||
  fail "bounded Task storage must be a directory"
[[ "$(stat -c '%u:%a' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")" == "$(id -u):700" ]] ||
  fail "bounded Task storage must be owned by the runner with mode 0700"
[[ "$(stat -c '%d' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")" != "$(stat -c '%d' -- "$(dirname -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")")" ]] ||
  fail "bounded Task storage must be a distinct filesystem mount"
storage_fs="$(stat -fc '%T' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")"
case "${storage_fs}" in
  tmpfs) ;;
  *) fail "this conformance wrapper requires an exact tmpfs Task storage mount: ${storage_fs}" ;;
esac
storage_blocks="$(stat -fc '%b' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")"
storage_block_size="$(stat -fc '%S' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")"
storage_inodes="$(stat -fc '%c' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")"
((storage_blocks > 0 && storage_block_size > 0)) ||
  fail "bounded Task storage has invalid capacity facts"
((storage_blocks <= 1073741824 / storage_block_size)) ||
  fail "bounded Task storage exceeds the 1 GiB hard capacity bound"
((storage_inodes > 0 && storage_inodes <= 131072)) ||
  fail "bounded Task storage exceeds the 131072 inode hard bound"
[[ -z "$(find "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
  fail "bounded Task storage must be empty before conformance"

relative_cgroup="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
[[ "$(stat -fc '%T' /sys/fs/cgroup)" == "cgroup2fs" ]] ||
  fail "the delegated hierarchy must use cgroup v2"
[[ -n "${relative_cgroup}" && "${relative_cgroup}" == /* ]] ||
  fail "the current cgroup path is invalid"
parent="$(realpath -e "/sys/fs/cgroup${relative_cgroup}")"
[[ "${parent}" == /sys/fs/cgroup/* && "${parent}" != "/sys/fs/cgroup" ]] ||
  fail "systemd-run must place this process below a delegated cgroup"
[[ -f "${parent}/cgroup.controllers" && -f "${parent}/cgroup.subtree_control" ]] ||
  fail "the delegated cgroup control files are unavailable"

mapfile -t initial_procs < "${parent}/cgroup.procs"
[[ "${#initial_procs[@]}" -eq 1 && "${initial_procs[0]}" == "$$" ]] ||
  fail "the delegated cgroup must initially contain only this runner"
for controller in cpu memory pids; do
  [[ " $(<"${parent}/cgroup.controllers") " == *" ${controller} "* ]] ||
    fail "the delegated cgroup lacks the ${controller} controller"
done

runner_leaf="${parent}/runner"
test_root="${parent}/chronorift-vnext-godot"

cleanup() {
  local main_status="${1}"
  local cleanup_status=0
  local deadline

  trap - EXIT
  set +e

  cleanup_failure() {
    printf 'vNext Godot sandbox conformance cleanup failed: %s\n' "$1" >&2
    cleanup_status=1
  }

  if [[ -d "${test_root}" ]]; then
    if [[ ! -f "${test_root}/cgroup.kill" ]]; then
      cleanup_failure "${test_root}/cgroup.kill is unavailable"
    elif ! printf '%s\n' 1 > "${test_root}/cgroup.kill"; then
      cleanup_failure "could not kill processes below ${test_root}"
    fi

    if [[ ! -f "${test_root}/cgroup.events" ]]; then
      cleanup_failure "${test_root}/cgroup.events is unavailable"
    else
      deadline=$((SECONDS + 10))
      while ! awk '$1 == "populated" && $2 == "0" { found = 1 } END { exit !found }' \
        "${test_root}/cgroup.events"; do
        if ((SECONDS >= deadline)); then
          cleanup_failure "${test_root} remained populated after cgroup.kill"
          break
        fi
        sleep 0.05
      done
    fi

    if ! find "${test_root}" -depth -type d -exec rmdir '{}' \; 2>/dev/null; then
      cleanup_failure "could not remove every cgroup below ${test_root}"
    fi
  fi

  if [[ -e "${test_root}" ]]; then
    cleanup_failure "test cgroup root still exists: ${test_root}"
  fi

  if [[ -n "$(find "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    cleanup_failure "bounded Task storage retained conformance state: ${CHRONORIFT_TEST_TASK_STORAGE_ROOT}"
  fi

  if [[ -f "${parent}/cgroup.subtree_control" ]]; then
    if ! printf '%s\n' '-cpu -memory -pids' > "${parent}/cgroup.subtree_control"; then
      cleanup_failure "could not disable delegated controllers below ${parent}"
    fi
  else
    cleanup_failure "${parent}/cgroup.subtree_control is unavailable"
  fi

  if [[ -f "${parent}/cgroup.procs" ]]; then
    if ! printf '%s\n' "$$" > "${parent}/cgroup.procs"; then
      cleanup_failure "could not move the runner process back to ${parent}"
    fi
  else
    cleanup_failure "${parent}/cgroup.procs is unavailable"
  fi

  if [[ -d "${runner_leaf}" ]] && ! rmdir "${runner_leaf}"; then
    cleanup_failure "could not remove runner cgroup ${runner_leaf}"
  fi
  if [[ -e "${runner_leaf}" ]]; then
    cleanup_failure "runner cgroup still exists: ${runner_leaf}"
  fi

  if ((main_status != 0)); then
    exit "${main_status}"
  fi
  exit "${cleanup_status}"
}
trap 'cleanup "$?"' EXIT

mkdir "${runner_leaf}" "${test_root}"
printf '%s\n' "$$" > "${runner_leaf}/cgroup.procs"
mapfile -t parent_procs < "${parent}/cgroup.procs"
[[ "${#parent_procs[@]}" -eq 0 ]] ||
  fail "the delegated cgroup remained internally populated"

printf '%s\n' '+cpu +memory +pids' > "${parent}/cgroup.subtree_control"
for controller in cpu memory pids; do
  [[ " $(<"${parent}/cgroup.subtree_control") " == *" ${controller} "* ]] ||
    fail "could not delegate the ${controller} controller"
done

printf '%s\n' '+cpu +memory +pids' > "${test_root}/cgroup.subtree_control"
for controller in cpu memory pids; do
  [[ " $(<"${test_root}/cgroup.subtree_control") " == *" ${controller} "* ]] ||
    fail "could not delegate the ${controller} controller to test leaves"
done

mapfile -t conformance_tests < <(
  find apps/cli/src/vnext -type f -name '*.godot-sandbox.test.ts' -print
)
[[ "${#conformance_tests[@]}" -gt 0 ]] ||
  fail "at least one vNext Godot sandbox conformance test is required"

export CHRONORIFT_CGROUP_ROOT="${test_root}"
export CHRONORIFT_TEST_CGROUP_ROOT="${test_root}"
export CI=true
corepack pnpm test:vnext:godot-sandbox
