#!/usr/bin/env bash
set -euo pipefail

relative_cgroup="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
[[ "$(stat -fc '%T' /sys/fs/cgroup)" == "cgroup2fs" ]]
[[ -n "${relative_cgroup}" && "${relative_cgroup}" == /* ]]
parent="$(realpath -e "/sys/fs/cgroup${relative_cgroup}")"
[[ "${parent}" == /sys/fs/cgroup/* && "${parent}" != "/sys/fs/cgroup" ]]
[[ -f "${parent}/cgroup.controllers" && -f "${parent}/cgroup.subtree_control" ]]

mapfile -t initial_procs < "${parent}/cgroup.procs"
[[ "${#initial_procs[@]}" -eq 1 ]]
[[ "${initial_procs[0]}" == "$$" ]]
for controller in cpu memory pids; do
  [[ " $(<"${parent}/cgroup.controllers") " == *" ${controller} "* ]]
done

runner_leaf="${parent}/runner"
test_root="${parent}/chronorift"

cleanup() {
  local main_status="${1}"
  local cleanup_status=0
  local deadline

  trap - EXIT
  set +e

  cleanup_failure() {
    printf 'sandbox conformance cleanup failed: %s\n' "$1" >&2
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
[[ "${#parent_procs[@]}" -eq 0 ]]

printf '%s\n' '+cpu +memory +pids' > "${parent}/cgroup.subtree_control"
for controller in cpu memory pids; do
  [[ " $(<"${parent}/cgroup.subtree_control") " == *" ${controller} "* ]]
done

printf '%s\n' '+cpu +memory +pids' > "${test_root}/cgroup.subtree_control"
for controller in cpu memory pids; do
  [[ " $(<"${test_root}/cgroup.subtree_control") " == *" ${controller} "* ]]
done

export CHRONORIFT_TEST_CGROUP_ROOT="${test_root}"
corepack pnpm test:sandbox
