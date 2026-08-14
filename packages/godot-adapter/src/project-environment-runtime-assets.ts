import { DEFAULT_RUNTIME_SIDECAR_TARGETS } from "./runtime-sidecar-source.js";

export const PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V1 =
  "chronorift-managed-godot-project-environment-v1" as const;

export const GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V1 =
  '[autoload]\n\nChronoRiftProjectEnvironment="*res://addons/chronorift_project_environment/bridge.gd"\n';

export const DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1 = Object.freeze({
  nodeExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
  godotExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
  fontconfigProbeExecutable:
    DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigProbeExecutable,
  shellExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
  xdgUserDirExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
  fontconfigFile: DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile,
  godotPath: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotPath,
  workspaceRoot: "/workspace",
  runtimeRoot: "/run/chronorift",
  vanillaProjectRoot: "/run/chronorift/vanilla/project",
  overlayProjectRoot: "/run/chronorift/overlay/project",
  managedAddonParent: "/run/chronorift/overlay/project/addons",
  managedAddonRoot:
    "/run/chronorift/overlay/project/addons/chronorift_project_environment",
  managedOverrideFile: "/run/chronorift/overlay/project/override.cfg",
  managedSdkRoot:
    "/run/chronorift/overlay/project/addons/chronorift_project_environment/sdk",
  managedAdapterParent: "/run/chronorift/overlay/project/.chronorift",
  managedAdapterRoot:
    "/run/chronorift/overlay/project/.chronorift/project-adapter",
} as const);

export const PROJECT_ENVIRONMENT_RUNTIME_ROLES_V1 = Object.freeze({
  bridge: Object.freeze({
    role: "bridge" as const,
    target: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAddonRoot,
  }),
  sdk: Object.freeze({
    role: "sdk" as const,
    target: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedSdkRoot,
  }),
  adapter: Object.freeze({
    role: "adapter" as const,
    target: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterRoot,
  }),
});

