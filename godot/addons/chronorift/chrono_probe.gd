extends Node

const PROTOCOL_VERSION := 1
const SCHEMA_VERSION := 1
const MAX_FRAME_BYTES := 1024 * 1024
const CAPABILITIES := [
	"observe.signal_allowlist",
	"observe.property_sampling",
	"control.input_event_action",
	"clock.process_frame",
	"clock.physics_tick",
	"launch.fixed_fps",
	"checkpoint.l0_restart",
	"checkpoint.fixture_semantic",
]

var _peer := StreamPeerTCP.new()
var _receive_buffer := PackedByteArray()
var _outgoing_sequence := 0
var _expected_incoming_sequence := 0
var _connected := false
var _configured := false
var _allowed_properties: Array = []
var _allowed_signals: Array = []
var _participants: Dictionary = {}
var _entities: Dictionary = {}
var _observed_connections: Dictionary = {}
var _events: Array = []
var _current_input_local_id := ""
var _pending_input_local_ids: Dictionary = {}
var _current_signal_local_id := ""
var _current_delta_us := 16667
var _pending_step: Dictionary = {}
var _step_physics_start := 0
var step_activation_frame := -1
var _probe_overhead_us := 0
var _fingerprint: Dictionary = {}
var execution_active := false
var _next_tick := 0
var _sim_time_us := 0


func _ready() -> void:
	process_priority = -1000
	_fingerprint = _build_fingerprint()
	var host := OS.get_environment("CHRONORIFT_HOST")
	var port := int(OS.get_environment("CHRONORIFT_PORT"))
	if host.is_empty() or port <= 0:
		push_error("ChronoProbe requires CHRONORIFT_HOST and CHRONORIFT_PORT")
		return
	var status := _peer.connect_to_host(host, port)
	if status != OK:
		push_error("ChronoProbe could not connect to the harness")


func _process(delta: float) -> void:
	_current_delta_us = maxi(1, int(round(delta * 1000000.0)))
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


func register_entity(stable_id: String, entity: Node) -> void:
	if stable_id.is_empty() or _entities.has(stable_id):
		push_error("Duplicate or empty ChronoRift entity ID: %s" % stable_id)
		return
	_entities[stable_id] = entity


func register_checkpoint_participant(participant_id: String, participant: Node) -> void:
	if participant_id.is_empty() or _participants.has(participant_id):
		push_error("Duplicate or empty checkpoint participant ID: %s" % participant_id)
		return
	for method in ["chronorift_capture", "chronorift_restore", "chronorift_validate"]:
		if not participant.has_method(method):
			push_error("Checkpoint participant %s lacks %s" % [participant_id, method])
			return
	_participants[participant_id] = participant


func record_transition(path: String, before: Variant, after: Variant, caused_by := "") -> String:
	var probe_started_us := Time.get_ticks_usec()
	if not _allowed_properties.has(path):
		push_error("ChronoProbe rejected non-allowlisted property: %s" % path)
		return caused_by
	var local_id := "godot:%d:property:%d" % [Engine.get_process_frames(), _events.size()]
	var event := {
		"kind": "property_changed",
		"localId": local_id,
		"path": path,
		"before": before,
		"after": after,
	}
	var cause: String = caused_by
	if cause.is_empty():
		cause = _current_input_local_id
	if not cause.is_empty():
		event["causedByLocalId"] = cause
	_events.append(event)
	_probe_overhead_us += maxi(0, Time.get_ticks_usec() - probe_started_us)
	return local_id


func connect_observed_signal(
	source: Object,
	native_signal: String,
	callback: Callable,
	source_id: String,
	telemetry_name: String,
	receiver_id: String,
) -> void:
	var probe_started_us := Time.get_ticks_usec()
	var key := "%s|%s|%s" % [source_id, telemetry_name, receiver_id]
	if not source.is_connected(native_signal, callback):
		source.connect(native_signal, callback)
	_observed_connections[key] = true
	_probe_overhead_us += maxi(0, Time.get_ticks_usec() - probe_started_us)


