#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'vNext M5 live conformance precondition failed: %s\n' "$1" >&2
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
  CHRONORIFT_TEST_NODE_BIN \
  CHRONORIFT_TEST_GODOT_BIN \
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
  CHRONORIFT_TEST_M5_TASK_SPEC \
  CHRONORIFT_TEST_M5_EVIDENCE_SCHEMA \
  CHRONORIFT_TEST_M5_EVIDENCE_ROOT; do
  require_environment "${name}"
done

assert_canonical_path "RUNNER_TEMP" "${RUNNER_TEMP}"
assert_canonical_path "GITHUB_WORKSPACE" "${GITHUB_WORKSPACE}"
[[ "$(pwd -P)" == "${GITHUB_WORKSPACE}" ]] ||
  fail "the process working directory must be GITHUB_WORKSPACE"
product_commit="$(git -C "${GITHUB_WORKSPACE}" rev-parse 'HEAD^{commit}')"
product_tree="$(git -C "${GITHUB_WORKSPACE}" rev-parse 'HEAD^{tree}')"
[[ "${product_commit}" =~ ^[a-f0-9]{40}$ && "${product_tree}" =~ ^[a-f0-9]{40}$ ]] ||
  fail "the ChronoRift product subject has invalid Git identities"
[[ -z "$(git -C "${GITHUB_WORKSPACE}" status --porcelain=v1 --untracked-files=all)" ]] ||
  fail "the ChronoRift product-subject checkout must be clean"
export CHRONORIFT_TEST_M5_PRODUCT_COMMIT="${product_commit}"
export CHRONORIFT_TEST_M5_PRODUCT_TREE="${product_tree}"

assert_root_owned_executable "managed Node" "${CHRONORIFT_TEST_NODE_BIN}"
assert_root_owned_executable "managed Godot" "${CHRONORIFT_TEST_GODOT_BIN}"
managed_node_dir="$(dirname -- "${CHRONORIFT_TEST_NODE_BIN}")"
managed_node_launcher="${managed_node_dir}/node"
assert_root_owned_executable "managed Node launcher" "${managed_node_launcher}"
[[ "${managed_node_launcher}" -ef "${CHRONORIFT_TEST_NODE_BIN}" ]] ||
  fail "managed Node launcher must be the exact staged Node inode"
for entry in \
  "git:/usr/bin/git" \
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

[[ "$("${CHRONORIFT_TEST_NODE_BIN}" --version)" == "v22.23.1" ]] ||
  fail "managed Node must be exactly v22.23.1"
[[ "$("${CHRONORIFT_TEST_GODOT_BIN}" --version)" == "4.7.1.stable.official.a13da4feb" ]] ||
  fail "managed Godot must be the exact official 4.7.1 stable build"

assert_canonical_path "managed semantic addon" "${CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT}"
[[ -d "${CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT}" ]] ||
  fail "managed semantic addon must be a directory"
[[ "${CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT}" == "${GITHUB_WORKSPACE}/godot/addons/chronorift_semantic" ]] ||
  fail "managed semantic addon must come from this checkout"

assert_canonical_path "external project checkout" "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}"
[[ -d "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" ]] ||
  fail "external project checkout must be a directory"
case "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" in
  "${RUNNER_TEMP}"/chronorift-m5-external-project-*) ;;
  *) fail "external project checkout must be a dedicated RUNNER_TEMP child" ;;
