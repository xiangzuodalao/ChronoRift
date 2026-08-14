extends Node

const SCHEMA_VERSION := 1
const PROTOCOL_PROFILE := "chronorift-godot-lifecycle-v1"
const PROTOCOL_VERSION := 1
const ADAPTER_VERSION := "0.4.0"
const MINIMUM_PROCESS_FRAME_DELTA := 120
const MINIMUM_PHYSICS_TICK_DELTA := 120
const MAX_FRAME_BYTES := 1024 * 1024
const CAPABILITIES := [
	"lifecycle.status",
	"lifecycle.shutdown",
	"clock.process_frame",
	"clock.physics_tick",
	"scene.identity",
]

var _peer := StreamPeerTCP.new()
var _receive_buffer := PackedByteArray()
var _outgoing_sequence := 0
var _expected_incoming_sequence := 0
var _connected := false
var _accepted := false
var _runtime_ready := false
var _ready_request_id := ""
var _ready_baseline: Dictionary = {}
var _process_time_us := 0
var _physics_time_us := 0
var _configured_main_scene := ""
var _fingerprint: Dictionary = {}


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_priority = -1000
	_configured_main_scene = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	_fingerprint = _build_fingerprint()
	var host := OS.get_environment("CHRONORIFT_HOST")
	var port := int(OS.get_environment("CHRONORIFT_PORT"))
	if host.is_empty() or port <= 0:
		push_error("ChronoRiftLifecycle requires a managed Host endpoint")
		return
	var connection_status := _peer.connect_to_host(host, port)
	if connection_status != OK:
		push_error("ChronoRiftLifecycle could not connect to the managed Host endpoint")


func _process(delta: float) -> void:
	_process_time_us += maxi(0, int(round(delta * 1000000.0)))
	_peer.poll()
	if not _connected and _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_connected = true
		_send("hello", {
			"token": OS.get_environment("CHRONORIFT_TOKEN"),
			"fingerprint": _fingerprint,
		})
	if not _connected:
		return
	_read_available_frames()
	_maybe_send_ready()


func _physics_process(delta: float) -> void:
	_physics_time_us += maxi(0, int(round(delta * 1000000.0)))


func _build_fingerprint() -> Dictionary:
	var version_info := Engine.get_version_info()
	return {
		"schemaVersion": SCHEMA_VERSION,
		"protocolProfile": PROTOCOL_PROFILE,
		"protocolVersion": PROTOCOL_VERSION,
		"engine": "godot",
		"engineVersion": str(version_info.get("string", "unknown")),
		"engineBuildHash": str(version_info.get("hash", "")),
		"adapterVersion": ADAPTER_VERSION,
		"platform": OS.get_name(),
		"renderer": RenderingServer.get_current_rendering_method(),
		"displayServer": DisplayServer.get_name(),
		"audioDriver": AudioServer.get_driver_name(),
		"physicsTicksPerSecond": Engine.physics_ticks_per_second,
		"configuredMainScene": _configured_main_scene,
		"capabilities": CAPABILITIES,
		"identity": {
			"taskId": OS.get_environment("CHRONORIFT_TASK_ID"),
			"buildId": OS.get_environment("CHRONORIFT_BUILD_ID"),
			"runtimeId": OS.get_environment("CHRONORIFT_RUNTIME_ID"),
			"executionId": OS.get_environment("CHRONORIFT_EXECUTION_ID"),
			"managedRuntimeId": OS.get_environment("CHRONORIFT_MANAGED_RUNTIME_ID"),
			"candidateSourceHash": OS.get_environment("CHRONORIFT_CANDIDATE_SOURCE_HASH"),
			"overlayHash": OS.get_environment("CHRONORIFT_OVERLAY_HASH"),
			"addonHash": OS.get_environment("CHRONORIFT_ADDON_HASH"),
		},
	}


func _status_sample() -> Dictionary:
	return {
		"processFrames": Engine.get_process_frames(),
		"physicsFrames": Engine.get_physics_frames(),
		"processTimeUs": _process_time_us,
		"physicsTimeUs": _physics_time_us,
		"configuredMainScene": _configured_main_scene,
		"currentScene": _current_scene_reference(),
	}


func _current_scene_reference() -> Variant:
	var scene := get_tree().current_scene
	if scene == null:
		return null
	var scene_path := str(scene.scene_file_path)
	return null if scene_path.is_empty() else scene_path


