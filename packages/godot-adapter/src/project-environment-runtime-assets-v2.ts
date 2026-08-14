import type { ProjectEnvironmentRuntimeAssetFileV1 } from "./project-environment-runtime-assets.js";

const utf8 = (value: string): Uint8Array => Buffer.from(value, "utf8");

export const PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V2 =
  "chronorift-managed-godot-project-environment-v2" as const;

export const GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V2 =
  '[autoload]\n\nChronoRiftProjectEnvironment="*res://addons/chronorift_project_environment/bridge_v2.gd"\n';

export const GODOT_PROJECT_ENVIRONMENT_BRIDGE_SOURCE_V2 = String.raw`extends Node

const SCHEMA_VERSION := 2
const PROTOCOL_PROFILE := "chronorift-godot-project-environment-v2"
const PROTOCOL_VERSION := 2
const ADAPTER_ROOT := "res://.chronorift/project-adapter"
const MANIFEST_PATH := ADAPTER_ROOT + "/manifest.json"
const MAX_FRAME_BYTES := 1024 * 1024
const MAX_BATCH_RECORDS := 128
const MAX_PENDING_RECORDS := 4096
const GENERIC_MODULES := ["lifecycle", "clock", "runtime_error", "capture"]
const CAPTURE_CHANNELS := ["entity", "state", "event", "runtime_error", "clock", "capture_loss"]
const ADAPTER_BASE := preload("res://addons/chronorift_project_environment/sdk/project_adapter_v2.gd")
const CONTEXT := preload("res://addons/chronorift_project_environment/sdk/observation_context_v2.gd")

var _peer := StreamPeerTCP.new()
var _receive_buffer := PackedByteArray()
var _outgoing_sequence := 0
var _expected_incoming_sequence := 0
var _next_record_sequence := 0
var _connected := false
var _accepted := false
var _runtime_ready := false
var _stopping := false
var _adapter_started := false
var _process_time_us := 0
var _physics_time_us := 0
var _window_batches := 0
var _rolling_record_limit := 4096
var _pending_records: Array[Dictionary] = []
var _history: Array[Dictionary] = []
var _overwritten_records := 0
var _total_dropped_records := 0
var _manifest: Dictionary = {}
var _module_states: Dictionary = {}
var _instrumentation_mode := ""
var _configured_main_scene := ""
var _adapter: Variant = null
var _context: Variant = null
var _adapter_failure := ""
var _semantic_coverage := "unknown"


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_priority = -1000
	_instrumentation_mode = OS.get_environment("CHRONORIFT_INSTRUMENTATION_MODE")
	_configured_main_scene = OS.get_environment("CHRONORIFT_EXPECTED_MAIN_SCENE")
	if _instrumentation_mode != "bridge_only" and _instrumentation_mode != "instrumented":
		_fatal("ChronoRift V2 instrumentation mode is invalid")
		return
	if _instrumentation_mode == "instrumented" and not _load_adapter():
		_fatal(_adapter_failure)
		return
	if _instrumentation_mode == "bridge_only":
		_module_states = _bridge_only_module_states()
	var host := OS.get_environment("CHRONORIFT_HOST")
	var port := int(OS.get_environment("CHRONORIFT_PORT"))
	if host.is_empty() or port <= 0:
		_fatal("ChronoRift V2 requires a managed Host endpoint")
		return
	if _peer.connect_to_host(host, port) != OK:
		_fatal("ChronoRift V2 could not connect to the managed Host endpoint")


func _process(delta: float) -> void:
	_process_time_us += maxi(0, int(round(delta * 1000000.0)))
	_peer.poll()
	if not _connected and _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_connected = true
		_send("hello", {"token": OS.get_environment("CHRONORIFT_TOKEN"), "fingerprint": _fingerprint()})
	if not _connected:
		return
	_read_available_frames()
	if _runtime_ready and _instrumentation_mode == "instrumented" and not _adapter_started:
		_start_adapter_if_scene_ready()
	_flush_observations()


func _physics_process(delta: float) -> void:
	_physics_time_us += maxi(0, int(round(delta * 1000000.0)))


func _load_adapter() -> bool:
	if FileAccess.get_sha256(MANIFEST_PATH) != OS.get_environment("CHRONORIFT_ADAPTER_MANIFEST_HASH"):
		_adapter_failure = "ProjectAdapter V2 manifest identity differs from the managed binding"
		return false
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(MANIFEST_PATH))
	if not parsed is Dictionary or int(parsed.get("schemaVersion", -1)) != 2 or int(parsed.get("sdk", {}).get("version", -1)) != 2:
		_adapter_failure = "ProjectAdapter V2 manifest profile is unsupported"
		return false
	_manifest = parsed
	var entry := str(_manifest.get("entryScript", ""))
	if not _valid_package_path(entry) or not entry.begins_with("src/") or not entry.ends_with(".gd"):
		_adapter_failure = "ProjectAdapter V2 entry path is invalid"
		return false
	var script: Variant = load(ADAPTER_ROOT + "/" + entry)
	if not script is Script:
		_adapter_failure = "ProjectAdapter V2 entry did not load"
		return false
	_adapter = script.new()
	if _adapter == null or not _script_inherits(_adapter, ADAPTER_BASE) or not _adapter.has_method("start"):
		_adapter_failure = "ProjectAdapter V2 entry must inherit the managed SDK base"
		return false
	var capability_set: Variant = _manifest.get("modules")
	if not capability_set is Dictionary or not capability_set.get("modules") is Array:
		_adapter_failure = "ProjectAdapter V2 capability set is invalid"
		return false
	for declaration_value in capability_set.get("modules", []):
		if not declaration_value is Dictionary:
			_adapter_failure = "ProjectAdapter V2 module declaration is invalid"
			return false
		var name := str(declaration_value.get("module", ""))
		if name.is_empty() or _module_states.has(name):
			_adapter_failure = "ProjectAdapter V2 module identities are invalid"
			return false
		_module_states[name] = declaration_value.duplicate(true)
	return true


func _script_inherits(instance: Variant, expected_base: Script) -> bool:
	var script: Script = instance.get_script() as Script
	while script != null:
		if script == expected_base:
			return true
		script = script.get_base_script()
	return false


func _start_adapter_if_scene_ready() -> void:
	var scene := get_tree().current_scene
	if scene == null:
		return
	_context = CONTEXT.new()
	_context.configure(OS.get_environment("CHRONORIFT_EXECUTION_ID"), Callable(self, "_receive_adapter_observation"))
	var result: Variant = _adapter.call("start", _context, scene)
	if result != OK:
		_runtime_error("ADAPTER_START_FAILED", "ProjectAdapter V2 start did not return OK")
		return
	_adapter_started = true


func _receive_adapter_observation(kind: String, payload: Dictionary) -> void:
	if not kind in ["entity_lifecycle", "state_sample", "adapter_event"]:
		_runtime_error("ADAPTER_OBSERVATION_INVALID", "ProjectAdapter V2 emitted an unknown observation kind")
		return
	var canonical := _canonical_value(payload, 0, [0])
	if not canonical.get("ok", false):
		_runtime_error("ADAPTER_OBSERVATION_INVALID", "ProjectAdapter V2 emitted a non-canonical observation")
		return
	if kind == "state_sample":
		var coverage := str(payload.get("semanticCoverage", "unknown"))
		if coverage == "unknown" or _semantic_coverage == "unknown":
			_semantic_coverage = coverage
		elif coverage == "partial" or _semantic_coverage == "partial":
			_semantic_coverage = "partial"
		else:
			_semantic_coverage = "declared"
	_append_record(kind, canonical.get("value"))


func _bridge_only_module_states() -> Dictionary:
	var states := {}
	for module_name in ["lifecycle", "clock", "runtime_error", "entity_projection", "state_projection", "event_projection", "capture", "input_control", "snapshot", "restore", "render_capture", "alignment"]:
		var implemented: bool = module_name in GENERIC_MODULES
		states[module_name] = {"schemaVersion": 1, "module": module_name, "status": "implemented" if implemented else "unsupported", "protocolVersion": "project-environment-bridge:v2" if implemented else null, "limitations": [] if implemented else ["bridge-only mode does not load project semantics"]}
	return states


func _module_set() -> Dictionary:
	var names: Array = _module_states.keys()
	names.sort()
	var values: Array = []
	for name in names:
		values.append((_module_states[name] as Dictionary).duplicate(true))
	return {"schemaVersion": 1, "modules": values}


func _identity() -> Dictionary:
	return {
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
		"observationProtocolVersion": 2,
		"adapterSdkVersion": 2,
	}


func _fingerprint() -> Dictionary:
	var version := Engine.get_version_info()
	return {"schemaVersion": 2, "protocolProfile": PROTOCOL_PROFILE, "protocolVersion": PROTOCOL_VERSION, "engine": "godot", "engineVersion": str(version.get("string", "unknown")), "engineBuildHash": str(version.get("hash", "")), "platform": OS.get_name(), "renderer": "headless", "displayServer": "headless", "audioDriver": AudioServer.get_driver_name(), "physicsTicksPerSecond": Engine.physics_ticks_per_second, "configuredMainScene": _configured_main_scene, "modules": _module_set(), "identity": _identity()}


func _clock() -> Dictionary:
	return {"processFrame": Engine.get_process_frames(), "physicsTick": Engine.get_physics_frames(), "simulationTimeUs": _process_time_us, "renderFrame": null}


func _coverage() -> Dictionary:
	var first: Variant = null
	var last: Variant = null
	if not _history.is_empty():
		first = int(_history[0].get("recordSequence", 0))
		last = int(_history[-1].get("recordSequence", 0))
	return {"status": "partial" if _overwritten_records > 0 or _total_dropped_records > 0 else "complete", "firstAvailableRecordSequence": first, "lastAvailableRecordSequence": last, "droppedRecordCount": _total_dropped_records, "overwriteCount": _overwritten_records, "semanticCoverage": _semantic_coverage if _instrumentation_mode == "instrumented" else "unknown"}


func _status() -> Dictionary:
	return {"running": not _stopping, "configuredMainScene": _configured_main_scene, "currentScene": _configured_main_scene if get_tree().current_scene != null else null, "clock": _clock(), "nextObservationRecordSequence": _next_record_sequence, "coverage": _coverage()}


func _append_record(kind: String, payload: Dictionary) -> void:
	var sequence := _next_record_sequence
	_next_record_sequence += 1
	if _pending_records.size() >= MAX_PENDING_RECORDS:
		_total_dropped_records += 1
		return
	var record := {"schemaVersion": 2, "executionId": OS.get_environment("CHRONORIFT_EXECUTION_ID"), "recordSequence": sequence, "clock": _clock(), "kind": kind, "payload": payload}
	_pending_records.append(record)
	_history.append(record.duplicate(true))
	while _history.size() > _rolling_record_limit:
		_history.pop_front()
		_overwritten_records += 1


func _flush_observations() -> void:
	while _window_batches > 0 and not _pending_records.is_empty():
		var count := mini(MAX_BATCH_RECORDS, _pending_records.size())
		var records: Array[Dictionary] = []
		for index in count:
			records.append(_pending_records.pop_front())
		var first := int(records[0].get("recordSequence", 0))
		var last := int(records[-1].get("recordSequence", 0))
		_send("observation_batch", {"schemaVersion": 2, "executionId": OS.get_environment("CHRONORIFT_EXECUTION_ID"), "batchId": "batch.v2.%d" % first, "firstRecordSequence": first, "lastRecordSequence": last, "records": records, "coverage": _coverage()})
		_window_batches -= 1


func _handle_message(message: Dictionary) -> void:
	var kind := str(message.get("kind", ""))
	var request_id := str(message.get("requestId", ""))
	if int(message.get("schemaVersion", -1)) != 2 or str(message.get("protocolProfile", "")) != PROTOCOL_PROFILE or int(message.get("protocolVersion", -1)) != 2 or int(message.get("sequence", -1)) != _expected_incoming_sequence:
		_send_error(request_id, "PROTOCOL_MISMATCH", "Unsupported Project Environment V2 envelope")
		return
	_expected_incoming_sequence += 1
	var payload: Variant = message.get("payload")
	if not payload is Dictionary or payload_hash(payload) != str(message.get("payloadHash", "")):
		_send_error(request_id, "INVALID_COMMAND", "V2 payload hash mismatch")
		return
	match kind:
		"hello_accept":
			if str(payload.get("adapterManifestSha256", "")) != OS.get_environment("CHRONORIFT_ADAPTER_MANIFEST_HASH"):
				_send_error(request_id, "IDENTITY_MISMATCH", "Adapter manifest identity mismatch")
			else:
				_window_batches = clampi(int(payload.get("observationWindowBatches", 4)), 1, 32)
				_accepted = true
				_runtime_ready = true
				_send("ready", _status(), request_id)
		"observation_ack":
			_window_batches = clampi(int(payload.get("nextWindowBatches", 4)), 1, 32)
		"status":
			_send("status_result", _status(), request_id)
		"capture_configure":
			var channels: Variant = payload.get("channels")
			var limit := int(payload.get("rollingRecordLimit", 0))
			if not channels is Array or limit < 1 or limit > 65536:
				_send_error(request_id, "INVALID_COMMAND", "V2 capture configuration is invalid")
			else:
				_rolling_record_limit = limit
				_send("capture_configured", {"channels": CAPTURE_CHANNELS, "realizedRollingRecordLimit": _rolling_record_limit}, request_id)
		"shutdown":
			_stopping = true
			if _adapter != null and _adapter.has_method("stop"):
				_adapter.call("stop")
			_send("shutdown_ack", {"status": _status()}, request_id)
			_peer.poll()
			get_tree().quit()
		_:
			_send_error(request_id, "CAPABILITY_UNSUPPORTED", "Command is not implemented by the V2 runtime")


func _read_available_frames() -> void:
	while _peer.get_available_bytes() > 0:
		var received := _peer.get_partial_data(_peer.get_available_bytes())
		if received[0] != OK:
			_fatal("V2 transport read failed")
			return
		_receive_buffer.append_array(received[1])
	while _receive_buffer.size() >= 4:
		var length := (_receive_buffer[0] << 24) | (_receive_buffer[1] << 16) | (_receive_buffer[2] << 8) | _receive_buffer[3]
		if length <= 0 or length > MAX_FRAME_BYTES:
			_fatal("V2 frame length is invalid")
			return
		if _receive_buffer.size() < length + 4:
			return
		var body := _receive_buffer.slice(4, length + 4)
		_receive_buffer = _receive_buffer.slice(length + 4)
		var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
		if not parsed is Dictionary:
			_fatal("V2 frame is not a JSON object")
			return
		_handle_message(parsed)


func _send(kind: String, payload: Dictionary, request_id: Variant = null) -> void:
	var message := {"schemaVersion": 2, "protocolProfile": PROTOCOL_PROFILE, "protocolVersion": PROTOCOL_VERSION, "sequence": _outgoing_sequence, "kind": kind, "payloadHash": payload_hash(payload), "payload": payload}
	if request_id != null and not str(request_id).is_empty():
		message["requestId"] = str(request_id)
	_outgoing_sequence += 1
	var body := JSON.stringify(message).to_utf8_buffer()
	var frame := PackedByteArray([body.size() >> 24 & 255, body.size() >> 16 & 255, body.size() >> 8 & 255, body.size() & 255])
	frame.append_array(body)
	_peer.put_data(frame)


func _send_error(request_id: String, code: String, message: String) -> void:
	_send("error", {"code": code, "message": message}, request_id)


func _runtime_error(code: String, message: String) -> void:
	_append_record("runtime_error", {"channel": "bridge", "severity": "error", "code": code.to_lower(), "message": message.left(2048)})


func _fatal(message: String) -> void:
	push_error(message)
	get_tree().quit(2)


func _valid_package_path(value: String) -> bool:
	return not value.is_empty() and not value.begins_with("/") and not "\\" in value and not ".." in value


func _canonical_value(value: Variant, depth: int, count: Array) -> Dictionary:
	count[0] += 1
	if depth > 16 or count[0] > 4096:
		return {"ok": false}
	if value == null or value is bool or value is String:
		return {"ok": true, "value": value}
	if value is int:
		return {"ok": true, "value": value}
	if value is float:
		if is_nan(value) or is_inf(value):
			return {"ok": false}
		return {"ok": true, "value": value}
	if value is Array:
		if value.size() > 512:
			return {"ok": false}
		var result: Array = []
		for child in value:
			var parsed := _canonical_value(child, depth + 1, count)
			if not parsed.get("ok", false):
				return {"ok": false}
			result.append(parsed.get("value"))
		return {"ok": true, "value": result}
	if value is Dictionary:
		if value.size() > 256:
			return {"ok": false}
		var result := {}
		var keys: Array = value.keys()
		keys.sort()
		for key_value in keys:
			var key := str(key_value)
			if key.is_empty() or key.length() > 128:
				return {"ok": false}
			var parsed := _canonical_value(value[key_value], depth + 1, count)
			if not parsed.get("ok", false):
				return {"ok": false}
			result[key] = parsed.get("value")
		return {"ok": true, "value": result}
	return {"ok": false}


func payload_hash(payload: Variant) -> String:
	return _canonical_json(payload).sha256_text()


func _canonical_json(value: Variant) -> String:
	if value == null:
		return "null"
	if value is bool:
		return "true" if value else "false"
	if value is int:
		return str(value)
	if value is float:
		return str(int(value)) if value == round(value) else JSON.stringify(value)
	if value is String:
		return JSON.stringify(value)
	if value is Array:
		var parts: Array[String] = []
		for child in value:
			parts.append(_canonical_json(child))
		return "[" + ",".join(parts) + "]"
	if value is Dictionary:
		var keys: Array = value.keys()
		keys.sort()
		var parts: Array[String] = []
		for key in keys:
			parts.append(JSON.stringify(str(key)) + ":" + _canonical_json(value[key]))
		return "{" + ",".join(parts) + "}"
	return "null"
`;

