#!/usr/bin/env bash
set -euo pipefail

export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null

readonly frozen_commit="3e793f53598a131c53fb82555191cc14b8db07ff"
readonly frozen_tree="a013bd677c712dbf354e8e2f6e8ff7c53d5684c6"

fail() {
  printf 'PE-C external-project conformance precondition failed: %s\n' "$1" >&2
  exit 1
}

require_environment() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "${name} is required"
}

canonical_directory() {
  local label="$1"
  local path="$2"
  local canonical

  [[ "${path}" == /* ]] || fail "${label} must be absolute"
  canonical="$(realpath -e -- "${path}")" || fail "${label} does not exist"
  [[ "${canonical}" == "${path}" ]] || fail "${label} must be canonical"
  [[ -d "${path}" ]] || fail "${label} must be a directory"
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
  [[ -f "${path}" && -x "${path}" ]] ||
    fail "${label} must be an executable file"
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
  CHRONORIFT_TEST_NODE_BIN \
  CHRONORIFT_TEST_GODOT_BIN \
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
  CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT; do
  require_environment "${name}"
done

[[ "${CHRONORIFT_NODE_BIN}" == "${CHRONORIFT_TEST_NODE_BIN}" ]] ||
  fail "Node Host path aliases disagree"
[[ "${GODOT_BIN}" == "${CHRONORIFT_TEST_GODOT_BIN}" ]] ||
  fail "Godot Host path aliases disagree"

canonical_directory "GITHUB_WORKSPACE" "${GITHUB_WORKSPACE}"
canonical_directory "RUNNER_TEMP" "${RUNNER_TEMP}"
canonical_directory \
  "frozen external project checkout" \
  "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}"
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
[[ "$("${CHRONORIFT_TEST_NODE_BIN}" --version)" == "v22.23.1" ]] ||
  fail "managed Node must be exactly v22.23.1"
godot_version="$("${CHRONORIFT_TEST_GODOT_BIN}" --version)"
[[ "${godot_version}" == "4.7.1.stable.official.a13da4feb" ]] ||
  fail "managed Godot must be the exact official 4.7.1 stable build"

readonly contract="${GITHUB_WORKSPACE}/testdata/vnext/pe-c/moddable-platformer.contract.v1.json"
[[ -f "${contract}" ]] || fail "the checked-in PE-C contract is missing"
"${CHRONORIFT_TEST_NODE_BIN}" -e \
  'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (value.schemaVersion !== 1 || value.contractKind !== "chronorift-project-environment-pe-c-host-contract") process.exit(1);' \
  "${contract}" || fail "the checked-in PE-C contract is invalid"
mapfile -t conformance_tests < <(
  find apps/cli/src/vnext -type f \
    -name '*.project-environment-pe-c-host.test.ts' -print
)
[[ "${#conformance_tests[@]}" -gt 0 ]] ||
  fail "at least one PE-C Host conformance test is required"

[[ "$(git -C "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" rev-parse HEAD)" == "${frozen_commit}" ]] ||
  fail "external project HEAD does not match the frozen commit"
[[ "$(git -C "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" rev-parse 'HEAD^{tree}')" == "${frozen_tree}" ]] ||
  fail "external project tree does not match the frozen tree"
[[ -z "$(git -C "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" status --porcelain=v1 --untracked-files=all --ignored=matching)" ]] ||
  fail "external project input checkout must be clean"
[[ -z "$(git -C "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" ls-files -s | awk '$1 == "120000" || $1 == "160000" { print }')" ]] ||
  fail "external project input contains a symlink or submodule"
[[ -z "$(git -C "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" config --local --get-regexp '^(credential\.|http\..*\.extraheader$)' || true)" ]] ||
  fail "external project input retained a local credential binding"

case "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" in
  "${RUNNER_TEMP}"/chronorift-pe-c-external-project-*) ;;
  *) fail "external project input must be the dedicated frozen RUNNER_TEMP checkout" ;;
esac

canonical_directory "bounded Task storage" "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}"
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
test_root="${parent}/chronorift-project-environment-pe-c"
fixture_root=""

cleanup() {
  local main_status="${1}"
  local cleanup_status=0
  local deadline

  trap - EXIT
  set +e

  cleanup_failure() {
    printf 'PE-C external-project conformance cleanup failed: %s\n' "$1" >&2
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
  [[ ! -e "${test_root}" ]] ||
    cleanup_failure "test cgroup root still exists: ${test_root}"

  if [[ -n "${fixture_root}" ]]; then
    case "${fixture_root}" in
      "${RUNNER_TEMP}"/chronorift-pe-c-source-*)
        rm -rf -- "${fixture_root}" ||
          cleanup_failure "could not remove disposable fixture ${fixture_root}"
        ;;
      *) cleanup_failure "refused unexpected disposable fixture path: ${fixture_root}" ;;
    esac
  fi

  if [[ -n "$(find "${CHRONORIFT_TEST_TASK_STORAGE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    cleanup_failure "bounded Task storage retained conformance state: ${CHRONORIFT_TEST_TASK_STORAGE_ROOT}"
  fi

  if [[ -f "${parent}/cgroup.subtree_control" ]]; then
    printf '%s\n' '-cpu -memory -pids' > "${parent}/cgroup.subtree_control" ||
      cleanup_failure "could not disable delegated controllers below ${parent}"
  else
    cleanup_failure "${parent}/cgroup.subtree_control is unavailable"
  fi
  if [[ -f "${parent}/cgroup.procs" ]]; then
    printf '%s\n' "$$" > "${parent}/cgroup.procs" ||
      cleanup_failure "could not move the runner process back to ${parent}"
  else
    cleanup_failure "${parent}/cgroup.procs is unavailable"
  fi
  if [[ -d "${runner_leaf}" ]] && ! rmdir "${runner_leaf}"; then
    cleanup_failure "could not remove runner cgroup ${runner_leaf}"
  fi
  [[ ! -e "${runner_leaf}" ]] ||
    cleanup_failure "runner cgroup still exists: ${runner_leaf}"

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

fixture_root="$(mktemp -d "${RUNNER_TEMP}/chronorift-pe-c-source-XXXXXX")"

git clone --quiet --local --no-hardlinks --no-checkout \
  "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" "${fixture_root}"
git -C "${fixture_root}" checkout --quiet --detach "${frozen_commit}"
git -C "${fixture_root}" remote remove origin
printf 'chronorift-project-environment-pe-c-disposable-v1\n' \
  >"${fixture_root}/.git/chronorift-pe-c-disposable.v1"
[[ "$(grep -Fxc 'run/main_scene="uid://dhcpt1kt8cs0g"' "${fixture_root}/project.godot")" -eq 1 ]] ||
  fail "frozen project main scene no longer matches the PE-C contract"
if grep -Fqx '[editor_plugins]' "${fixture_root}/project.godot"; then
  fail "frozen project unexpectedly already declares editor plugins"
fi
[[ "$(grep -Fxc '[autoload]' "${fixture_root}/project.godot")" -eq 1 ]] ||
  fail "frozen project must contain exactly one autoload section"
if grep -Fq 'PeCRuntimeProbe=' "${fixture_root}/project.godot"; then
  fail "frozen project unexpectedly already declares the PE-C runtime probe"
fi

sed -i \
  's|^run/main_scene="uid://dhcpt1kt8cs0g"$|run/main_scene="res://main.tscn"|' \
  "${fixture_root}/project.godot"
sed -i \
  '/^\[autoload\]$/a PeCRuntimeProbe="*res://pe-c-runtime-probe.gd"' \
  "${fixture_root}/project.godot"
[[ "$(grep -Fxc 'run/main_scene="res://main.tscn"' "${fixture_root}/project.godot")" -eq 1 ]] ||
  fail "fixture did not realize exactly one res:// main scene"
if grep -Fqx 'run/main_scene="uid://dhcpt1kt8cs0g"' \
  "${fixture_root}/project.godot"; then
  fail "fixture retained the frozen UID main scene after replacement"
fi
[[ "$(grep -Fxc 'PeCRuntimeProbe="*res://pe-c-runtime-probe.gd"' "${fixture_root}/project.godot")" -eq 1 ]] ||
  fail "fixture did not realize exactly one PE-C runtime probe autoload"

printf '\nPE-C tracked dirty source closure fixture.\n' >>"${fixture_root}/README.md"
printf '\n[editor_plugins]\nenabled=PackedStringArray("res://addons/pe_c_import_probe/plugin.cfg")\n' \
  >>"${fixture_root}/project.godot"

install -d -m 0755 \
  "${fixture_root}/addons/pe_c_import_probe" \
  "${fixture_root}/pe-c-alternate-project"

cat >"${fixture_root}/addons/pe_c_import_probe/plugin.cfg" <<'EOF'
[plugin]
name="PE-C Import Probe"
description="Deterministic project-local @tool import fixture."
author="ChronoRift conformance"
version="1.0"
script="plugin.gd"
EOF

cat >"${fixture_root}/addons/pe_c_import_probe/plugin.gd" <<'EOF'
@tool
extends EditorPlugin

const MARKER_PATH := "res://.godot/pe-c-import-probe.loaded"
const MARKER_CONTENT := "chronorift-pe-c-import-probe-loaded-v1\n"

func _enter_tree() -> void:
	var marker := FileAccess.open(MARKER_PATH, FileAccess.WRITE)
	if marker == null:
		push_error("PE-C import probe could not create its marker")
		return
	marker.store_string(MARKER_CONTENT)
	marker.flush()

func _exit_tree() -> void:
	pass
EOF

cat >"${fixture_root}/pe-c-secondary.tscn" <<'EOF'
[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://main.tscn" id="1_main"]

[node name="PeCSecondary" type="Node"]

[node name="Game" parent="." instance=ExtResource("1_main")]
EOF

cat >"${fixture_root}/pe-c-runtime-probe.gd" <<'EOF'
extends Node

class PeCRuntimeActor:
	extends Node

	signal chronorift_fixture_phase_changed(phase: int)

	var phase := 0

	func chronorift_fixture_stable_id() -> String:
		return "pe-c-runtime-probe"

	func chronorift_fixture_state() -> Dictionary:
		return {"phase": phase}

	func advance(next_phase: int) -> void:
		phase = next_phase
		chronorift_fixture_phase_changed.emit(phase)

func _ready() -> void:
	call_deferred("_run_fixture")

func _run_fixture() -> void:
	var marker := FileAccess.get_file_as_string("res://.godot/pe-c-import-probe.loaded")
	if marker != "chronorift-pe-c-import-probe-loaded-v1\n":
		push_error("PE-C runtime probe did not observe the @tool import marker")
		return
	for cycle in range(32):
		if not is_inside_tree():
			return
		var first := PeCRuntimeActor.new()
		first.name = "PeCRuntimeActorFirst%d" % cycle
		first.phase = 0
		add_child(first)
		await get_tree().process_frame
		await get_tree().process_frame
		first.advance(1)
		await get_tree().process_frame
		first.queue_free()
		await first.tree_exited

		var second := PeCRuntimeActor.new()
		second.name = "PeCRuntimeActorSecond%d" % cycle
		second.phase = 2
		add_child(second)
		await get_tree().process_frame
		await get_tree().process_frame
		second.advance(3)
		await get_tree().process_frame
		second.queue_free()
		await second.tree_exited
EOF

cat >"${fixture_root}/pe-c-alternate-project/project.godot" <<'EOF'
config_version=5

[application]
config/name="PE-C alternate project"
run/main_scene="res://main.tscn"

[rendering]
renderer/rendering_method="gl_compatibility"
EOF

cat >"${fixture_root}/pe-c-alternate-project/main.tscn" <<'EOF'
[gd_scene format=3]

[node name="AlternateProject" type="Node"]
EOF

cat >"${fixture_root}/pe-c-input.json" <<'EOF'
{
  "fixture": "explicit-untracked-source",
  "schemaVersion": 1
}
EOF

git -C "${fixture_root}" add -- \
  addons/pe_c_import_probe/plugin.cfg \
  addons/pe_c_import_probe/plugin.gd \
  pe-c-alternate-project/main.tscn \
  pe-c-alternate-project/project.godot \
  pe-c-runtime-probe.gd \
  pe-c-secondary.tscn

mapfile -t staged_paths < <(
  git -C "${fixture_root}" diff --cached --name-only --diff-filter=A | sort
)
expected_staged_paths=(
  addons/pe_c_import_probe/plugin.cfg
  addons/pe_c_import_probe/plugin.gd
  pe-c-alternate-project/main.tscn
  pe-c-alternate-project/project.godot
  pe-c-runtime-probe.gd
  pe-c-secondary.tscn
)
[[ "${staged_paths[*]}" == "${expected_staged_paths[*]}" ]] ||
  fail "fixture staged paths do not match the PE-C contract"

[[ "$(git -C "${fixture_root}" rev-parse HEAD)" == "${frozen_commit}" ]] ||
  fail "fixture HEAD drifted while creating the overlay"
[[ "$(git -C "${fixture_root}" rev-parse 'HEAD^{tree}')" == "${frozen_tree}" ]] ||
  fail "fixture base tree drifted while creating the overlay"
git -C "${fixture_root}" diff --quiet --exit-code HEAD -- README.md &&
  fail "fixture is missing the tracked dirty README change"
git -C "${fixture_root}" diff --quiet --exit-code HEAD -- project.godot &&
  fail "fixture is missing the tracked dirty project configuration"
[[ "$(git -C "${fixture_root}" ls-files --others --exclude-standard)" == "pe-c-input.json" ]] ||
  fail "fixture must contain exactly one explicit untracked file"
expected_final_status=(
  ' M README.md'
  ' M project.godot'
  'A  addons/pe_c_import_probe/plugin.cfg'
  'A  addons/pe_c_import_probe/plugin.gd'
  'A  pe-c-alternate-project/main.tscn'
  'A  pe-c-alternate-project/project.godot'
  'A  pe-c-runtime-probe.gd'
  'A  pe-c-secondary.tscn'
  '?? pe-c-input.json'
)
mapfile -t expected_final_status_sorted < <(
  printf '%s\n' "${expected_final_status[@]}" | LC_ALL=C sort
)
mapfile -t final_status < <(
  git -C "${fixture_root}" status --porcelain=v1 --untracked-files=all |
    LC_ALL=C sort
)
[[ "${#final_status[@]}" -eq "${#expected_final_status_sorted[@]}" ]] ||
  fail "fixture final dirty entry count does not match the PE-C contract"
for index in "${!expected_final_status_sorted[@]}"; do
  [[ "${final_status[$index]}" == "${expected_final_status_sorted[$index]}" ]] ||
    fail "fixture final dirty set does not match the PE-C contract"
done
mapfile -t discovered_projects < <(
  find "${fixture_root}" -type f -name project.godot -printf '%P\n' | sort
)
[[ "${#discovered_projects[@]}" -eq 2 ]] ||
  fail "fixture must contain exactly two Godot projects"
[[ "${discovered_projects[0]}" == "pe-c-alternate-project/project.godot" ]] ||
  fail "fixture alternate project was not created as declared"
[[ "${discovered_projects[1]}" == "project.godot" ]] ||
  fail "fixture root project was not preserved"

export CHRONORIFT_TEST_PE_C_PROJECT_ROOT="${fixture_root}"
export CHRONORIFT_TEST_PE_C_DISPOSABLE_PROJECT_ROOT="${fixture_root}"
export CHRONORIFT_TEST_PE_C_SELECTED_PROJECT_ROOT="."
export CHRONORIFT_TEST_PE_C_INCLUDE_UNTRACKED_JSON='["pe-c-input.json"]'
export CHRONORIFT_TEST_PE_C_DEFAULT_TARGET="main"
export CHRONORIFT_TEST_PE_C_SELECTED_TARGET="secondary"
export CHRONORIFT_TEST_PE_C_CONTRACT="${contract}"
export CHRONORIFT_CGROUP_ROOT="${test_root}"
export CHRONORIFT_TEST_CGROUP_ROOT="${test_root}"
export CI=true

corepack pnpm test:vnext:project-environment-pe-c-host

[[ "$(git -C "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" rev-parse HEAD)" == "${frozen_commit}" ]] ||
  fail "frozen external project HEAD changed during PE-C conformance"
[[ "$(git -C "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" rev-parse 'HEAD^{tree}')" == "${frozen_tree}" ]] ||
  fail "frozen external project tree changed during PE-C conformance"
[[ -z "$(git -C "${CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT}" status --porcelain=v1 --untracked-files=all --ignored=matching)" ]] ||
  fail "frozen external project checkout changed during PE-C conformance"