func _maybe_send_ready() -> void:
	if not _accepted or _runtime_ready or _ready_baseline.is_empty():
		return
	var observed := _status_sample()
	if observed.get("currentScene") == null:
		return
	if int(observed.get("processFrames", 0)) - int(_ready_baseline.get("processFrames", 0)) < MINIMUM_PROCESS_FRAME_DELTA:
		return
	if int(observed.get("physicsFrames", 0)) - int(_ready_baseline.get("physicsFrames", 0)) < MINIMUM_PHYSICS_TICK_DELTA:
		return
	_runtime_ready = true
	_send("ready", {"baseline": _ready_baseline, "observed": observed}, _ready_request_id)


func _handle_message(message: Dictionary) -> void:
	if not _has_exact_keys(message, [
		"schemaVersion", "protocolProfile", "protocolVersion", "sequence",
		"requestId", "payloadHash", "kind", "payload",
	]):
		_send_error(_request_id(message), "PROFILE_MISMATCH", "Unsupported lifecycle envelope")
		return
	if (
		int(message.get("schemaVersion", -1)) != SCHEMA_VERSION
		or str(message.get("protocolProfile", "")) != PROTOCOL_PROFILE
		or int(message.get("protocolVersion", -1)) != PROTOCOL_VERSION
	):
		_send_error(_request_id(message), "PROFILE_MISMATCH", "Unsupported lifecycle profile or version")
		return
	if int(message.get("sequence", -1)) != _expected_incoming_sequence:
		_send_error(_request_id(message), "INVALID_COMMAND", "Unexpected lifecycle message sequence")
		return
	_expected_incoming_sequence += 1
	var request_id := _request_id(message)
	if request_id.is_empty():
		_send_error("", "INVALID_COMMAND", "Lifecycle command requires a request identity")
		return
	var payload: Variant = message.get("payload")
	if not payload is Dictionary or payload_hash(payload) != str(message.get("payloadHash", "")):
		_send_error(request_id, "INVALID_COMMAND", "Lifecycle payload hash mismatch")
		return
	var kind := str(message.get("kind", ""))
	match kind:
		"hello_accept":
			_handle_hello_accept(request_id, payload)
		"status":
			if not _has_exact_keys(payload, []) or not _runtime_ready:
				_send_error(request_id, "INVALID_COMMAND", "Lifecycle runtime is not ready for status")
				return
			_send("status_result", _status_sample(), request_id)
		"shutdown":
			if not _has_exact_keys(payload, []):
				_send_error(request_id, "INVALID_COMMAND", "Shutdown payload must be empty")
				return
			_send("shutdown_ack", {"status": _status_sample()}, request_id)
			_peer.poll()
			get_tree().quit()
		_:
			_send_error(request_id, "INVALID_COMMAND", "Unsupported lifecycle command")


func _handle_hello_accept(request_id: String, payload: Dictionary) -> void:
	if _accepted:
		_send_error(request_id, "INVALID_COMMAND", "Lifecycle handshake was already accepted")
		return
	if not _has_exact_keys(payload, [
		"requiredCapabilities", "minimumProcessFrameDelta", "minimumPhysicsTickDelta",
	]):
		_send_error(request_id, "PROFILE_MISMATCH", "Unsupported lifecycle acceptance payload")
		return
	if (
		payload.get("requiredCapabilities", []) != CAPABILITIES
		or int(payload.get("minimumProcessFrameDelta", -1)) != MINIMUM_PROCESS_FRAME_DELTA
		or int(payload.get("minimumPhysicsTickDelta", -1)) != MINIMUM_PHYSICS_TICK_DELTA
	):
		_send_error(request_id, "PROFILE_MISMATCH", "Lifecycle readiness contract mismatch")
		return
	_accepted = true
	_ready_request_id = request_id
	_ready_baseline = _status_sample()


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
		var length := (
			(int(_receive_buffer[0]) << 24)
			| (int(_receive_buffer[1]) << 16)
			| (int(_receive_buffer[2]) << 8)
			| int(_receive_buffer[3])
		)
		if length <= 0 or length > MAX_FRAME_BYTES:
			push_error("ChronoRiftLifecycle received an invalid frame length")
			get_tree().quit(2)
			return
		if _receive_buffer.size() < length + 4:
			return
		var body := _receive_buffer.slice(4, 4 + length)
		_receive_buffer = _receive_buffer.slice(4 + length)
		var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
		if not parsed is Dictionary:
			_send_error("", "INVALID_COMMAND", "Lifecycle frame is not a JSON object")
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
	var bounded := message.replace("\r", " ").replace("\n", " ").replace(String.chr(0), " ").left(1024)
	_send("error", {"code": code, "message": bounded}, request_id)


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
		if is_equal_approx(value, round(value)):
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