export const PROJECT_ENVIRONMENT_BRIDGE_FILES_V2: readonly ProjectEnvironmentRuntimeAssetFileV1[] =
  Object.freeze([
    Object.freeze({
      relativePath: "bridge_v2.gd",
      bytes: utf8(GODOT_PROJECT_ENVIRONMENT_BRIDGE_SOURCE_V2),
    }),
  ]);

export const PROJECT_ADAPTER_SDK_FILES_V2: readonly ProjectEnvironmentRuntimeAssetFileV1[] =
  Object.freeze([
    Object.freeze({
      relativePath: "sdk/project_adapter_v2.gd",
      bytes: utf8(`extends RefCounted
class_name ChronoRiftProjectAdapterV2

const SDK_VERSION := 2

func start(_context: ChronoRiftObservationContextV2, _current_scene: Node) -> Error:
\treturn ERR_UNAVAILABLE

func stop() -> void:
\tpass
`),
    }),
    Object.freeze({
      relativePath: "sdk/observation_context_v2.gd",
      bytes: utf8(`extends RefCounted
class_name ChronoRiftObservationContextV2

const SDK_VERSION := 2

var _execution_id := ""
var _emit := Callable()
var _active := {}
var _last_incarnation := {}
var _node_bindings := {}

func configure(execution_id: String, emit: Callable) -> void:
\t_execution_id = execution_id
\t_emit = emit

func register_entity(entity_id: String, entity_type_id: String, identity_scope: String, node: Node, projection: Dictionary) -> Dictionary:
\tif _active.has(entity_id) or not is_instance_valid(node):
\t\treturn {}
\tvar incarnation := int(_last_incarnation.get(entity_id, 0)) + 1
\t_last_incarnation[entity_id] = incarnation
\tvar reference := {"schemaVersion": 2, "executionId": _execution_id, "entityId": entity_id, "incarnation": incarnation}
\t_active[entity_id] = {"reference": reference, "entityTypeId": entity_type_id, "identityScope": identity_scope, "node": node}
\t_node_bindings[node.get_instance_id()] = {"entityId": entity_id, "incarnation": incarnation}
\tnode.tree_exiting.connect(_node_exiting.bind(entity_id, incarnation), CONNECT_ONE_SHOT)
\t_emit.call("entity_lifecycle", {"phase": "appeared", "entity": reference, "entityTypeId": entity_type_id, "identityScope": identity_scope, "projection": projection})
\treturn reference.duplicate(true)

func update_entity(reference: Dictionary, projection: Dictionary) -> bool:
\tvar active: Variant = _active.get(str(reference.get("entityId", "")))
\tif not active is Dictionary or int(active.reference.incarnation) != int(reference.get("incarnation", -1)):
\t\treturn false
\t_emit.call("entity_lifecycle", {"phase": "updated", "entity": active.reference.duplicate(true), "entityTypeId": active.entityTypeId, "identityScope": active.identityScope, "projection": projection})
\treturn true

func unregister_entity(reference: Dictionary) -> bool:
\treturn _close(str(reference.get("entityId", "")), int(reference.get("incarnation", -1)))

func emit_state(state_domain_id: String, subject_entity: Variant, value: Dictionary, semantic_coverage := "declared") -> void:
\t_emit.call("state_sample", {"stateDomainId": state_domain_id, "subjectEntity": subject_entity, "value": value, "semanticCoverage": semantic_coverage})

func emit_event(event_type_id: String, source_entity: Variant, value: Dictionary) -> void:
\t_emit.call("adapter_event", {"eventTypeId": event_type_id, "sourceEntity": source_entity, "value": value})

func _node_exiting(entity_id: String, incarnation: int) -> void:
\t_close(entity_id, incarnation)

func _close(entity_id: String, incarnation: int) -> bool:
\tvar active: Variant = _active.get(entity_id)
\tif not active is Dictionary or int(active.reference.incarnation) != incarnation:
\t\treturn false
\t_emit.call("entity_lifecycle", {"phase": "disappeared", "entity": active.reference.duplicate(true), "entityTypeId": active.entityTypeId, "identityScope": active.identityScope, "projection": null})
\t_active.erase(entity_id)
\treturn true
`),
    }),
  ]);
