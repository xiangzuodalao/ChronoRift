extends Node

const SCHEMA_VERSION := 1
const PROTOCOL_PROFILE := "chronorift-godot-semantic-v1"
const PROTOCOL_VERSION := 1
const ADAPTER_VERSION := "0.5.0"
const MAX_FRAME_BYTES := 1024 * 1024
const MAX_ENTITIES := 256
const CAPABILITIES := [
	"lifecycle.status",
	"lifecycle.shutdown",
	"clock.process_frame",
	"clock.physics_tick",
	"semantic.timer_spawn.query",
	"semantic.timer_spawn.checkpoint",
	"semantic.timer_spawn.restore",
]
const RESTORE_LIMITATIONS := [
	"Only the adapter-declared Timer and spawned entity projection is restored.",
	"Scene-private state, signals, callables, RNG, audio, rendering, external state, and pending engine work remain uncontrolled.",
	"Restore completion does not establish an equivalent execution start.",
]

var _peer := StreamPeerTCP.new()
var _receive_buffer := PackedByteArray()
var _outgoing_sequence := 0
var _expected_incoming_sequence := 0
var _connected := false
var _accepted := false
var _runtime_ready := false
var _process_time_us := 0
var _physics_time_us := 0
var _configured_main_scene := ""
var _fingerprint: Dictionary = {}
var _profile: Dictionary = {}
var _subject: Node = null
var _timer: Timer = null
var _spawn_scene: PackedScene = null
var _spawn_scene_path := ""
var _subject_incarnation := 1
var _timer_incarnation := 1
var _next_spawn_ordinal := 0
var _entity_by_instance: Dictionary = {}
var _entity_incarnations: Dictionary = {}
var _restoring := false
var _adapter_request_id := ""


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_priority = -1000
	_configured_main_scene = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	_fingerprint = _build_fingerprint()
	var host := OS.get_environment("CHRONORIFT_HOST")
	var port := int(OS.get_environment("CHRONORIFT_PORT"))
	if host.is_empty() or port <= 0:
		push_error("ChronoRiftSemantic requires a managed Host endpoint")
		return
	var connection_status := _peer.connect_to_host(host, port)
	if connection_status != OK:
		push_error("ChronoRiftSemantic could not connect to the managed Host endpoint")


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
			"adapterProfileSha256": OS.get_environment("CHRONORIFT_ADAPTER_PROFILE_HASH"),
			"overlayHash": OS.get_environment("CHRONORIFT_OVERLAY_HASH"),
			"addonHash": OS.get_environment("CHRONORIFT_ADDON_HASH"),
		},
	}


func _semantic_clock() -> Dictionary:
	return {
		"processFrame": Engine.get_process_frames(),
		"physicsTick": Engine.get_physics_frames(),
		"simulationTimeUs": _process_time_us,
		"hostMonotonicUs": null,
		"renderFrame": null,
	}


func _status_sample() -> Dictionary:
	return {
		"processFrames": Engine.get_process_frames(),
		"physicsFrames": Engine.get_physics_frames(),
		"processTimeUs": _process_time_us,
		"physicsTimeUs": _physics_time_us,
		"configuredMainScene": _configured_main_scene,
		"currentScene": _current_scene_reference(),
		"projection": _capture_projection(),
	}


func _current_scene_reference() -> Variant:
	var scene := get_tree().current_scene
	if scene == null:
		return null
	var scene_path := str(scene.scene_file_path)
	return null if scene_path.is_empty() else scene_path