func emit_observed_signal(
	source: Object,
	native_signal: String,
	source_id: String,
	telemetry_name: String,
	receiver_id: String,
	caused_by := "",
) -> void:
	var probe_started_us := Time.get_ticks_usec()
	if not _allowed_signals.has("%s|%s" % [source_id, telemetry_name]):
		push_error("ChronoProbe rejected non-allowlisted Signal: %s/%s" % [source_id, telemetry_name])
		return
	var signal_local_id := "godot:%d:signal:%d" % [Engine.get_process_frames(), _events.size()]
	var signal_event := {
		"kind": "signal",
		"localId": signal_local_id,
		"source": source_id,
		"name": telemetry_name,
		"arguments": [],
	}
	if not caused_by.is_empty():
		signal_event["causedByLocalId"] = caused_by
	_events.append(signal_event)
	var key := "%s|%s|%s" % [source_id, telemetry_name, receiver_id]
	if not _observed_connections.has(key):
		_events.append({
			"kind": "signal_delivery",
			"localId": "godot:%d:delivery:%d" % [Engine.get_process_frames(), _events.size()],
			"causedByLocalId": signal_local_id,
			"source": source_id,
			"name": telemetry_name,
			"receiver": receiver_id,
			"delivered": false,
			"failureReason": "receiver_not_connected",
		})
	_probe_overhead_us += maxi(0, Time.get_ticks_usec() - probe_started_us)
	_current_signal_local_id = signal_local_id
	source.emit_signal(native_signal)
	_current_signal_local_id = ""


func record_signal_delivery(source_id: String, telemetry_name: String, receiver_id: String) -> String:
	var probe_started_us := Time.get_ticks_usec()
	var local_id := "godot:%d:delivery:%d" % [Engine.get_process_frames(), _events.size()]
	_events.append({
		"kind": "signal_delivery",
		"localId": local_id,
		"causedByLocalId": _current_signal_local_id,
		"source": source_id,
		"name": telemetry_name,
		"receiver": receiver_id,
		"delivered": true,
	})
	_probe_overhead_us += maxi(0, Time.get_ticks_usec() - probe_started_us)
	return local_id


func current_input_local_id() -> String:
	return _current_input_local_id


func consume_input_local_id(action: String) -> String:
	var pending: Array = _pending_input_local_ids.get(action, [])
	if pending.is_empty():
		return ""
	var local_id: String = pending.pop_front()
	_pending_input_local_ids[action] = pending
	return local_id


func current_state() -> Dictionary:
	var switch_node: Node = _entities.get("switch")
	var door_node: Node = _entities.get("door")
	return {
		"values": {
			"switch.active": false if switch_node == null else switch_node.get("active"),
			"door.open": false if door_node == null else door_node.get("open"),
			"door.receiver_connected": false if door_node == null else door_node.get("receiver_connected"),
		},
	}


func _handle_message(message: Dictionary) -> void:
	if int(message.get("schemaVersion", -1)) != SCHEMA_VERSION or int(message.get("protocolVersion", -1)) != PROTOCOL_VERSION:
		_send_error(message.get("requestId", ""), "PROTOCOL_MISMATCH", "Unsupported protocol version")
		return
	if int(message.get("sequence", -1)) != _expected_incoming_sequence:
		_send_error(message.get("requestId", ""), "INVALID_COMMAND", "Unexpected message sequence")
		return
	_expected_incoming_sequence += 1
	var payload: Variant = message.get("payload")
	if not payload is Dictionary or payload_hash(payload) != message.get("payloadHash", ""):
		_send_error(message.get("requestId", ""), "INVALID_COMMAND", "Payload hash mismatch")
		return
	var kind: String = message.get("kind", "")
	var request_id: String = message.get("requestId", "")
	match kind:
		"hello_accept":
			for capability in payload.get("requiredCapabilities", []):
				if not CAPABILITIES.has(capability):
					_send_error(request_id, "CAPABILITY_UNSUPPORTED", "Unsupported capability: %s" % capability)
					return
		"configure":
			var probe_plan: Dictionary = payload.get("probePlan", {})
			_allowed_properties = probe_plan.get("properties", [])
			_allowed_signals = []
			for observed_signal in probe_plan.get("signals", []):
				_allowed_signals.append("%s|%s" % [observed_signal.get("source", ""), observed_signal.get("name", "")])
			_configured = true
			_send("configured", {"accepted": true}, request_id)
		"restore":
			_handle_restore(request_id, payload)
		"step":
			_handle_step(request_id, payload)
		"snapshot":
			_handle_snapshot(request_id)
		"shutdown":
			_send("shutdown_ack", {}, request_id)
			get_tree().quit()
		_:
			_send_error(request_id, "INVALID_COMMAND", "Unknown command: %s" % kind)


