#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'vNext external-project conformance precondition failed: %s\n' "$1" >&2
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
  RUNNER_TEMP \
  GITHUB_WORKSPACE \
  CHRONORIFT_NODE_BIN \
  GODOT_BIN \
  CHRONORIFT_GODOT_LIFECYCLE_ADDON_ROOT \
  CHRONORIFT_GODOT_SEMANTIC_ADDON_ROOT \
  CHRONORIFT_TEST_NODE_BIN \
  CHRONORIFT_TEST_GODOT_BIN \
  CHRONORIFT_TEST_GODOT_LIFECYCLE_ADDON_ROOT \
  CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT \
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
  CHRONORIFT_TEST_LS_BIN \
  CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT \
  CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR \
  CHRONORIFT_TEST_EXTERNAL_SEMANTIC_ADAPTER_PROFILE \
  CHRONORIFT_TEST_EXTERNAL_PROJECT_CONFORMANCE_SPEC \
  CHRONORIFT_TEST_EXTERNAL_PROJECT_EVIDENCE_SCHEMA \
  CHRONORIFT_TEST_EVIDENCE_OUTPUT \
  CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT; do
  require_environment "${name}"
done

[[ "${CHRONORIFT_NODE_BIN}" == "${CHRONORIFT_TEST_NODE_BIN}" ]] ||
  fail "Node Host path aliases disagree"
[[ "${GODOT_BIN}" == "${CHRONORIFT_TEST_GODOT_BIN}" ]] ||
  fail "Godot Host path aliases disagree"
[[ "${CHRONORIFT_GODOT_LIFECYCLE_ADDON_ROOT}" == "${CHRONORIFT_TEST_GODOT_LIFECYCLE_ADDON_ROOT}" ]] ||
  fail "Godot lifecycle addon Host path aliases disagree"
[[ "${CHRONORIFT_GODOT_SEMANTIC_ADDON_ROOT}" == "${CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT}" ]] ||
  fail "Godot semantic addon Host path aliases disagree"

assert_canonical_path "RUNNER_TEMP" "${RUNNER_TEMP}"
assert_canonical_path "GITHUB_WORKSPACE" "${GITHUB_WORKSPACE}"
[[ "$(pwd -P)" == "${GITHUB_WORKSPACE}" ]] ||
  fail "the process working directory must be GITHUB_WORKSPACE"

mapfile -t non_loopback_interfaces < <(
  awk -F: 'NR > 2 { gsub(/[[:space:]]/, "", $1); if ($1 != "lo") print $1 }' /proc/net/dev
)
[[ "${#non_loopback_interfaces[@]}" -eq 0 ]] ||
  fail "the conformance command must run in a PrivateNetwork namespace"

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

assert_canonical_path "managed lifecycle addon" "${CHRONORIFT_TEST_GODOT_LIFECYCLE_ADDON_ROOT}"
[[ -d "${CHRONORIFT_TEST_GODOT_LIFECYCLE_ADDON_ROOT}" ]] ||
  fail "managed lifecycle addon must be a directory"
[[ "${CHRONORIFT_TEST_GODOT_LIFECYCLE_ADDON_ROOT}" == "${GITHUB_WORKSPACE}/godot/addons/chronorift_lifecycle" ]] ||
  fail "managed lifecycle addon must come from this checkout"
assert_canonical_path "managed semantic addon" "${CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT}"
[[ -d "${CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT}" ]] ||
  fail "managed semantic addon must be a directory"
[[ "${CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT}" == "${GITHUB_WORKSPACE}/godot/addons/chronorift_semantic" ]] ||
  fail "managed semantic addon must come from this checkout"
[[ "$("${CHRONORIFT_TEST_NODE_BIN}" --version)" == "v22.23.1" ]] ||
  fail "managed Node must be exactly v22.23.1"
godot_version="$("${CHRONORIFT_TEST_GODOT_BIN}" --version)"
[[ "${godot_version}" == "4.7.1.stable.official.a13da4feb" ]] ||
  fail "managed Godot must be the exact official 4.7.1 stable build"

"${CHRONORIFT_TEST_NODE_BIN}" \
  .github/scripts/validate-vnext-e2-freeze.mjs \
  docs/evidence/vnext-e2-public-exposed-r1/freeze-record.v1.json \
  testdata/vnext/external-project/moddable-platformer.e2-evaluation-contract.v1.json \
  testdata/vnext/external-project/e2-evaluator-interface.schema.v1.json \
  docs/evidence/vnext-e2-public-exposed-r1/chronorift-m4-external-project-evidence.json \
  docs/evidence/vnext-e2-public-exposed-r1/chronorift-e2-external-semantic-evidence.json