func _configure_adapter(profile: Dictionary, request_id: String) -> void:
	_adapter_request_id = request_id
	if not _has_exact_keys(profile, [
		"schemaVersion", "profileKind", "adapterKind", "projectCapabilitySha256",
		"targetScene", "spawnIntervalSeconds", "checkpointBarrier", "limits",
	]):
		fail_adapter("Adapter profile has an unsupported shape")
		return
	if (
		int(profile.get("schemaVersion", -1)) != 1
		or str(profile.get("profileKind", "")) != "chronorift-godot-semantic-adapter"
		or str(profile.get("adapterKind", "")) != "timer_spawn_v1"
		or str(profile.get("checkpointBarrier", "")) != "adapter_process_tail"
	):
		fail_adapter("Adapter profile kind or version is unsupported")
		return
	var target_scene := str(profile.get("targetScene", ""))
	if not target_scene.begins_with("res://") or not ResourceLoader.exists(target_scene, "PackedScene"):
		fail_adapter("Adapter target scene is unavailable")
		return
	var packed: Resource = load(target_scene)
	if not packed is PackedScene:
		fail_adapter("Adapter target is not a PackedScene")
		return
	_profile = profile.duplicate(true)
	_subject = (packed as PackedScene).instantiate()
	if _subject == null:
		fail_adapter("Adapter target scene could not be instantiated")
		return
	if not "spawn_interval" in _subject or not "scene_to_spawn" in _subject:
		fail_adapter("Adapter target does not expose the Timer/spawn contract")
		return
	_subject.set("spawn_interval", float(profile.get("spawnIntervalSeconds", 0.0)))
	_spawn_scene = _subject.get("scene_to_spawn") as PackedScene
	if _spawn_scene == null:
		fail_adapter("Adapter target has no spawn scene")
		return
	_spawn_scene_path = _spawn_scene.resource_path
	child_entered_tree.connect(_on_harness_child_entered)
	add_child(_subject)
	await get_tree().process_frame
	_timer = _find_subject_timer()
	if _timer == null:
		fail_adapter("Adapter target did not create a Timer child")
		return
	_runtime_ready = true
	_send("ready", _status_sample(), request_id)


func _find_subject_timer() -> Timer:
	if _subject == null:
		return null
	for child in _subject.get_children():
		if child is Timer:
			return child as Timer
	return null


func _on_harness_child_entered(node: Node) -> void:
	if _restoring or node == _subject or node == _timer:
		return
	if _entity_by_instance.size() >= MAX_ENTITIES:
		push_error("ChronoRiftSemantic entity bound exceeded")
		return
	var instance_key := str(node.get_instance_id())
	if _entity_by_instance.has(instance_key):
		return
	var ordinal := _next_spawn_ordinal
	_next_spawn_ordinal += 1
	var stable_id := "semantic:spawn:%d" % ordinal
	var incarnation := int(_entity_incarnations.get(stable_id, 0)) + 1
	_entity_incarnations[stable_id] = incarnation
	_entity_by_instance[instance_key] = {
		"node": node,
		"stableId": stable_id,
		"incarnation": incarnation,
		"spawnOrdinal": ordinal,
	}
	node.tree_exited.connect(_on_entity_exited.bind(instance_key), CONNECT_ONE_SHOT)


func _on_entity_exited(instance_key: String) -> void:
	_entity_by_instance.erase(instance_key)


func _capture_projection() -> Dictionary:
	if not _runtime_ready and (_subject == null or _timer == null):
		return _empty_projection()
	var entities: Array = []
	var keys: Array = _entity_by_instance.keys()
	keys.sort_custom(func(left: String, right: String) -> bool:
		return int((_entity_by_instance[left] as Dictionary).get("spawnOrdinal", 0)) < int((_entity_by_instance[right] as Dictionary).get("spawnOrdinal", 0))
	)
	for key in keys:
		var record: Dictionary = _entity_by_instance[key]
		var node: Node = record.get("node")
		if not is_instance_valid(node):
			continue
		entities.append(_entity_state(node, record))
	return {
		"schemaVersion": 1,
		"stateSchemaVersion": "chronorift.timer-spawn:v1",
		"subject": {
			"stableId": "semantic:subject",
			"incarnation": _subject_incarnation,
			"targetScene": str(_profile.get("targetScene", "res://unavailable.tscn")),
			"spawnIntervalSeconds": float(_profile.get("spawnIntervalSeconds", 1.0)),
			"spawnScene": _spawn_scene_path,
		},
		"timer": _timer_state(),
		"entities": entities,
		"nextSpawnOrdinal": _next_spawn_ordinal,
		"capturedAt": _semantic_clock(),
	}


func _empty_projection() -> Dictionary:
	return {
		"schemaVersion": 1,
		"stateSchemaVersion": "chronorift.timer-spawn:v1",
		"subject": {
			"stableId": "semantic:subject", "incarnation": 1,
			"targetScene": "res://unavailable.tscn", "spawnIntervalSeconds": 1.0,
			"spawnScene": "res://unavailable.tscn",
		},
		"timer": {
			"stableId": "semantic:timer", "incarnation": 1, "waitTimeSeconds": 0.0,
			"timeLeftSeconds": 0.0, "paused": false, "stopped": true,
			"oneShot": false, "autostart": false, "processCallback": "idle",
			"ignoreTimeScale": false, "timeoutOrdinal": 0,
		},
		"entities": [], "nextSpawnOrdinal": 0, "capturedAt": _semantic_clock(),
	}