func _handle_restore(request_id: String, payload: Dictionary) -> void:
	if not _configured:
		_send_error(request_id, "INVALID_COMMAND", "Probe is not configured")
		return
	var snapshot: Dictionary = payload.get("snapshot", {})
	_next_tick = int(payload.get("nextTick", 0))
	_sim_time_us = int(payload.get("simTimeUs", 0))
	var runtime_state: Dictionary = snapshot.get("runtimeState", {})
	var participant_states: Dictionary = runtime_state.get("participants", {})
	var certificate: Dictionary = payload.get("certificate", {})
	var checkpoint_level: String = certificate.get("level", "fixture_semantic_l2")
	var validations: Array = []
	for participant_id in _participants.keys():
		var participant: Node = _participants[participant_id]
		if not participant_states.has(participant_id):
			_send_error(request_id, "RESTORE_FAILED", "Missing participant state: %s" % participant_id)
			return
		if checkpoint_level == "fixture_semantic_l2":
			participant.chronorift_restore(participant_states[participant_id])
		validations.append(participant.chronorift_validate(participant_states[participant_id]))
		if validations[-1].get("status") != "pass":
			_send_error(request_id, "RESTORE_FAILED", "Participant validation failed: %s" % participant_id)
			return
	_send("restored", {
		"restored": true,
		"nextTick": int(payload.get("nextTick", 0)),
		"simTimeUs": int(payload.get("simTimeUs", 0)),
		"state": current_state(),
		"runtimeValidation": {
			"schemaVersion": 1,
			"level": checkpoint_level,
			"semanticStateHash": payload_hash(current_state()),
			"validations": validations,
		},
	}, request_id)


func _handle_step(request_id: String, payload: Dictionary) -> void:
	if not _pending_step.is_empty():
		_send_error(request_id, "INVALID_COMMAND", "A step is already pending")
		return
	_events = []
	_probe_overhead_us = 0
	_step_physics_start = Engine.get_physics_frames()
	_pending_step = {"requestId": request_id, "payload": payload}
	execution_active = true
	step_activation_frame = Engine.get_process_frames()
	for input in payload.get("inputs", []):
		_inject_input(input)
	_complete_step_after_process_frame()


func _complete_step_after_process_frame() -> void:
	await get_tree().process_frame
	await get_tree().process_frame
	_complete_step()


func _inject_input(input: Dictionary) -> void:
	var probe_started_us := Time.get_ticks_usec()
	_current_input_local_id = input.get("localId", "")
	var action: String = input.get("action", "")
	var pending: Array = _pending_input_local_ids.get(action, [])
	pending.append(_current_input_local_id)
	_pending_input_local_ids[action] = pending
	var press := InputEventAction.new()
	press.action = action
	press.pressed = true
	press.strength = 1.0
	Input.parse_input_event(press)
	var release := InputEventAction.new()
	release.action = action
	release.pressed = false
	release.strength = 0.0
	Input.parse_input_event(release)
	_current_input_local_id = ""
	_probe_overhead_us += maxi(0, Time.get_ticks_usec() - probe_started_us)


func _complete_step() -> void:
	if _pending_step.is_empty():
		return
	var payload: Dictionary = _pending_step["payload"]
	var request_id: String = _pending_step["requestId"]
	var physics_ticks := maxi(0, Engine.get_physics_frames() - _step_physics_start)
	var physics_deltas: Array = []
	for ignored in range(physics_ticks):
		physics_deltas.append(int(round(1000000.0 / float(Engine.physics_ticks_per_second))))
	var applications: Array = []
	var orders: Array = []
	for input in payload.get("inputs", []):
		var order := int(input.get("order", 0))
		orders.append(order)
		applications.append({
			"order": order,
			"eventsInjected": 2,
			"pressed": true,
			"released": true,
		})
	_next_tick = int(payload.get("tick", 0)) + 1
	_sim_time_us = int(payload.get("simTimeUs", 0)) + _current_delta_us
	_send("stepped", {
		"events": _events,
		"state": current_state(),
		"receipt": {
			"requestedTick": int(payload.get("tick", 0)),
			"realizedTick": int(payload.get("tick", 0)),
			"requestedDeltaUs": int(payload.get("deltaUs", 16667)),
			"realizedDeltaUs": _current_delta_us,
			"appliedInputOrders": orders,
			"runtime": {
				"schemaVersion": 1,
				"phase": "process_frame_start",
				"idleFramesExecuted": 1,
				"physicsTicksExecuted": physics_ticks,
				"actualIdleDeltasUs": [_current_delta_us],
				"actualPhysicsDeltasUs": physics_deltas,
				"engineProcessFrame": Engine.get_process_frames(),
				"enginePhysicsFrame": Engine.get_physics_frames(),
				"hostMonotonicStartUs": 0,
				"hostMonotonicEndUs": 0,
				"inputApplications": applications,
				"observationHealth": {
					"schemaVersion": 1,
					"emittedEvents": _events.size(),
					"droppedEvents": 0,
					"truncatedEvents": 0,
					"bufferedBytes": JSON.stringify(_events).to_utf8_buffer().size(),
					"backpressure": false,
					"probeOverheadUs": _probe_overhead_us,
				},
			},
		},
	}, request_id)
	_pending_step = {}
	execution_active = false