export interface ProjectEnvironmentRuntimeAssetFileV1 {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

const utf8 = (value: string): Uint8Array => Buffer.from(value, "utf8");

export const GODOT_PROJECT_ENVIRONMENT_BRIDGE_SOURCE_V1 = String.raw`extends Node

const SCHEMA_VERSION := 1
const PROTOCOL_PROFILE := "chronorift-godot-project-environment-v1"
const PROTOCOL_VERSION := 1
const ADAPTER_ROOT := "res://.chronorift/project-adapter"
const MANIFEST_PATH := ADAPTER_ROOT + "/manifest.json"
const MAX_FRAME_BYTES := 1024 * 1024
const MAX_BATCH_RECORDS := 128
const MAX_PENDING_RECORDS := 4096
const MAX_QUERY_ROWS := 512
const MAX_SAMPLE_RECORDS := 256
const MAX_SNAPSHOTS := 16
const MAX_VALUE_DEPTH := 32
const MAX_VALUE_NODES := 4096
const SAMPLE_FRAME_INTERVAL := 6
const GENERIC_MODULES := ["lifecycle", "clock", "runtime_error", "capture"]
const INSTRUMENTED_CAPTURE_CHANNELS := ["entity", "state", "event", "runtime_error", "clock", "capture_loss"]
const BRIDGE_ONLY_CAPTURE_CHANNELS := ["runtime_error", "clock", "capture_loss"]
const OPTIONAL_COMMANDS := ["input", "controls_set", "step", "snapshot_create", "snapshot_restore"]
const ENTITY_MODULE_BASE := preload("res://addons/chronorift_project_environment/sdk/entity_projection_v1.gd")
const STATE_MODULE_BASE := preload("res://addons/chronorift_project_environment/sdk/state_projection_v1.gd")
const EVENT_MODULE_BASE := preload("res://addons/chronorift_project_environment/sdk/event_projection_v1.gd")
const INPUT_MODULE_BASE := preload("res://addons/chronorift_project_environment/sdk/input_control_v1.gd")
const SNAPSHOT_MODULE_BASE := preload("res://addons/chronorift_project_environment/sdk/snapshot_v1.gd")
const RESTORE_MODULE_BASE := preload("res://addons/chronorift_project_environment/sdk/restore_v1.gd")

var _peer := StreamPeerTCP.new()
var _receive_buffer := PackedByteArray()
var _outgoing_sequence := 0
var _expected_incoming_sequence := 0
var _next_record_sequence := 0
var _connected := false
var _accepted := false
var _runtime_ready := false
var _stopping := false
var _process_time_us := 0
var _physics_time_us := 0
var _window_batches := 0
var _rolling_record_limit := 4096
var _pending_records: Array[Dictionary] = []
var _history: Array[Dictionary] = []
var _overwritten_records := 0
var _total_dropped_records := 0
var _pending_drop_first := -1
var _pending_drop_last := -1
var _pending_drop_count := 0
var _last_sample_frame := -1
var _entity_previous: Dictionary = {}
var _manifest: Dictionary = {}
var _module_states: Dictionary = {}
var _modules: Dictionary = {}
var _instrumentation_mode := ""
var _configured_main_scene := ""
var _adapter_failure := ""
var _next_snapshot_id := 0
var _snapshots: Dictionary = {}
var _snapshot_order: Array[String] = []
var _state_semantic_coverage: Dictionary = {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_priority = -1000
	_instrumentation_mode = OS.get_environment("CHRONORIFT_INSTRUMENTATION_MODE")
	_configured_main_scene = OS.get_environment("CHRONORIFT_EXPECTED_MAIN_SCENE")
	if _instrumentation_mode != "bridge_only" and _instrumentation_mode != "instrumented":
		push_error("ChronoRift Project Environment instrumentation mode is invalid")
		get_tree().quit(2)
		return
	if not _valid_resource_reference(_configured_main_scene):
		push_error("ChronoRift Project Environment main scene is invalid")
		get_tree().quit(2)
		return
	if _instrumentation_mode == "instrumented" and not _load_adapter():
		push_error(_adapter_failure)
		get_tree().quit(2)
		return
	if _instrumentation_mode == "bridge_only":
		_module_states = _bridge_only_module_states()
	var host := OS.get_environment("CHRONORIFT_HOST")
	var port := int(OS.get_environment("CHRONORIFT_PORT"))
	if host.is_empty() or port <= 0:
		push_error("ChronoRift Project Environment requires a managed Host endpoint")
		return
	var connection_status := _peer.connect_to_host(host, port)
	if connection_status != OK:
		push_error("ChronoRift Project Environment could not connect to the managed Host endpoint")


func _process(delta: float) -> void:
	_process_time_us += maxi(0, int(round(delta * 1000000.0)))
	_peer.poll()
	if not _connected and _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_connected = true
		_send("hello", {
			"token": OS.get_environment("CHRONORIFT_TOKEN"),
			"fingerprint": _fingerprint(),
		})
	if not _connected:
		return
	_read_available_frames()
	if _runtime_ready and _instrumentation_mode == "instrumented":
		var frame := Engine.get_process_frames()
		if _last_sample_frame < 0 or frame - _last_sample_frame >= SAMPLE_FRAME_INTERVAL:
			_last_sample_frame = frame
			_sample_adapter()
	_flush_loss_record()
	_flush_observations()


func _physics_process(delta: float) -> void:
	_physics_time_us += maxi(0, int(round(delta * 1000000.0)))


func _load_adapter() -> bool:
	if FileAccess.get_sha256(MANIFEST_PATH) != OS.get_environment("CHRONORIFT_ADAPTER_MANIFEST_HASH"):
		_adapter_failure = "ProjectAdapter manifest identity does not match the managed binding"
		return false
	var manifest_text := FileAccess.get_file_as_string(MANIFEST_PATH)
	var parsed: Variant = JSON.parse_string(manifest_text)
	if not parsed is Dictionary:
		_adapter_failure = "ProjectAdapter manifest is not a JSON object"
		return false
	_manifest = parsed
	if int(_manifest.get("schemaVersion", -1)) != 1 or str(_manifest.get("manifestKind", "")) != "chronorift-project-adapter":
		_adapter_failure = "ProjectAdapter manifest profile is unsupported"
		return false
	var entry := str(_manifest.get("entryScript", ""))
	if not _valid_package_path(entry) or not entry.begins_with("src/") or not entry.ends_with(".gd"):
		_adapter_failure = "ProjectAdapter entry path is invalid"
		return false
	var entry_path := ADAPTER_ROOT + "/" + entry
	var script: Variant = load(entry_path)
	if not script is Script:
		_adapter_failure = "ProjectAdapter entry did not load as GDScript"
		return false
	var adapter: Variant = script.new()
	if adapter == null or not adapter.has_method("create_modules"):
		_adapter_failure = "ProjectAdapter entry does not implement create_modules"
		return false
	var created: Variant = adapter.call("create_modules")
	if not created is Dictionary:
		_adapter_failure = "ProjectAdapter create_modules did not return a Dictionary"
		return false
	_modules = created
	var capability_set: Variant = _manifest.get("modules")
	if not capability_set is Dictionary or not capability_set.get("modules") is Array:
		_adapter_failure = "ProjectAdapter capability set is invalid"
		return false
	for declaration_value in capability_set.get("modules", []):
		if not declaration_value is Dictionary:
			_adapter_failure = "ProjectAdapter module declaration is invalid"
			return false
		var declaration: Dictionary = declaration_value
		var module_name := str(declaration.get("module", ""))
		if module_name.is_empty() or _module_states.has(module_name):
			_adapter_failure = "ProjectAdapter module identities are invalid"
			return false
		_module_states[module_name] = declaration.duplicate(true)
	for required in ["entity_projection", "state_projection", "event_projection"]:
		if not _modules.has(required) or not is_instance_valid(_modules[required]):
			_adapter_failure = "ProjectAdapter required module object is missing: " + required
			return false
		if not _module_uses_sdk_base(required, _modules[required]):
			_adapter_failure = "ProjectAdapter module does not inherit its managed SDK base: " + required
			return false
	for optional in ["input_control", "snapshot", "restore"]:
		var state: Variant = _module_states.get(optional)
		if state is Dictionary and str(state.get("status", "")) in ["implemented", "degraded"]:
			if not _modules.has(optional) or not is_instance_valid(_modules[optional]):
				_adapter_failure = "Implemented ProjectAdapter module object is missing: " + optional
				return false
			if not _module_uses_sdk_base(optional, _modules[optional]):
				_adapter_failure = "ProjectAdapter module does not inherit its managed SDK base: " + optional
				return false
	return true


func _module_uses_sdk_base(module_name: String, module: Variant) -> bool:
	match module_name:
		"entity_projection":
			return _script_inherits(module, ENTITY_MODULE_BASE)
		"state_projection":
			return _script_inherits(module, STATE_MODULE_BASE)
		"event_projection":
			return _script_inherits(module, EVENT_MODULE_BASE)
		"input_control":
			return _script_inherits(module, INPUT_MODULE_BASE)
		"snapshot":
			return _script_inherits(module, SNAPSHOT_MODULE_BASE)
		"restore":
			return _script_inherits(module, RESTORE_MODULE_BASE)
	return false


func _script_inherits(instance: Variant, expected_base: Script) -> bool:
	if instance == null or not instance.has_method("get_script"):
		return false
	var script: Script = instance.get_script() as Script
	while script != null:
		if script == expected_base:
			return true
		script = script.get_base_script()
	return false


func _bridge_only_module_states() -> Dictionary:
	var states := {}
	for module_name in [
		"lifecycle", "clock", "runtime_error", "entity_projection", "state_projection",
		"event_projection", "capture", "input_control", "snapshot", "restore",
		"render_capture", "alignment",
	]:
		var implemented: bool = module_name in GENERIC_MODULES
		states[module_name] = {
			"schemaVersion": 1,
			"module": module_name,
			"status": "implemented" if implemented else "unsupported",
			"protocolVersion": "project-environment-bridge:v1" if implemented else null,
			"limitations": [] if implemented else ["bridge-only mode does not load project semantics"],
		}
	return states


func _module_set() -> Dictionary:
	var names: Array = _module_states.keys()
	names.sort()
	var values: Array = []
	for name in names:
		values.append((_module_states[name] as Dictionary).duplicate(true))
	return {"schemaVersion": 1, "modules": values}


func _fingerprint() -> Dictionary:
	var version_info := Engine.get_version_info()
	return {
		"schemaVersion": SCHEMA_VERSION,
		"protocolProfile": PROTOCOL_PROFILE,
		"protocolVersion": PROTOCOL_VERSION,
		"engine": "godot",
		"engineVersion": str(version_info.get("string", "unknown")),
		"engineBuildHash": str(version_info.get("hash", "")),
		"platform": OS.get_name(),
		"renderer": "headless",
		"displayServer": "headless",
		"audioDriver": AudioServer.get_driver_name(),
		"physicsTicksPerSecond": Engine.physics_ticks_per_second,
		"configuredMainScene": _configured_main_scene,
		"modules": _module_set(),
		"identity": {
			"taskId": OS.get_environment("CHRONORIFT_TASK_ID"),
			"sourceClosureId": OS.get_environment("CHRONORIFT_SOURCE_CLOSURE_ID"),
			"environmentRevisionId": OS.get_environment("CHRONORIFT_ENVIRONMENT_REVISION_ID"),
			"adapterRevisionId": OS.get_environment("CHRONORIFT_ADAPTER_REVISION_ID"),
			"buildId": OS.get_environment("CHRONORIFT_BUILD_ID"),
			"runtimeId": OS.get_environment("CHRONORIFT_RUNTIME_ID"),
			"executionId": OS.get_environment("CHRONORIFT_EXECUTION_ID"),
			"instrumentationMode": _instrumentation_mode,
			"candidateSourceHash": OS.get_environment("CHRONORIFT_CANDIDATE_SOURCE_HASH"),
			"adapterManifestSha256": OS.get_environment("CHRONORIFT_ADAPTER_MANIFEST_HASH"),
			"sdkSha256": OS.get_environment("CHRONORIFT_SDK_HASH"),
			"bridgeSha256": OS.get_environment("CHRONORIFT_BRIDGE_HASH"),
			"toolchainSha256": OS.get_environment("CHRONORIFT_TOOLCHAIN_HASH"),
		},
	}


func _clock() -> Dictionary:
	return {
		"processFrame": Engine.get_process_frames(),
		"physicsTick": Engine.get_physics_frames(),
		"simulationTimeUs": _process_time_us,
		"renderFrame": null,
	}


func _status() -> Dictionary:
	return {
		"running": not _stopping,
		"configuredMainScene": _configured_main_scene,
		"currentScene": _current_scene_reference(),
		"clock": _clock(),
		"nextObservationRecordSequence": _next_record_sequence,
		"coverage": _coverage(),
	}


func _coverage() -> Dictionary:
	var first: Variant = null
	var last: Variant = null
	if not _history.is_empty():
		first = int(_history[0].get("recordSequence", 0))
		last = int(_history[-1].get("recordSequence", 0))
	return {
		"status": "partial" if _overwritten_records > 0 or _total_dropped_records > 0 else "complete",
		"firstAvailableRecordSequence": first,
		"lastAvailableRecordSequence": last,
		"droppedRecordCount": _total_dropped_records,
		"overwriteCount": _overwritten_records,
		"semanticCoverage": _semantic_coverage(),
	}


func _semantic_coverage() -> String:
	if _instrumentation_mode != "instrumented":
		return "unknown"
	if _state_semantic_coverage.is_empty():
		return "unknown"
	var result := "declared"
	for observed_value in _state_semantic_coverage.values():
		var observed := str(observed_value)
		if observed == "unknown":
			return "unknown"
		if observed == "partial":
			result = "partial"
	return result


func _current_scene_reference() -> Variant:
	var scene := get_tree().current_scene
	if scene == null:
		return null
	var scene_path := str(scene.scene_file_path)
	return _configured_main_scene if scene_path.is_empty() else scene_path


func _sample_adapter() -> void:
	var scene := get_tree().current_scene
	if scene == null:
		return
	_sample_entities(scene)
	_sample_states(scene)
	_sample_events(scene)


func _sample_entities(scene: Node) -> void:
	var module: Variant = _modules.get("entity_projection")
	if module == null or not module.has_method("sample"):
		_runtime_error("ADAPTER_MODULE_MISSING", "entity_projection.sample is unavailable")
		return
	var sampled: Variant = module.call("sample", scene)
	if not sampled is Array or sampled.size() > MAX_SAMPLE_RECORDS:
		_runtime_error("ADAPTER_SAMPLE_INVALID", "entity projection returned an invalid bounded array")
		return
	var current := {}
	for item_value in sampled:
		if not item_value is Dictionary:
			_runtime_error("ADAPTER_SAMPLE_INVALID", "entity projection record is not a Dictionary")
			continue
		var item: Dictionary = item_value
		var entity_id := _bounded_id(item.get("entityId"))
		var entity_type_id := _bounded_stable_id(item.get("entityTypeId"))
		var incarnation := int(item.get("incarnation", 0))
		var identity_scope := str(item.get("identityScope", ""))
		var projected := _canonical_value(item.get("projection"), 0, [0])
		if entity_id.is_empty() or entity_type_id.is_empty() or incarnation < 1 or not identity_scope in ["project_persistent", "authored", "spawn_lineage", "execution_local"] or not projected.get("ok", false):
			_runtime_error("ADAPTER_SAMPLE_INVALID", "entity projection record failed canonical validation")
			continue
		var normalized := {
			"entityId": entity_id,
			"entityTypeId": entity_type_id,
			"incarnation": incarnation,
			"identityScope": identity_scope,
			"projection": projected.get("value"),
		}
		current[entity_id] = normalized
		var phase := "appeared" if not _entity_previous.has(entity_id) else "updated"
		if phase == "appeared" or _canonical_json(_entity_previous[entity_id]) != _canonical_json(normalized):
			_append_record("entity_lifecycle", {
				"phase": phase,
				"entityId": entity_id,
				"entityTypeId": entity_type_id,
				"incarnation": incarnation,
				"identityScope": identity_scope,
				"projection": projected.get("value"),
			})
	for previous_id in _entity_previous.keys():
		if not current.has(previous_id):
			var previous: Dictionary = _entity_previous[previous_id]
			_append_record("entity_lifecycle", {
				"phase": "disappeared",
				"entityId": previous_id,
				"entityTypeId": previous.get("entityTypeId"),
				"incarnation": previous.get("incarnation"),
				"identityScope": previous.get("identityScope"),
				"projection": null,
			})
	_entity_previous = current


func _sample_states(scene: Node) -> void:
	var module: Variant = _modules.get("state_projection")
	if module == null or not module.has_method("sample"):
		_runtime_error("ADAPTER_MODULE_MISSING", "state_projection.sample is unavailable")
		return
	var sampled: Variant = module.call("sample", scene)
	if not sampled is Array or sampled.size() > MAX_SAMPLE_RECORDS:
		_runtime_error("ADAPTER_SAMPLE_INVALID", "state projection returned an invalid bounded array")
		return
	for item_value in sampled:
		if not item_value is Dictionary:
			continue
		var item: Dictionary = item_value
		var state_domain_id := _bounded_stable_id(item.get("stateDomainId"))
		var coverage := str(item.get("semanticCoverage", ""))
		var projected := _canonical_value(item.get("value"), 0, [0])
		if state_domain_id.is_empty() or not coverage in ["declared", "partial", "unknown"] or not projected.get("ok", false):
			_runtime_error("ADAPTER_SAMPLE_INVALID", "state projection record failed canonical validation")
			continue
		var previous_coverage := str(_state_semantic_coverage.get(state_domain_id, ""))
		if previous_coverage.is_empty():
			_state_semantic_coverage[state_domain_id] = coverage
		elif previous_coverage == "unknown" or coverage == "unknown":
			_state_semantic_coverage[state_domain_id] = "unknown"
		elif previous_coverage == "partial" or coverage == "partial":
			_state_semantic_coverage[state_domain_id] = "partial"
		else:
			_state_semantic_coverage[state_domain_id] = "declared"
		_append_record("state_sample", {
			"stateDomainId": state_domain_id,
			"value": projected.get("value"),
			"semanticCoverage": coverage,
		})


func _sample_events(scene: Node) -> void:
	var module: Variant = _modules.get("event_projection")
	if module == null or not module.has_method("drain"):
		_runtime_error("ADAPTER_MODULE_MISSING", "event_projection.drain is unavailable")
		return
	var sampled: Variant = module.call("drain", scene)
	if not sampled is Array or sampled.size() > MAX_SAMPLE_RECORDS:
		_runtime_error("ADAPTER_SAMPLE_INVALID", "event projection returned an invalid bounded array")
		return
	for item_value in sampled:
		if not item_value is Dictionary:
			continue
		var item: Dictionary = item_value
		var event_type_id := _bounded_stable_id(item.get("eventTypeId"))
		var source_entity: Variant = item.get("sourceEntityId")
		var projected := _canonical_value(item.get("value"), 0, [0])
		if event_type_id.is_empty() or (source_entity != null and _bounded_id(source_entity).is_empty()) or not projected.get("ok", false):
			_runtime_error("ADAPTER_SAMPLE_INVALID", "event projection record failed canonical validation")
			continue
		_append_record("adapter_event", {
			"eventTypeId": event_type_id,
			"sourceEntityId": source_entity,
			"value": projected.get("value"),
		})


func _runtime_error(code: String, message: String) -> void:
	_append_record("runtime_error", {
		"channel": "bridge",
		"severity": "error",
		"code": code.to_lower(),
		"message": _bounded_message(message),
	})


func _append_record(kind: String, payload: Dictionary) -> void:
	var sequence := _next_record_sequence
	_next_record_sequence += 1
	if _pending_records.size() >= MAX_PENDING_RECORDS:
		if _pending_drop_count == 0:
			_pending_drop_first = sequence
		_pending_drop_last = sequence
		_pending_drop_count += 1
		_total_dropped_records += 1
		return
	var record := {
		"schemaVersion": 1,
		"recordSequence": sequence,
		"clock": _clock(),
		"kind": kind,
		"payload": payload,
	}
	_pending_records.append(record)
	_history.append(record.duplicate(true))
	while _history.size() > _rolling_record_limit:
		_history.pop_front()
		_overwritten_records += 1


func _flush_loss_record() -> void:
	if _pending_drop_count == 0 or _pending_records.size() >= MAX_PENDING_RECORDS:
		return
	var first := _pending_drop_first
	var last := _pending_drop_last
	var count := _pending_drop_count
	_pending_drop_first = -1
	_pending_drop_last = -1
	_pending_drop_count = 0
	_append_record("capture_loss", {
		"channel": "adapter",
		"firstDroppedRecordSequence": first,
		"lastDroppedRecordSequence": last,
		"droppedRecordCount": count,
		"reason": "backpressure",
	})


func _flush_observations() -> void:
	while _window_batches > 0 and not _pending_records.is_empty():
		var count := mini(MAX_BATCH_RECORDS, _pending_records.size())
		var records: Array[Dictionary] = []
		for index in count:
			records.append(_pending_records.pop_front())
		var first := int(records[0].get("recordSequence", 0))
		var last := int(records[-1].get("recordSequence", 0))
		_send("observation_batch", {
			"batchId": "batch:%d" % first,
			"firstRecordSequence": first,
			"lastRecordSequence": last,
			"records": records,
			"coverage": _coverage(),
		})
		_window_batches -= 1


func _handle_message(message: Dictionary) -> void:
	var kind := str(message.get("kind", ""))
	var expects_request := kind != "observation_ack"
	var keys := ["schemaVersion", "protocolProfile", "protocolVersion", "sequence", "payloadHash", "kind", "payload"]
	if expects_request:
		keys.append("requestId")
	if not _has_exact_keys(message, keys) or int(message.get("schemaVersion", -1)) != SCHEMA_VERSION or str(message.get("protocolProfile", "")) != PROTOCOL_PROFILE or int(message.get("protocolVersion", -1)) != PROTOCOL_VERSION:
		_send_error(_request_id(message), "PROTOCOL_MISMATCH", "Unsupported Project Environment envelope")
		return
	if int(message.get("sequence", -1)) != _expected_incoming_sequence:
		_send_error(_request_id(message), "INVALID_COMMAND", "Unexpected Project Environment message sequence")
		return
	_expected_incoming_sequence += 1
	var request_id := _request_id(message)
	if expects_request and request_id.is_empty():
		_send_error("", "INVALID_COMMAND", "Project Environment command requires a request identity")
		return
	var payload: Variant = message.get("payload")
	if not payload is Dictionary or payload_hash(payload) != str(message.get("payloadHash", "")):
		_send_error(request_id, "INVALID_COMMAND", "Project Environment payload hash mismatch")
		return
	match kind:
		"hello_accept":
			_handle_accept(request_id, payload)
		"status":
			if not _runtime_ready or not _has_exact_keys(payload, []):
				_send_error(request_id, "INVALID_COMMAND", "Project Environment runtime is not ready")
			else:
				_send("status_result", _status(), request_id)
		"observation_ack":
			if _has_exact_keys(payload, ["batchId", "acceptedThroughRecordSequence", "nextWindowBatches"]):
				_window_batches = clampi(int(payload.get("nextWindowBatches", 1)), 1, 32)
		"query":
			_handle_query(request_id, payload)
		"capture_configure":
			_handle_capture(request_id, payload)
		"barrier":
			_handle_barrier(request_id, payload)
		"input":
			_handle_input(request_id, payload)
		"controls_set":
			_handle_controls_set(request_id, payload)
		"snapshot_create":
			_handle_snapshot_create(request_id, payload)
		"snapshot_restore":
			_handle_snapshot_restore(request_id, payload)
		"shutdown":
			_stopping = true
			_send("shutdown_ack", {"status": _status()}, request_id)
			_peer.poll()
			get_tree().quit()
		_:
			if kind in OPTIONAL_COMMANDS:
				_send_error(request_id, "CAPABILITY_UNSUPPORTED", "Optional ProjectAdapter command is unsupported by this runtime")
			else:
				_send_error(request_id, "INVALID_COMMAND", "Unknown Project Environment command")


func _usable_optional_module(module_name: String) -> Variant:
	var state: Variant = _module_states.get(module_name)
	if not state is Dictionary or not str(state.get("status", "")) in ["implemented", "degraded"]:
		return null
	var module: Variant = _modules.get(module_name)
	return module if module != null and is_instance_valid(module) else null


func _valid_barrier(value: String) -> bool:
	return value in ["process_frame_end", "physics_tick_end", "render_complete"]


func _await_supported_barrier(requested: String) -> Dictionary:
	if not _valid_barrier(requested):
		return {"ok": false, "code": "INVALID_COMMAND", "message": "Barrier kind is invalid"}
	if requested == "render_complete":
		return {"ok": false, "code": "CAPABILITY_UNSUPPORTED", "message": "render_complete is unavailable in headless PE-A"}
	var started := Time.get_ticks_usec()
	if requested == "physics_tick_end":
		await get_tree().physics_frame
	else:
		await get_tree().process_frame
	return {
		"ok": true,
		"realizedBarrier": requested,
		"clock": _clock(),
		"quantizationDelayUs": maxi(0, Time.get_ticks_usec() - started),
	}


func _handle_input(request_id: String, payload: Dictionary) -> void:
	if not _has_exact_keys(payload, ["controlId", "parameters", "phase", "duration"]):
		_send_error(request_id, "INVALID_COMMAND", "Input payload is invalid")
		return
	var module := _usable_optional_module("input_control")
	if module == null or not module.has_method("apply"):
		_send_error(request_id, "CAPABILITY_UNSUPPORTED", "ProjectAdapter input control is unavailable")
		return
	var control_id := _bounded_stable_id(payload.get("controlId"))
	var phase := str(payload.get("phase", ""))
	var duration: Variant = payload.get("duration")
	var parameters := _canonical_value(payload.get("parameters"), 0, [0])
	if control_id.is_empty() or not phase in ["process", "physics"] or not duration is Dictionary or not _has_exact_keys(duration, ["clock", "count"]) or not parameters.get("ok", false):
		_send_error(request_id, "INVALID_COMMAND", "Input control fields are invalid")
		return
	var duration_clock := str(duration.get("clock", ""))
	var duration_count := int(duration.get("count", 0))
	if not duration_clock in ["process_frame", "physics_tick"] or duration_count < 1 or duration_count > 600:
		_send_error(request_id, "INVALID_COMMAND", "Input duration is invalid")
		return
	var started := _clock()
	var result: Variant = module.call("apply", get_tree().current_scene, {
		"controlId": control_id,
		"parameters": parameters.get("value"),
		"active": true,
		"phase": phase,
		"duration": duration.duplicate(true),
	})
	if not result is Dictionary or not _has_exact_keys(result, ["status", "realizedParameters", "knownSideEffects"]) or str(result.get("status", "")) != "applied":
		_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter rejected or returned an invalid input result")
		return
	var realized_parameters := _canonical_value(result.get("realizedParameters"), 0, [0])
	var side_effects := _bounded_string_array(result.get("knownSideEffects", []), 64)
	if not realized_parameters.get("ok", false) or side_effects == null:
		_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter input side effects are invalid")
		return
	_send("input_applied", {
		"controlId": control_id,
		"requestedPhase": phase,
		"realizedPhase": phase,
		"requestedDuration": duration.duplicate(true),
		"realizedDuration": duration.duplicate(true),
		"startClock": started,
		"endClock": _clock(),
		"knownSideEffects": side_effects,
	}, request_id)


func _handle_controls_set(request_id: String, payload: Dictionary) -> void:
	if not _has_exact_keys(payload, ["controls", "requestedBarrier"]):
		_send_error(request_id, "INVALID_COMMAND", "Control-set payload is invalid")
		return
	var module := _usable_optional_module("input_control")
	if module == null or not module.has_method("apply"):
		_send_error(request_id, "CAPABILITY_UNSUPPORTED", "ProjectAdapter input control is unavailable")
		return
	var controls: Variant = payload.get("controls")
	var requested := str(payload.get("requestedBarrier", ""))
	if not controls is Array or controls.is_empty() or controls.size() > 64 or not _valid_barrier(requested):
		_send_error(request_id, "INVALID_COMMAND", "Control-set fields are invalid")
		return
	var seen := {}
	var realized: Array = []
	for control_value in controls:
		if not control_value is Dictionary or not _has_exact_keys(control_value, ["controlId", "parameters", "active"]):
			_send_error(request_id, "INVALID_COMMAND", "Control-set entry is invalid")
			return
		var control_id := _bounded_stable_id(control_value.get("controlId"))
		var parameters := _canonical_value(control_value.get("parameters"), 0, [0])
		if control_id.is_empty() or seen.has(control_id) or not parameters.get("ok", false):
			_send_error(request_id, "INVALID_COMMAND", "Control-set identity or value is invalid")
			return
		seen[control_id] = true
		var result: Variant = module.call("apply", get_tree().current_scene, {
			"controlId": control_id,
			"parameters": parameters.get("value"),
			"active": bool(control_value.get("active", false)),
		})
		if not result is Dictionary or not _has_exact_keys(result, ["status", "realizedParameters", "knownSideEffects"]) or not str(result.get("status", "")) in ["applied", "rejected"]:
			_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter returned an invalid control result")
			return
		var realized_value := _canonical_value(result.get("realizedParameters", parameters.get("value")), 0, [0])
		var side_effects := _bounded_string_array(result.get("knownSideEffects"), 64)
		if not realized_value.get("ok", false) or side_effects == null:
			_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter realized control value is invalid")
			return
		realized.append({
			"controlId": control_id,
			"active": str(result.get("status")) == "applied",
			"realizedParameters": realized_value.get("value"),
		})
	var barrier_result := await _await_supported_barrier(requested)
	if not barrier_result.get("ok", false):
		_send_error(request_id, str(barrier_result.get("code")), str(barrier_result.get("message")))
		return
	_send("controls_set_result", {
		"realizedControls": realized,
		"requestedBarrier": requested,
		"realizedBarrier": barrier_result.get("realizedBarrier"),
		"clock": barrier_result.get("clock"),
		"quantizationDelayUs": barrier_result.get("quantizationDelayUs"),
	}, request_id)


func _handle_snapshot_create(request_id: String, payload: Dictionary) -> void:
	if not _has_exact_keys(payload, ["requestedBarrier"]):
		_send_error(request_id, "INVALID_COMMAND", "Snapshot payload is invalid")
		return
	var module := _usable_optional_module("snapshot")
	if module == null or not module.has_method("capture"):
		_send_error(request_id, "CAPABILITY_UNSUPPORTED", "ProjectAdapter snapshot is unavailable")
		return
	var requested := str(payload.get("requestedBarrier", ""))
	var barrier_result := await _await_supported_barrier(requested)
	if not barrier_result.get("ok", false):
		_send_error(request_id, str(barrier_result.get("code")), str(barrier_result.get("message")))
		return
	var captured: Variant = module.call("capture", get_tree().current_scene)
	if not captured is Dictionary or captured.size() > 128:
		_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter snapshot result is invalid")
		return
	var normalized_values := {}
	var domains := _snapshot_domains(captured, normalized_values)
	if domains == null:
		_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter snapshot domains are invalid")
		return
	var snapshot_id := "snapshot:%d" % _next_snapshot_id
	_next_snapshot_id += 1
	_snapshots[snapshot_id] = normalized_values.duplicate(true)
	_snapshot_order.append(snapshot_id)
	while _snapshot_order.size() > MAX_SNAPSHOTS:
		_snapshots.erase(_snapshot_order.pop_front())
	_send("snapshot_result", {
		"snapshotId": snapshot_id,
		"requestedBarrier": requested,
		"realizedBarrier": barrier_result.get("realizedBarrier"),
		"clock": barrier_result.get("clock"),
		"quantizationDelayUs": barrier_result.get("quantizationDelayUs"),
		"domains": domains,
	}, request_id)


func _snapshot_domains(captured: Dictionary, normalized_values: Dictionary) -> Variant:
	var declarations: Variant = _manifest.get("stateDomains")
	if not declarations is Array or declarations.is_empty() or declarations.size() > 128:
		return null
	var declared := {}
	var domains: Array = []
	for declaration_value in declarations:
		if not declaration_value is Dictionary:
			return null
		var declaration: Dictionary = declaration_value
		var domain_id := _bounded_stable_id(declaration.get("stateDomainId"))
		var schema_id := _bounded_stable_id(declaration.get("schemaId"))
		var disposition := str(declaration.get("checkpointDisposition", ""))
		if domain_id.is_empty() or schema_id.is_empty() or declared.has(domain_id) or not disposition in ["captured", "reset", "externally_controlled", "unsupported", "uncontrolled"]:
			return null
		declared[domain_id] = true
		if disposition == "captured":
			if not captured.has(domain_id):
				domains.append({
					"schemaVersion": 1, "stateDomainId": domain_id, "disposition": "unsupported",
					"schemaId": null, "value": null,
					"limitations": ["The Adapter omitted a manifest-declared captured domain."],
				})
				continue
			var normalized := _canonical_value(captured.get(domain_id), 0, [0])
			if not normalized.get("ok", false):
				return null
			normalized_values[domain_id] = normalized.get("value")
			domains.append({
				"schemaVersion": 1, "stateDomainId": domain_id, "disposition": "captured",
				"schemaId": schema_id, "value": normalized.get("value"), "limitations": [],
			})
		else:
			domains.append({
				"schemaVersion": 1, "stateDomainId": domain_id, "disposition": disposition,
				"schemaId": schema_id, "value": null,
				"limitations": ["The manifest declares this state domain " + disposition + "."],
			})
	for captured_key in captured.keys():
		if not captured_key is String or not declared.has(captured_key):
			return null
	return domains


func _handle_snapshot_restore(request_id: String, payload: Dictionary) -> void:
	if not _has_exact_keys(payload, ["snapshotId", "requestedBarrier"]):
		_send_error(request_id, "INVALID_COMMAND", "Restore payload is invalid")
		return
	var module := _usable_optional_module("restore")
	if module == null or not module.has_method("restore"):
		_send_error(request_id, "CAPABILITY_UNSUPPORTED", "ProjectAdapter restore is unavailable")
		return
	var snapshot_id := _bounded_id(payload.get("snapshotId"))
	var requested := str(payload.get("requestedBarrier", ""))
	if snapshot_id.is_empty() or not _snapshots.has(snapshot_id):
		_send_error(request_id, "INVALID_COMMAND", "Snapshot is unavailable in this runtime")
		return
	var barrier_result := await _await_supported_barrier(requested)
	if not barrier_result.get("ok", false):
		_send_error(request_id, str(barrier_result.get("code")), str(barrier_result.get("message")))
		return
	var restore_result: Variant = module.call("restore", get_tree().current_scene, (_snapshots[snapshot_id] as Dictionary).duplicate(true))
	if not restore_result is Dictionary or not _has_exact_keys(restore_result, ["writtenDomains", "failedDomains", "knownSideEffects"]):
		_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter restore result is invalid")
		return
	var written := _bounded_stable_id_array(restore_result.get("writtenDomains", []), 128)
	var failed := _bounded_stable_id_array(restore_result.get("failedDomains", []), 128)
	var side_effects: Variant = restore_result.get("knownSideEffects", {})
	if written == null or failed == null or not side_effects is Dictionary:
		_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter restore domain report is invalid")
		return
	var written_set := {}
	var failed_set := {}
	for domain_id in written:
		written_set[domain_id] = true
	for domain_id in failed:
		if written_set.has(domain_id):
			_send_error(request_id, "ADAPTER_FAILURE", "A restore domain cannot be both written and failed")
			return
		failed_set[domain_id] = true
	var read_back := {}
	var snapshot_module := _usable_optional_module("snapshot")
	if snapshot_module != null and snapshot_module.has_method("capture"):
		var captured: Variant = snapshot_module.call("capture", get_tree().current_scene)
		if captured is Dictionary:
			for domain_id in captured.keys():
				var normalized := _canonical_value(captured.get(domain_id), 0, [0])
				if normalized.get("ok", false):
					read_back[domain_id] = normalized.get("value")
	var domains := _restore_domains(written_set, failed_set, side_effects, read_back)
	if domains == null:
		_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter restore domains are invalid")
		return
	_send("snapshot_restored", {
		"snapshotId": snapshot_id,
		"requestedBarrier": requested,
		"realizedBarrier": barrier_result.get("realizedBarrier"),
		"clock": _clock(),
		"quantizationDelayUs": barrier_result.get("quantizationDelayUs"),
		"domains": domains,
	}, request_id)


func _restore_domains(written: Dictionary, failed: Dictionary, side_effects: Dictionary, read_back: Dictionary) -> Variant:
	var declarations: Variant = _manifest.get("stateDomains")
	if not declarations is Array or declarations.is_empty() or declarations.size() > 128:
		return null
	var declared := {}
	var domains: Array = []
	for declaration_value in declarations:
		if not declaration_value is Dictionary:
			return null
		var declaration: Dictionary = declaration_value
		var domain_id := _bounded_stable_id(declaration.get("stateDomainId"))
		var disposition := str(declaration.get("checkpointDisposition", ""))
		if domain_id.is_empty() or declared.has(domain_id):
			return null
		declared[domain_id] = true
		var domain_side_effects := _bounded_string_array(side_effects.get(domain_id, []), 64)
		if domain_side_effects == null:
			return null
		if disposition == "captured":
			var status := "written" if written.has(domain_id) else ("failed" if failed.has(domain_id) else "missing")
			domains.append({
				"schemaVersion": 1, "stateDomainId": domain_id, "status": status,
				"reportedValue": read_back.get(domain_id), "knownSideEffects": domain_side_effects,
				"limitations": [] if status == "written" else ["The Adapter did not report this captured domain written."],
			})
		else:
			var status := "unsupported" if disposition == "unsupported" else "uncontrolled"
			domains.append({
				"schemaVersion": 1, "stateDomainId": domain_id, "status": status,
				"reportedValue": null, "knownSideEffects": domain_side_effects,
				"limitations": ["The manifest declares this state domain " + disposition + "."],
			})
	for domain_id in written.keys() + failed.keys():
		if not declared.has(domain_id):
			return null
	for domain_id in side_effects.keys():
		if not domain_id is String or not declared.has(domain_id):
			return null
	return domains


func _bounded_stable_id_array(value: Variant, maximum: int) -> Variant:
	if not value is Array or value.size() > maximum:
		return null
	var result: Array = []
	var seen := {}
	for item in value:
		var normalized := _bounded_stable_id(item)
		if normalized.is_empty() or seen.has(normalized):
			return null
		seen[normalized] = true
		result.append(normalized)
	return result


func _bounded_string_array(value: Variant, maximum: int) -> Variant:
	if not value is Array or value.size() > maximum:
		return null
	var result: Array = []
	for item in value:
		if not item is String or item.is_empty() or item.length() > 2048 or item.contains("\n") or item.contains("\r"):
			return null
		result.append(item)
	return result


func _handle_accept(request_id: String, payload: Dictionary) -> void:
	if _accepted or not _has_exact_keys(payload, ["adapterManifestSha256", "requiredModules", "observationWindowBatches"]):
		_send_error(request_id, "PROTOCOL_MISMATCH", "Unsupported Project Environment acceptance payload")
		return
	if str(payload.get("adapterManifestSha256", "")) != OS.get_environment("CHRONORIFT_ADAPTER_MANIFEST_HASH"):
		_send_error(request_id, "IDENTITY_MISMATCH", "ProjectAdapter manifest identity mismatch")
		return
	var required: Variant = payload.get("requiredModules")
	if not required is Array:
		_send_error(request_id, "PROTOCOL_MISMATCH", "Required module list is invalid")
		return
	for module_name in required:
		var state: Variant = _module_states.get(str(module_name))
		if not state is Dictionary or str(state.get("status", "")) != "implemented":
			_send_error(request_id, "CAPABILITY_UNSUPPORTED", "Required ProjectAdapter module is not implemented")
			return
	_accepted = true
	_window_batches = clampi(int(payload.get("observationWindowBatches", 1)), 1, 32)
	call_deferred("_complete_ready", request_id)


func _complete_ready(request_id: String) -> void:
	while get_tree().current_scene == null:
		await get_tree().process_frame
	if _instrumentation_mode == "instrumented":
		_last_sample_frame = Engine.get_process_frames()
		_sample_adapter()
		if _semantic_coverage() != "declared":
			_send_error(request_id, "ADAPTER_FAILURE", "ProjectAdapter readiness requires at least one state sample and declared semantic coverage for every observed state sample")
			_stopping = true
			get_tree().quit(2)
			return
	_runtime_ready = true
	_send("ready", _status(), request_id)


func _handle_query(request_id: String, payload: Dictionary) -> void:
	if not _has_exact_keys(payload, ["queryKind", "ids", "limit"]):
		_send_error(request_id, "INVALID_COMMAND", "Query payload is invalid")
		return
	var query_kind := str(payload.get("queryKind", ""))
	var ids: Variant = payload.get("ids")
	if not ids is Array or not ids.is_empty():
		_send_error(request_id, "CAPABILITY_UNSUPPORTED", "PE-A bridge queries require Host-side filtering")
		return
	var limit := clampi(int(payload.get("limit", 1)), 1, MAX_QUERY_ROWS)
	var rows: Array = []
	var matching_count := 0
	for record in _history:
		var include: bool = (
			(query_kind == "entities" and record.get("kind") == "entity_lifecycle")
			or (query_kind == "state" and record.get("kind") == "state_sample")
			or (query_kind == "events" and record.get("kind") == "adapter_event")
			or (query_kind == "errors" and record.get("kind") == "runtime_error")
		)
		if include:
			matching_count += 1
			if rows.size() < limit:
				rows.append(record.duplicate(true))
	_send("query_result", {
		"rows": rows,
		"truncated": matching_count > rows.size(),
		"coverage": _coverage(),
	}, request_id)


func _handle_capture(request_id: String, payload: Dictionary) -> void:
	if not _has_exact_keys(payload, ["channels", "rollingRecordLimit"]):
		_send_error(request_id, "INVALID_COMMAND", "Capture configuration is invalid")
		return
	var channels: Variant = payload.get("channels")
	if not channels is Array or channels.is_empty() or channels.size() > 64:
		_send_error(request_id, "INVALID_COMMAND", "Capture channels are invalid")
		return
	for channel in channels:
		if str(channel) not in INSTRUMENTED_CAPTURE_CHANNELS:
			_send_error(request_id, "CAPABILITY_UNSUPPORTED", "Capture channel is not implemented by the PE-A bridge")
			return
	_rolling_record_limit = clampi(int(payload.get("rollingRecordLimit", 1)), 1, MAX_PENDING_RECORDS)
	while _history.size() > _rolling_record_limit:
		_history.pop_front()
		_overwritten_records += 1
	_send("capture_configured", {
		"channels": (INSTRUMENTED_CAPTURE_CHANNELS if _instrumentation_mode == "instrumented" else BRIDGE_ONLY_CAPTURE_CHANNELS).duplicate(),
		"realizedRollingRecordLimit": _rolling_record_limit,
	}, request_id)


func _handle_barrier(request_id: String, payload: Dictionary) -> void:
	if not _has_exact_keys(payload, ["barrier"]):
		_send_error(request_id, "INVALID_COMMAND", "Barrier request is invalid")
		return
	var requested := str(payload.get("barrier", ""))
	if requested == "render_complete":
		_send_error(request_id, "CAPABILITY_UNSUPPORTED", "render_complete is unavailable in headless PE-A")
		return
	if requested == "physics_tick_end":
		_complete_physics_barrier(request_id, requested)
	elif requested == "process_frame_end":
		_complete_process_barrier(request_id, requested)
	else:
		_send_error(request_id, "INVALID_COMMAND", "Barrier kind is invalid")


func _complete_process_barrier(request_id: String, requested: String) -> void:
	var started := Time.get_ticks_usec()
	await get_tree().process_frame
	_send("barrier_reached", {
		"requestedBarrier": requested,
		"realizedBarrier": "process_frame_end",
		"clock": _clock(),
		"quantizationDelayUs": maxi(0, Time.get_ticks_usec() - started),
	}, request_id)


func _complete_physics_barrier(request_id: String, requested: String) -> void:
	var started := Time.get_ticks_usec()
	await get_tree().physics_frame
	_send("barrier_reached", {
		"requestedBarrier": requested,
		"realizedBarrier": "physics_tick_end",
		"clock": _clock(),
		"quantizationDelayUs": maxi(0, Time.get_ticks_usec() - started),
	}, request_id)


func _canonical_value(value: Variant, depth: int, budget: Array) -> Dictionary:
	budget[0] = int(budget[0]) + 1
	if int(budget[0]) > MAX_VALUE_NODES or depth > MAX_VALUE_DEPTH:
		return {"ok": false}
	if value == null or value is bool or value is String:
		return {"ok": true, "value": value}
	if value is int:
		if value < -9007199254740991 or value > 9007199254740991:
			return {"ok": false}
		return {"ok": true, "value": value}
	if value is float:
		if is_nan(value) or is_inf(value) or (value == 0.0 and str(value).begins_with("-")):
			return {"ok": false}
		return {"ok": true, "value": value}
	var tag := ""
	var numbers: Array = []
	if value is Vector2:
		tag = "vector2"; numbers = [value.x, value.y]
	elif value is Vector3:
		tag = "vector3"; numbers = [value.x, value.y, value.z]
	elif value is Vector4:
		tag = "vector4"; numbers = [value.x, value.y, value.z, value.w]
	elif value is Quaternion:
		tag = "quaternion"; numbers = [value.x, value.y, value.z, value.w]
	elif value is Color:
		tag = "color"; numbers = [value.r, value.g, value.b, value.a]
	elif value is Rect2:
		tag = "rect2"; numbers = [value.position.x, value.position.y, value.size.x, value.size.y]
	elif value is Basis:
		tag = "basis"; numbers = [value.x.x, value.x.y, value.x.z, value.y.x, value.y.y, value.y.z, value.z.x, value.z.y, value.z.z]
	elif value is Transform2D:
		tag = "transform2d"; numbers = [value.x.x, value.x.y, value.y.x, value.y.y, value.origin.x, value.origin.y]
	elif value is Transform3D:
		tag = "transform3d"; numbers = [value.basis.x.x, value.basis.x.y, value.basis.x.z, value.basis.y.x, value.basis.y.y, value.basis.y.z, value.basis.z.x, value.basis.z.y, value.basis.z.z, value.origin.x, value.origin.y, value.origin.z]
	if not tag.is_empty():
		for number in numbers:
			if is_nan(float(number)) or is_inf(float(number)):
				return {"ok": false}
		return {"ok": true, "value": {"$type": tag, "values": numbers}}
	if value is Array:
		if value.size() > 256:
			return {"ok": false}
		var output: Array = []
		for child in value:
			var normalized := _canonical_value(child, depth + 1, budget)
			if not normalized.get("ok", false):
				return {"ok": false}
			output.append(normalized.get("value"))
		return {"ok": true, "value": output}
	if value is Dictionary:
		if value.size() > 256:
			return {"ok": false}
		var output := {}
		for key_value in value.keys():
			if not key_value is String or key_value.is_empty() or key_value.length() > 256:
				return {"ok": false}
			var normalized := _canonical_value(value[key_value], depth + 1, budget)
			if not normalized.get("ok", false):
				return {"ok": false}
			output[key_value] = normalized.get("value")
		return {"ok": true, "value": output}
	return {"ok": false}


func _valid_resource_reference(value: String) -> bool:
	return value.begins_with("res://") and not value.contains("\\") and not value.contains("..") and value.length() <= 1024


func _valid_package_path(value: String) -> bool:
	return not value.is_empty() and not value.begins_with("/") and not value.contains("\\") and not value.contains("..") and not value.contains("//") and value.length() <= 512


func _bounded_id(value: Variant) -> String:
	if not value is String:
		return ""
	var text := str(value)
	if text.is_empty() or text.length() > 256 or text.contains(".."):
		return ""
	return text


func _bounded_stable_id(value: Variant) -> String:
	var text := _bounded_id(value)
	if text.is_empty():
		return ""
	var first := text.unicode_at(0)
	if first < 97 or first > 122:
		return ""
	for index in text.length():
		var code := text.unicode_at(index)
		var allowed := (code >= 97 and code <= 122) or (code >= 48 and code <= 57) or code in [46, 58, 95, 45]
		if not allowed:
			return ""
	return text


func _bounded_message(value: String) -> String:
	return value.replace("\r", " ").replace("\n", " ").replace(String.chr(0), " ").left(2048)


func _request_id(message: Dictionary) -> String:
	var value: Variant = message.get("requestId", "")
	return str(value) if value is String else ""


func _has_exact_keys(value: Variant, expected_keys: Array) -> bool:
	if not value is Dictionary:
		return false
	var actual: Array = value.keys()
	actual.sort()
	var expected := expected_keys.duplicate()
	expected.sort()
	return actual == expected


func _read_available_frames() -> void:
	var available := _peer.get_available_bytes()
	if available <= 0:
		return
	var result := _peer.get_data(available)
	if result[0] != OK:
		return
	_receive_buffer.append_array(result[1])
	while _receive_buffer.size() >= 4:
		var length := (int(_receive_buffer[0]) << 24) | (int(_receive_buffer[1]) << 16) | (int(_receive_buffer[2]) << 8) | int(_receive_buffer[3])
		if length <= 0 or length > MAX_FRAME_BYTES:
			push_error("ChronoRift Project Environment received an invalid frame length")
			get_tree().quit(2)
			return
		if _receive_buffer.size() < length + 4:
			return
		var body := _receive_buffer.slice(4, 4 + length)
		_receive_buffer = _receive_buffer.slice(4 + length)
		var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
		if not parsed is Dictionary:
			_send_error("", "INVALID_COMMAND", "Project Environment frame is not a JSON object")
			continue
		_handle_message(parsed)


func _send(kind: String, payload: Dictionary, request_id := "") -> void:
	var message := {
		"schemaVersion": SCHEMA_VERSION,
		"protocolProfile": PROTOCOL_PROFILE,
		"protocolVersion": PROTOCOL_VERSION,
		"sequence": _outgoing_sequence,
		"kind": kind,
		"payload": payload,
		"payloadHash": payload_hash(payload),
	}
	if not request_id.is_empty():
		message["requestId"] = request_id
	_outgoing_sequence += 1
	var body := JSON.stringify(message).to_utf8_buffer()
	if body.size() <= 0 or body.size() > MAX_FRAME_BYTES:
		push_error("ChronoRift Project Environment attempted an invalid frame")
		get_tree().quit(2)
		return
	var frame := PackedByteArray()
	frame.resize(body.size() + 4)
	frame[0] = (body.size() >> 24) & 0xff
	frame[1] = (body.size() >> 16) & 0xff
	frame[2] = (body.size() >> 8) & 0xff
	frame[3] = body.size() & 0xff
	for index in body.size():
		frame[index + 4] = body[index]
	_peer.put_data(frame)


func _send_error(request_id: String, code: String, message: String) -> void:
	_send("error", {"code": code, "message": _bounded_message(message)}, request_id)


func payload_hash(value: Variant) -> String:
	return _canonical_json(value).sha256_text()


func _canonical_json(value: Variant) -> String:
	if value == null:
		return "null"
	if value is bool:
		return "true" if value else "false"
	if value is int:
		return str(value)
	if value is float:
		if value == round(value):
			return str(int(value))
		return JSON.stringify(value)
	if value is String:
		return JSON.stringify(value)
	if value is Array:
		var array_parts: Array[String] = []
		for entry in value:
			array_parts.append(_canonical_json(entry))
		return "[" + ",".join(array_parts) + "]"
	if value is Dictionary:
		var keys: Array = value.keys()
		keys.sort()
		var dictionary_parts: Array[String] = []
		for key in keys:
			dictionary_parts.append(JSON.stringify(str(key)) + ":" + _canonical_json(value[key]))
		return "{" + ",".join(dictionary_parts) + "}"
	return JSON.stringify(str(value))
`;

export const PROJECT_ENVIRONMENT_BRIDGE_FILES_V1: readonly ProjectEnvironmentRuntimeAssetFileV1[] =
  Object.freeze([
    Object.freeze({
      relativePath: "bridge.gd",
      bytes: utf8(GODOT_PROJECT_ENVIRONMENT_BRIDGE_SOURCE_V1),
    }),
  ]);

/**
 * The SDK deliberately exposes separate module objects. It contains no
 * project semantics and gives adapter code no Host or transport handle.
 */
export const PROJECT_ADAPTER_SDK_FILES_V1: readonly ProjectEnvironmentRuntimeAssetFileV1[] =
  Object.freeze([
    Object.freeze({
      relativePath: "sdk/project_adapter_v1.gd",
      bytes: utf8(`extends RefCounted
class_name ChronoRiftProjectAdapterV1

const SDK_VERSION := 1

func create_modules() -> Dictionary:
\treturn {}
`),
    }),
    Object.freeze({
      relativePath: "sdk/entity_projection_v1.gd",
      bytes: utf8(`extends RefCounted
class_name ChronoRiftEntityProjectionV1

const MODULE_VERSION := 1

func sample(_current_scene: Node) -> Array:
\treturn []
`),
    }),
    Object.freeze({
      relativePath: "sdk/state_projection_v1.gd",
      bytes: utf8(`extends RefCounted
class_name ChronoRiftStateProjectionV1

const MODULE_VERSION := 1

func sample(_current_scene: Node) -> Array:
\treturn []
`),
    }),
    Object.freeze({
      relativePath: "sdk/event_projection_v1.gd",
      bytes: utf8(`extends RefCounted
class_name ChronoRiftEventProjectionV1

const MODULE_VERSION := 1

func drain(_current_scene: Node) -> Array:
\treturn []
`),
    }),
    Object.freeze({
      relativePath: "sdk/input_control_v1.gd",
      bytes: utf8(`extends RefCounted
class_name ChronoRiftInputControlV1

const MODULE_VERSION := 1

func apply(_current_scene: Node, _request: Dictionary) -> Dictionary:
\treturn {"status": "unsupported"}
`),
    }),
    Object.freeze({
      relativePath: "sdk/snapshot_v1.gd",
      bytes: utf8(`extends RefCounted
class_name ChronoRiftSnapshotV1

const MODULE_VERSION := 1

func capture(_current_scene: Node) -> Dictionary:
\treturn {}
`),
    }),
    Object.freeze({
      relativePath: "sdk/restore_v1.gd",
      bytes: utf8(`extends RefCounted
class_name ChronoRiftRestoreV1

const MODULE_VERSION := 1

func restore(_current_scene: Node, _snapshot: Dictionary) -> Dictionary:
\treturn {"writtenDomains": [], "failedDomains": [], "knownSideEffects": {}}
`),
    }),
  ]);