assert_canonical_path "external project checkout" "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}"
[[ -d "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" ]] ||
  fail "external project checkout must be a directory"
case "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" in
  "${RUNNER_TEMP}"/chronorift-m4-external-project-*) ;;
  *) fail "external project checkout must be a dedicated RUNNER_TEMP child" ;;
esac
[[ "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" rev-parse HEAD)" == "3e793f53598a131c53fb82555191cc14b8db07ff" ]] ||
  fail "external project HEAD does not match the frozen conformance commit"
[[ "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" rev-parse 'HEAD^{tree}')" == "a013bd677c712dbf354e8e2f6e8ff7c53d5684c6" ]] ||
  fail "external project Git tree does not match the frozen conformance tree"
[[ -z "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" status --porcelain=v1 --untracked-files=all --ignored=matching)" ]] ||
  fail "external project checkout must be clean"
[[ -z "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" ls-files -s | awk '$1 == "120000" || $1 == "160000" { print }')" ]] ||
  fail "external project checkout contains a symlink or submodule"
[[ -z "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" config --local --get-regexp '^(credential\.|http\..*\.extraheader$)' || true)" ]] ||
  fail "external project checkout retained a local credential binding"

assert_canonical_path "external project descriptor" "${CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR}"
[[ -f "${CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR}" ]] ||
  fail "external project descriptor must be a regular file"
[[ "${CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR}" == "${GITHUB_WORKSPACE}/testdata/vnext/external-project/moddable-platformer.project.v1.json" ]] ||
  fail "external project descriptor must be the frozen conformance input"
[[ "$(sha256sum "${CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR}" | awk '{ print $1 }')" == "534dcd8aa14aeea74685059f8d66e44e5bebe21742b7a702ee7d78e91e1a955e" ]] ||
  fail "external project descriptor bytes changed"

assert_canonical_path "external semantic adapter profile" "${CHRONORIFT_TEST_EXTERNAL_SEMANTIC_ADAPTER_PROFILE}"
[[ -f "${CHRONORIFT_TEST_EXTERNAL_SEMANTIC_ADAPTER_PROFILE}" ]] ||
  fail "external semantic adapter profile must be a regular file"
[[ "${CHRONORIFT_TEST_EXTERNAL_SEMANTIC_ADAPTER_PROFILE}" == "${GITHUB_WORKSPACE}/testdata/vnext/external-project/moddable-platformer.semantic-adapter.v1.json" ]] ||
  fail "external semantic adapter must be the frozen conformance input"
[[ "$(sha256sum "${CHRONORIFT_TEST_EXTERNAL_SEMANTIC_ADAPTER_PROFILE}" | awk '{ print $1 }')" == "1ca17b9f3fff8556d5fa260331929126ba54e18518de2d2386562b230327238b" ]] ||
  fail "external semantic adapter bytes changed"

assert_canonical_path "external project conformance spec" "${CHRONORIFT_TEST_EXTERNAL_PROJECT_CONFORMANCE_SPEC}"
[[ -f "${CHRONORIFT_TEST_EXTERNAL_PROJECT_CONFORMANCE_SPEC}" ]] ||
  fail "external project conformance spec must be a regular file"
[[ "${CHRONORIFT_TEST_EXTERNAL_PROJECT_CONFORMANCE_SPEC}" == "${GITHUB_WORKSPACE}/testdata/vnext/external-project/moddable-platformer.conformance.v1.json" ]] ||
  fail "external project conformance spec must be the frozen test-only input"
[[ "$(sha256sum "${CHRONORIFT_TEST_EXTERNAL_PROJECT_CONFORMANCE_SPEC}" | awk '{ print $1 }')" == "1fc43c0eaea45ed9fa129a7a2e06913c0cc37495633dc4d90dd3fd7598de5f82" ]] ||
  fail "external project conformance spec bytes changed"

assert_canonical_path "external project evidence schema" "${CHRONORIFT_TEST_EXTERNAL_PROJECT_EVIDENCE_SCHEMA}"
[[ -f "${CHRONORIFT_TEST_EXTERNAL_PROJECT_EVIDENCE_SCHEMA}" ]] ||
  fail "external project evidence schema must be a regular file"
[[ "${CHRONORIFT_TEST_EXTERNAL_PROJECT_EVIDENCE_SCHEMA}" == "${GITHUB_WORKSPACE}/testdata/vnext/external-project/evidence-summary.schema.v1.json" ]] ||
  fail "external project evidence schema must be the frozen test-only schema"

[[ "${CHRONORIFT_TEST_EVIDENCE_OUTPUT}" == "${RUNNER_TEMP}/chronorift-m4-external-project-evidence.json" ]] ||
  fail "evidence output must use the fixed RUNNER_TEMP path"
[[ ! -e "${CHRONORIFT_TEST_EVIDENCE_OUTPUT}" ]] ||
  fail "evidence output must not exist before conformance"
[[ "${CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT}" == "${RUNNER_TEMP}/chronorift-e2-external-semantic-evidence.json" ]] ||
  fail "semantic evidence output must use the fixed RUNNER_TEMP path"
[[ ! -e "${CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT}" ]] ||
  fail "semantic evidence output must not exist before conformance"

assert_canonical_path "bounded Task storage" "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}"
[[ -d "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" ]] ||
  fail "bounded Task storage must be a directory"
[[ "$(stat -c '%u:%a' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")" == "$(id -u):700" ]] ||
  fail "bounded Task storage must be owned by the runner with mode 0700"
[[ "$(stat -c '%d' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")" != "$(stat -c '%d' -- "$(dirname -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")")" ]] ||
  fail "bounded Task storage must be a distinct filesystem mount"
storage_fs="$(stat -fc '%T' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")"
[[ "${storage_fs}" == "tmpfs" ]] ||
  fail "this conformance wrapper requires an exact tmpfs Task storage mount: ${storage_fs}"
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
test_root="${parent}/chronorift-vnext-external-project"

cleanup() {
  local main_status="${1}"
  local cleanup_status=0
  local deadline

  trap - EXIT
  set +e

  cleanup_failure() {
    printf 'vNext external-project conformance cleanup failed: %s\n' "$1" >&2
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
  find apps/cli/src/vnext -type f -name '*.external-project.test.ts' -print
)
[[ "${#conformance_tests[@]}" -gt 0 ]] ||
  fail "at least one vNext external-project conformance test is required"

export CHRONORIFT_CGROUP_ROOT="${test_root}"
export CHRONORIFT_TEST_CGROUP_ROOT="${test_root}"
export CI=true
corepack pnpm test:vnext:external-project

mapfile -t semantic_conformance_tests < <(
  find apps/cli/src/vnext -type f -name '*.external-semantic.test.ts' -print
)
[[ "${#semantic_conformance_tests[@]}" -gt 0 ]] ||
  fail "at least one E2 external semantic conformance test is required"
[[ -z "$(find "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
  fail "M4 left bounded Task storage nonempty before E2"
corepack pnpm test:vnext:external-semantic

[[ "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" rev-parse HEAD)" == "3e793f53598a131c53fb82555191cc14b8db07ff" ]] ||
  fail "external project HEAD changed during conformance"
[[ "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" rev-parse 'HEAD^{tree}')" == "a013bd677c712dbf354e8e2f6e8ff7c53d5684c6" ]] ||
  fail "external project Git tree changed during conformance"
[[ -z "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" status --porcelain=v1 --untracked-files=all --ignored=matching)" ]] ||
  fail "external project checkout changed during conformance"

[[ -f "${CHRONORIFT_TEST_EVIDENCE_OUTPUT}" && ! -L "${CHRONORIFT_TEST_EVIDENCE_OUTPUT}" ]] ||
  fail "successful conformance must create a regular evidence summary"
evidence_size="$(stat -c '%s' -- "${CHRONORIFT_TEST_EVIDENCE_OUTPUT}")"
((evidence_size > 0 && evidence_size <= 65536)) ||
  fail "evidence summary must be nonempty and no larger than 64 KiB"
"${CHRONORIFT_TEST_NODE_BIN}" \
  .github/scripts/validate-vnext-external-project-evidence.mjs \
  "${CHRONORIFT_TEST_EXTERNAL_PROJECT_EVIDENCE_SCHEMA}" \
  "${CHRONORIFT_TEST_EVIDENCE_OUTPUT}"
if grep -Fq -- "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" "${CHRONORIFT_TEST_EVIDENCE_OUTPUT}" ||
  grep -Fq -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" "${CHRONORIFT_TEST_EVIDENCE_OUTPUT}"; then
  fail "evidence summary exposed a Host path"
fi

[[ -f "${CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT}" && ! -L "${CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT}" ]] ||
  fail "successful semantic conformance must create a regular evidence summary"
semantic_evidence_size="$(stat -c '%s' -- "${CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT}")"
((semantic_evidence_size > 0 && semantic_evidence_size <= 65536)) ||
  fail "semantic evidence must be nonempty and no larger than 64 KiB"
"${CHRONORIFT_TEST_NODE_BIN}" \
  .github/scripts/validate-vnext-external-semantic-evidence.mjs \
  "${CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT}"
if grep -Fq -- "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" "${CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT}" ||
  grep -Fq -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" "${CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT}"; then
  fail "semantic evidence exposed a Host path"
fi