func _handle_snapshot(request_id: String) -> void:
	var participant_states := {}
	var validations: Array = []
	for participant_id in _participants.keys():
		var participant: Node = _participants[participant_id]
		var state: Variant = participant.chronorift_capture()
		participant_states[participant_id] = state
		validations.append(participant.chronorift_validate(state))
	var snapshot := {
		"state": current_state(),
		"runtimeState": {
			"nowUs": _sim_time_us,
			"nextTick": _next_tick,
			"participants": participant_states,
		},
		"rngState": {},
		"pendingEffects": {
			"deferredCallsDrained": false,
		},
	}
	var certificate := {
		"schemaVersion": 1,
		"level": "fixture_semantic_l2",
		"captureConsistencyModel": "frame_end_barrier",
		"adapterSemanticBarrier": "chronorift.frame_end_deferred",
		"environmentFingerprint": _fingerprint,
		"coveredStateDomains": [
			"fixture.switch_state",
			"fixture.door_state",
			"fixture.signal_connections",
			"logical_clock",
			"input_schedule",
		],
		"missingStateDomains": [
			"godot.physics_internal",
			"godot.timers_tweens_coroutines",
			"godot.threads",
			"godot.unregistered_rng",
			"godot.resource_caches",
			"external_services",
		],
		"externalDependencies": [],
		"rngDomains": [],
		"pendingAsyncOperations": ["untracked_deferred_calls"],
		"restoreRecipeHash": payload_hash(snapshot),
		"restoreValidation": validations,
		"portability": "same_build_only",
		"limitations": [
			"Only the registered switch-door participant is restored",
			"Godot engine internals are not checkpointed",
		],
	}
	_send("snapshot_result", {"snapshot": snapshot, "certificate": certificate}, request_id)


func _build_fingerprint() -> Dictionary:
	var version_info := Engine.get_version_info()
	return {
		"schemaVersion": 1,
		"engine": "godot",
		"engineVersion": str(version_info.get("string", "unknown")),
		"adapterVersion": "0.2.0",
		"protocolVersion": 1,
		"platform": OS.get_name(),
		"renderer": RenderingServer.get_current_rendering_method(),
		"physicsTicksPerSecond": Engine.physics_ticks_per_second,
		"fixedFps": int(OS.get_environment("CHRONORIFT_FIXED_FPS")),
		"projectHash": OS.get_environment("CHRONORIFT_PROJECT_HASH"),
		"addonHash": OS.get_environment("CHRONORIFT_ADDON_HASH"),
		"capabilities": CAPABILITIES,
	}


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
			push_error("ChronoProbe received an invalid frame length")
			get_tree().quit(2)
			return
		if _receive_buffer.size() < length + 4:
			return
		var body := _receive_buffer.slice(4, 4 + length)
		_receive_buffer = _receive_buffer.slice(4 + length)
		var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
		if not parsed is Dictionary:
			push_error("ChronoProbe received invalid JSON")
			continue
		_handle_message(parsed)


func _send(kind: String, payload: Dictionary, request_id := "") -> void:
	var message := {
		"schemaVersion": SCHEMA_VERSION,
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
	_send("error", {"code": code, "message": message}, request_id)


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
		var parts: Array[String] = []
		for entry in value:
			parts.append(_canonical_json(entry))
		return "[" + ",".join(parts) + "]"
	if value is Dictionary:
		var keys: Array = value.keys()
		keys.sort()
		var parts: Array[String] = []
		for key in keys:
			parts.append(JSON.stringify(str(key)) + ":" + _canonical_json(value[key]))
		return "{" + ",".join(parts) + "}"
	return JSON.stringify(str(value))