esac
[[ "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" rev-parse HEAD)" == "3e793f53598a131c53fb82555191cc14b8db07ff" ]] ||
  fail "external project HEAD does not match the frozen M5 commit"
[[ "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" rev-parse 'HEAD^{tree}')" == "a013bd677c712dbf354e8e2f6e8ff7c53d5684c6" ]] ||
  fail "external project tree does not match the frozen M5 tree"
[[ -z "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" status --porcelain=v1 --untracked-files=all --ignored=matching)" ]] ||
  fail "external project checkout must be clean"
[[ -z "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" ls-files -s | awk '$1 == "120000" || $1 == "160000" { print }')" ]] ||
  fail "external project checkout contains a symlink or submodule"
[[ -z "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" config --local --get-regexp '^(credential\.|http\..*\.extraheader$)' || true)" ]] ||
  fail "external project checkout retained a local credential binding"

for input in \
  "descriptor:${CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR}:testdata/vnext/external-project/moddable-platformer.project.v1.json" \
  "semantic adapter:${CHRONORIFT_TEST_EXTERNAL_SEMANTIC_ADAPTER_PROFILE}:testdata/vnext/external-project/moddable-platformer.semantic-adapter.v1.json" \
  "M5 task spec:${CHRONORIFT_TEST_M5_TASK_SPEC}:testdata/vnext/m5/moddable-platformer.behavior-change-task.v1.json" \
  "M5 evidence schema:${CHRONORIFT_TEST_M5_EVIDENCE_SCHEMA}:testdata/vnext/m5/evidence-bundle.schema.v1.json"; do
  label="${input%%:*}"
  remainder="${input#*:}"
  path="${remainder%%:*}"
  relative="${remainder#*:}"
  assert_canonical_path "${label}" "${path}"
  [[ -f "${path}" && ! -L "${path}" ]] || fail "${label} must be a regular file"
  [[ "${path}" == "${GITHUB_WORKSPACE}/${relative}" ]] ||
    fail "${label} must be the repository-frozen input"
done

[[ "${CHRONORIFT_TEST_M5_EVIDENCE_ROOT}" == "${RUNNER_TEMP}/chronorift-m5-evidence" ]] ||
  fail "M5 evidence root must use the fixed RUNNER_TEMP path"
[[ ! -e "${CHRONORIFT_TEST_M5_EVIDENCE_ROOT}" ]] ||
  fail "M5 evidence root must not exist before conformance"

assert_canonical_path "bounded Task storage" "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}"
[[ -d "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" ]] || fail "bounded Task storage must be a directory"
[[ "$(stat -c '%u:%a' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")" == "$(id -u):700" ]] ||
  fail "bounded Task storage must be owned by the runner with mode 0700"
[[ "$(stat -c '%d' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")" != "$(stat -c '%d' -- "$(dirname -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")")" ]] ||
  fail "bounded Task storage must be a distinct filesystem mount"
[[ "$(stat -fc '%T' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")" == "tmpfs" ]] ||
  fail "M5 live conformance requires exact tmpfs Task storage"
storage_blocks="$(stat -fc '%b' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")"
storage_block_size="$(stat -fc '%S' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")"
storage_inodes="$(stat -fc '%c' -- "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}")"
((storage_blocks > 0 && storage_block_size > 0 && storage_blocks <= 1073741824 / storage_block_size)) ||
  fail "bounded Task storage exceeds the 1 GiB hard bound"
((storage_inodes > 0 && storage_inodes <= 131072)) ||
  fail "bounded Task storage exceeds the 131072 inode hard bound"
[[ -z "$(find "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
  fail "bounded Task storage must be empty before M5"

relative_cgroup="$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)"
[[ "$(stat -fc '%T' /sys/fs/cgroup)" == "cgroup2fs" ]] || fail "M5 requires cgroup v2"
[[ -n "${relative_cgroup}" && "${relative_cgroup}" == /* ]] || fail "current cgroup path is invalid"
parent="$(realpath -e "/sys/fs/cgroup${relative_cgroup}")"
[[ "${parent}" == /sys/fs/cgroup/* && "${parent}" != "/sys/fs/cgroup" ]] ||
  fail "systemd-run must place M5 below a delegated cgroup"
mapfile -t initial_procs < "${parent}/cgroup.procs"
[[ "${#initial_procs[@]}" -eq 1 && "${initial_procs[0]}" == "$$" ]] ||
  fail "the delegated cgroup must initially contain only this runner"

runner_leaf="${parent}/runner"
test_root="${parent}/chronorift-vnext-m5-live"

cleanup() {
  local main_status="$1"
  local cleanup_status=0
  local deadline

  trap - EXIT
  set +e
  if [[ -d "${test_root}" ]]; then
    if [[ -f "${test_root}/cgroup.kill" ]]; then
      printf '%s\n' 1 > "${test_root}/cgroup.kill" || cleanup_status=1
    else
      cleanup_status=1
    fi
    deadline=$((SECONDS + 10))
    while [[ -f "${test_root}/cgroup.events" ]] &&
      ! awk '$1 == "populated" && $2 == "0" { found = 1 } END { exit !found }' "${test_root}/cgroup.events"; do
      if ((SECONDS >= deadline)); then
        cleanup_status=1
        break
      fi
      sleep 0.05
    done
    find "${test_root}" -depth -type d -exec rmdir '{}' \; 2>/dev/null || cleanup_status=1
  fi
  [[ ! -e "${test_root}" ]] || cleanup_status=1
  [[ -z "$(find "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]] || cleanup_status=1
  printf '%s\n' '-cpu -memory -pids' > "${parent}/cgroup.subtree_control" || cleanup_status=1
  printf '%s\n' "$$" > "${parent}/cgroup.procs" || cleanup_status=1
  [[ ! -d "${runner_leaf}" ]] || rmdir "${runner_leaf}" || cleanup_status=1

  if ((main_status != 0)); then
    exit "${main_status}"
  fi
  exit "${cleanup_status}"
}
trap 'cleanup "$?"' EXIT

mkdir "${runner_leaf}" "${test_root}"
printf '%s\n' "$$" > "${runner_leaf}/cgroup.procs"
printf '%s\n' '+cpu +memory +pids' > "${parent}/cgroup.subtree_control"
printf '%s\n' '+cpu +memory +pids' > "${test_root}/cgroup.subtree_control"
for controller in cpu memory pids; do
  [[ " $(<"${test_root}/cgroup.subtree_control") " == *" ${controller} "* ]] ||
    fail "could not delegate ${controller} to M5 Task leaves"
done

export CHRONORIFT_CGROUP_ROOT="${test_root}"
export CHRONORIFT_TEST_CGROUP_ROOT="${test_root}"
export CI=true
export PATH="${managed_node_dir}:${PATH}"
hash -r
[[ "$(realpath -e -- "$(command -v node)")" == "${managed_node_launcher}" ]] ||
  fail "the live Vitest/Pi process must resolve the staged managed Node launcher"
[[ "$(node --version)" == "v22.23.1" ]] ||
  fail "the live Vitest/Pi process resolved the wrong Node version"
corepack pnpm test:vnext:external-behavior-live

[[ "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" rev-parse HEAD)" == "3e793f53598a131c53fb82555191cc14b8db07ff" ]] ||
  fail "external project HEAD changed during M5"
[[ "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" rev-parse 'HEAD^{tree}')" == "a013bd677c712dbf354e8e2f6e8ff7c53d5684c6" ]] ||
  fail "external project tree changed during M5"
[[ -z "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" status --porcelain=v1 --untracked-files=all --ignored=matching)" ]] ||
  fail "external project checkout changed during M5"
[[ -z "$(git -C "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" config --local --get-regexp '^(credential\.|http\..*\.extraheader$)' || true)" ]] ||
  fail "external project checkout gained a local credential binding"
[[ -z "$(find "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
  fail "M5 left bounded Task storage nonempty"
[[ "$(git -C "${GITHUB_WORKSPACE}" rev-parse 'HEAD^{commit}')" == "${product_commit}" &&
  "$(git -C "${GITHUB_WORKSPACE}" rev-parse 'HEAD^{tree}')" == "${product_tree}" ]] ||
  fail "the ChronoRift product subject changed during M5"
[[ -z "$(git -C "${GITHUB_WORKSPACE}" status --porcelain=v1 --untracked-files=all)" ]] ||
  fail "the ChronoRift product-subject checkout changed during M5"
[[ -d "${CHRONORIFT_TEST_M5_EVIDENCE_ROOT}" && ! -L "${CHRONORIFT_TEST_M5_EVIDENCE_ROOT}" ]] ||
  fail "successful M5 must publish a regular evidence directory"

TMPDIR="${RUNNER_TEMP}" "${CHRONORIFT_TEST_NODE_BIN}" \
  .github/scripts/validate-vnext-m5-evidence.mjs \
  "${CHRONORIFT_TEST_M5_TASK_SPEC}" \
  "${CHRONORIFT_TEST_M5_EVIDENCE_SCHEMA}" \
  "${CHRONORIFT_TEST_M5_EVIDENCE_ROOT}" \
  "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}"

managed_toolchain_root="$(dirname -- "${managed_node_dir}")"
for sensitive_path in \
  "${CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT}" \
  "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" \
  "${GITHUB_WORKSPACE}" \
  "${RUNNER_TEMP}" \
  "${HOME}" \
  "${parent}" \
  "${test_root}" \
  "${managed_toolchain_root}" \
  "${CHRONORIFT_TEST_NODE_BIN}" \
  "${CHRONORIFT_TEST_GODOT_BIN}" \
  "${CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT}" \
  "${CHRONORIFT_TEST_M5_EVIDENCE_ROOT}"; do
  if grep -R -F -q -- "${sensitive_path}" "${CHRONORIFT_TEST_M5_EVIDENCE_ROOT}"; then
    fail "M5 evidence exposed a Host path"
  fi
done

printf 'validated M5 public-exposed behavior-change conformance bundle\n'