func _timer_state() -> Dictionary:
	return {
		"stableId": "semantic:timer",
		"incarnation": _timer_incarnation,
		"waitTimeSeconds": maxf(0.0, _timer.wait_time),
		"timeLeftSeconds": maxf(0.0, _timer.time_left),
		"paused": _timer.paused,
		"stopped": _timer.is_stopped(),
		"oneShot": _timer.one_shot,
		"autostart": _timer.autostart,
		"processCallback": "physics" if _timer.process_callback == Timer.TIMER_PROCESS_PHYSICS else "idle",
		"ignoreTimeScale": _timer.ignore_time_scale,
		"timeoutOrdinal": _next_spawn_ordinal,
	}


func _entity_state(node: Node, record: Dictionary) -> Dictionary:
	var position := Vector2.ZERO
	var rotation := 0.0
	var scale := Vector2.ONE
	if node is Node2D:
		position = (node as Node2D).position
		rotation = (node as Node2D).rotation
		scale = (node as Node2D).scale
	var velocity: Variant = null
	if "velocity" in node and node.get("velocity") is Vector2:
		var observed_velocity: Vector2 = node.get("velocity")
		velocity = {"x": observed_velocity.x, "y": observed_velocity.y}
	return {
		"stableId": record.get("stableId"),
		"incarnation": record.get("incarnation"),
		"spawnOrdinal": record.get("spawnOrdinal"),
		"scene": _spawn_scene_path,
		"parentStableId": "semantic:harness",
		"transform": {
			"position": {"x": position.x, "y": position.y},
			"rotation": rotation,
			"scale": {"x": scale.x, "y": scale.y},
		},
		"visible": node.visible if node is CanvasItem else true,
		"processMode": node.process_mode,
		"velocity": velocity,
	}


func _restore_projection(projection: Dictionary) -> void:
	_restoring = true
	for record in _entity_by_instance.values():
		var node: Node = record.get("node")
		if is_instance_valid(node):
			node.queue_free()
	await get_tree().process_frame
	_entity_by_instance.clear()
	_next_spawn_ordinal = int(projection.get("nextSpawnOrdinal", 0))
	var entities: Array = projection.get("entities", [])
	for state_value in entities:
		var state: Dictionary = state_value
		var entity := _spawn_scene.instantiate()
		add_child(entity)
		_apply_entity_state(entity, state)
		var stable_id := str(state.get("stableId", ""))
		var incarnation := int(state.get("incarnation", 1))
		_entity_incarnations[stable_id] = incarnation
		var key := str(entity.get_instance_id())
		_entity_by_instance[key] = {
			"node": entity,
			"stableId": stable_id,
			"incarnation": incarnation,
			"spawnOrdinal": int(state.get("spawnOrdinal", 0)),
		}
		entity.tree_exited.connect(_on_entity_exited.bind(key), CONNECT_ONE_SHOT)
	var timer_state: Dictionary = projection.get("timer", {})
	_timer.stop()
	_timer.wait_time = maxf(0.001, float(timer_state.get("waitTimeSeconds", 1.0)))
	_timer.one_shot = bool(timer_state.get("oneShot", false))
	_timer.autostart = bool(timer_state.get("autostart", false))
	_timer.ignore_time_scale = bool(timer_state.get("ignoreTimeScale", false))
	_timer.process_callback = Timer.TIMER_PROCESS_PHYSICS if str(timer_state.get("processCallback", "idle")) == "physics" else Timer.TIMER_PROCESS_IDLE
	if not bool(timer_state.get("stopped", false)):
		_timer.start(maxf(0.001, float(timer_state.get("timeLeftSeconds", _timer.wait_time))))
	_timer.paused = bool(timer_state.get("paused", false))
	_restoring = false


func _apply_entity_state(node: Node, state: Dictionary) -> void:
	var transform: Dictionary = state.get("transform", {})
	if node is Node2D:
		var position: Dictionary = transform.get("position", {})
		var scale: Dictionary = transform.get("scale", {})
		(node as Node2D).position = Vector2(float(position.get("x", 0.0)), float(position.get("y", 0.0)))
		(node as Node2D).rotation = float(transform.get("rotation", 0.0))
		(node as Node2D).scale = Vector2(float(scale.get("x", 1.0)), float(scale.get("y", 1.0)))
	if node is CanvasItem:
		(node as CanvasItem).visible = bool(state.get("visible", true))
	node.process_mode = int(state.get("processMode", Node.PROCESS_MODE_INHERIT))
	var velocity: Variant = state.get("velocity")
	if velocity is Dictionary and "velocity" in node:
		node.set("velocity", Vector2(float(velocity.get("x", 0.0)), float(velocity.get("y", 0.0))))


func _handle_message(message: Dictionary) -> void:
	if not _has_exact_keys(message, [
		"schemaVersion", "protocolProfile", "protocolVersion", "sequence",
		"requestId", "payloadHash", "kind", "payload",
	]):
		_send_error(_request_id(message), "PROFILE_MISMATCH", "Unsupported semantic envelope")
		return
	if int(message.get("schemaVersion", -1)) != SCHEMA_VERSION or str(message.get("protocolProfile", "")) != PROTOCOL_PROFILE or int(message.get("protocolVersion", -1)) != PROTOCOL_VERSION:
		_send_error(_request_id(message), "PROFILE_MISMATCH", "Unsupported semantic profile or version")
		return
	if int(message.get("sequence", -1)) != _expected_incoming_sequence:
		_send_error(_request_id(message), "INVALID_COMMAND", "Unexpected semantic message sequence")
		return
	_expected_incoming_sequence += 1
	var request_id := _request_id(message)
	if request_id.is_empty():
		_send_error("", "INVALID_COMMAND", "Semantic command requires a request identity")
		return
	var payload: Variant = message.get("payload")
	if not payload is Dictionary or payload_hash(payload) != str(message.get("payloadHash", "")):
		_send_error(request_id, "INVALID_COMMAND", "Semantic payload hash mismatch")
		return
	match str(message.get("kind", "")):
		"hello_accept":
			if _accepted or not _has_exact_keys(payload, ["requiredCapabilities", "adapterProfile", "adapterProfileSha256"]):
				_send_error(request_id, "PROFILE_MISMATCH", "Unsupported semantic acceptance payload")
				return
			if payload.get("requiredCapabilities", []) != CAPABILITIES or payload_hash(payload.get("adapterProfile", {})) != str(payload.get("adapterProfileSha256", "")):
				_send_error(request_id, "PROFILE_MISMATCH", "Semantic adapter identity mismatch")
				return
			if str(payload.get("adapterProfileSha256", "")) != OS.get_environment("CHRONORIFT_ADAPTER_PROFILE_HASH"):
				_send_error(request_id, "PROFILE_MISMATCH", "Semantic adapter does not match the managed launch")
				return
			_accepted = true
			_configure_adapter(payload.get("adapterProfile", {}), request_id)
		"status":
			if not _has_exact_keys(payload, []) or not _runtime_ready:
				_send_error(request_id, "INVALID_COMMAND", "Semantic runtime is not ready")
				return
			_send("status_result", _status_sample(), request_id)
		"checkpoint_create":
			if not _runtime_ready or payload.get("barrier") != "adapter_process_tail":
				_send_error(request_id, "INVALID_COMMAND", "Unsupported checkpoint barrier")
				return
			call_deferred("_complete_checkpoint", request_id)
		"checkpoint_restore":
			if not _runtime_ready or not _has_exact_keys(payload, ["projection"]):
				_send_error(request_id, "INVALID_COMMAND", "Unsupported restore payload")
				return
			_restore_and_reply(request_id, payload.get("projection", {}))
		"shutdown":
			if not _has_exact_keys(payload, []):
				_send_error(request_id, "INVALID_COMMAND", "Shutdown payload must be empty")
				return
			_send("shutdown_ack", {"status": _status_sample()}, request_id)
			_peer.poll()
			get_tree().quit()
		_:
			_send_error(request_id, "INVALID_COMMAND", "Unsupported semantic command")


func _complete_checkpoint(request_id: String) -> void:
	_send("checkpoint_result", {
		"barrier": "adapter_process_tail",
		"projection": _capture_projection(),
	}, request_id)


func _restore_and_reply(request_id: String, projection: Dictionary) -> void:
	await _restore_projection(projection)
	_send("checkpoint_restored", {
		"restored": true,
		"projection": _capture_projection(),
		"limitations": RESTORE_LIMITATIONS,
	}, request_id)


func fail_adapter(message: String) -> void:
	_send_error(_adapter_request_id, "ADAPTER_FAILURE", message)
	get_tree().quit(2)


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
			push_error("ChronoRiftSemantic received an invalid frame length")
			get_tree().quit(2)
			return
		if _receive_buffer.size() < length + 4:
			return
		var body := _receive_buffer.slice(4, 4 + length)
		_receive_buffer = _receive_buffer.slice(4 + length)
		var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
		if not parsed is Dictionary:
			_send_error("", "INVALID_COMMAND", "Semantic frame is not a JSON object")
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
