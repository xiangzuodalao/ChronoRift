/** Managed autoload only: the project's normal main scene remains its entry. */
export const GODOT_INSPECTION_OVERRIDE_SOURCE_V1 =
  '[autoload]\n\nChronoRiftInspection="*res://addons/chronorift_inspection/observer.gd"\n';

export const GODOT_INSPECTION_OBSERVER_SOURCE_V1 = String.raw`extends Node

const PROFILE := "chronorift-godot-inspection-v1"
const MAX_FRAME_BYTES := 1024 * 1024
const MAX_REFERENCES := 16384
const MAX_WATCH_RECORDS := 256
const MAX_WATCH_RECORD_BYTES := 32768
const MAX_WATCH_BYTES := 262144
const MAX_WATCH_CONSTRUCTION_BYTES := 65536
const WATCH_PHASE := "physics_frame_signal_before_node_physics_process"
var _peer := StreamPeerTCP.new()
var _buffer := PackedByteArray()
var _connected := false
var _sequence := 0
var _incoming := 0
var _execution_id := ""
var _next_ref := 0
var _refs: Dictionary = {}
var _instance_refs: Dictionary = {}
var _watch_state: Dictionary = {}
var _watch_bindings: Array = []
var _watch_records: Array = []
var _watch_record_bytes: Array = []
var _watch_bytes := 0

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	# SceneTree emits physics_frame immediately BEFORE node _physics_process callbacks.
	# This autoload connects before the main scene; this is not an end-of-tick sample.
	get_tree().physics_frame.connect(_sample_watch)
	_execution_id = OS.get_environment("CHRONORIFT_EXECUTION_ID")
	if _peer.connect_to_host("127.0.0.1", int(OS.get_environment("CHRONORIFT_PORT"))) != OK:
		get_tree().quit(1)

func _process(_delta: float) -> void:
	_peer.poll()
	if not _connected:
		if _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED or get_tree().current_scene == null:
			return
		_connected = true
		_write_frame({"schemaVersion": 1, "kind": "hello", "token": OS.get_environment("CHRONORIFT_TOKEN")})
		var scene := get_tree().current_scene
		_send("ready", {"executionId": _execution_id, "engineVersion": str(Engine.get_version_info().get("string", "unknown")), "scene": scene.scene_file_path, "root": _metadata(scene)})
	if _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		get_tree().quit(1)
		return
	var available := _peer.get_available_bytes()
	if available > 0:
		var received := _peer.get_data(mini(available, MAX_FRAME_BYTES + 4))
		if received[0] != OK:
			get_tree().quit(1)
			return
		_buffer.append_array(received[1])
		if _buffer.size() > MAX_FRAME_BYTES * 2 + 8:
			get_tree().quit(1)
			return
	var processed := 0
	while _buffer.size() >= 4 and processed < 8:
		var length := (int(_buffer[0]) << 24) | (int(_buffer[1]) << 16) | (int(_buffer[2]) << 8) | int(_buffer[3])
		if length <= 0 or length > MAX_FRAME_BYTES:
			get_tree().quit(1)
			return
		if _buffer.size() < length + 4:
			return
		var message: Variant = JSON.parse_string(_buffer.slice(4, length + 4).get_string_from_utf8())
		_buffer = _buffer.slice(length + 4)
		processed += 1
		if not message is Dictionary or message.get("schemaVersion") != 1 or message.get("profile") != PROFILE or message.get("sequence") != _incoming:
			get_tree().quit(1)
			return
		_incoming += 1
		if message.get("kind") == "stop" and message.get("payload") == {}:
			get_tree().quit()
			return
		if not message.get("requestId") is String:
			get_tree().quit(1)
			return
		if message.get("kind") == "query":
			_query(message.get("payload"), message.get("requestId"))
		elif message.get("kind") == "watch":
			_watch(message.get("payload"), message.get("requestId"))
		else:
			get_tree().quit(1)
			return

func _json_bytes(value: Variant) -> PackedByteArray:
	# Preserve doubles, and escape every C0 byte: Godot stringify does not escape
	# all of them, while the Host's strict JSON parser correctly rejects raw C0.
	var raw := JSON.stringify(value, "", true, true).to_utf8_buffer()
	if raw.size() > MAX_FRAME_BYTES:
		return raw
	var controls := 0
	for byte in raw:
		if byte < 32:
			controls += 1
	if controls == 0:
		return raw
	var encoded := PackedByteArray()
	var size := raw.size() + controls * 5
	if size > MAX_FRAME_BYTES:
		# A bounded oversize sentinel; callers reject before writing or appending.
		encoded.resize(MAX_FRAME_BYTES + 1)
		return encoded
	encoded.resize(size)
	var cursor := 0
	for byte in raw:
		if byte < 32:
			encoded[cursor] = 92
			encoded[cursor + 1] = 117
			encoded[cursor + 2] = 48
			encoded[cursor + 3] = 48
			encoded[cursor + 4] = "0123456789abcdef".unicode_at(byte >> 4)
			encoded[cursor + 5] = "0123456789abcdef".unicode_at(byte & 15)
			cursor += 6
		else:
			encoded[cursor] = byte
			cursor += 1
	return encoded

func _write_frame(value: Dictionary) -> void:
	var body := _json_bytes(value)
	if body.size() < 1 or body.size() > MAX_FRAME_BYTES:
		get_tree().quit(1)
		return
	var frame := PackedByteArray([(body.size() >> 24) & 255, (body.size() >> 16) & 255, (body.size() >> 8) & 255, body.size() & 255])
	frame.append_array(body)
	if _peer.put_data(frame) != OK:
		get_tree().quit(1)

func _send(kind: String, payload: Dictionary, request_id: String = "") -> void:
	var message := {"schemaVersion": 1, "profile": PROFILE, "sequence": _sequence, "kind": kind, "payload": payload}
	if not request_id.is_empty():
		message["requestId"] = request_id
	if _json_bytes(message).size() > MAX_FRAME_BYTES:
		message["kind"] = "error"
		message["payload"] = {"code": "budget_exhausted", "message": "Inspection response exceeded the 1 MiB wire budget; reduce the query"}
	_sequence += 1
	_write_frame(message)

func _error(request_id: String, code: String, message: String) -> void:
	_send("error", {"code": code, "message": message}, request_id)

func _reference(value: Object) -> String:
	var instance_id := str(value.get_instance_id())
	if _instance_refs.has(instance_id):
		var known: String = _instance_refs[instance_id]
		if _refs.has(known) and _refs[known].get_ref() == value:
			return known
	if _refs.size() >= MAX_REFERENCES:
		# Retire dead entries; opaque monotonic IDs are never assigned again.
		for key in _refs.keys():
			if _refs[key].get_ref() == null:
				_refs.erase(key)
		for key in _instance_refs.keys():
			if not _refs.has(_instance_refs[key]):
				_instance_refs.erase(key)
	if _refs.size() >= MAX_REFERENCES:
		return ""
	_next_ref += 1
	var reference := _execution_id + ".object." + str(_next_ref)
	_refs[reference] = weakref(value)
	_instance_refs[instance_id] = reference
	return reference

func _metadata(value: Object) -> Dictionary:
	var result := {"objectRef": _reference(value), "className": value.get_class()}
	if value is Node:
		result["name"] = str(value.name)
		result["childCount"] = value.get_child_count()
		var scene := get_tree().current_scene
		if scene != null and (scene == value or scene.is_ancestor_of(value)):
			result["path"] = str(scene.get_path_to(value))
	var script: Variant = value.get_script()
	if script is Script:
		result["scriptPath"] = script.resource_path
	if value is Resource:
		result["resourcePath"] = value.resource_path
	return result

func _valid_path(path: String) -> bool:
	# Constructing char(0) itself emits a Unicode parsing error in Godot.
	if path.is_empty() or path.length() > 2048 or path.begins_with("/") or path.contains(":") or path.contains("\\") or path.to_utf8_buffer().has(0):
		return false
	for segment in path.split("/"):
		if segment == ".." or segment.is_empty():
			return false
	return true

func _query(input: Variant, request_id: String) -> void:
	if not input is Dictionary or input.get("schemaVersion") != 1 or input.get("executionId") != _execution_id or not input.get("select") in ["children", "properties", "values"]:
		_error(request_id, "invalid_request", "Unsupported inspection query or execution")
		return
	var selection: String = input["select"]
	for key in input:
		if not key in ["schemaVersion", "executionId", "target", "select", "offset", "limit", "names"]:
			_error(request_id, "invalid_request", "Unknown query field")
			return
	var target: Variant = input.get("target", {"path": "."})
	if not target is Dictionary or target.size() != 1:
		_error(request_id, "invalid_request", "Exactly one scene-relative path or objectRef is required")
		return
	var object: Object = null
	if target.has("path") and target.path is String and _valid_path(target.path):
		var scene := get_tree().current_scene
		if scene != null:
			object = scene.get_node_or_null(NodePath(target.path))
	elif target.has("objectRef") and target.objectRef is String and _refs.has(target.objectRef):
		object = _refs[target.objectRef].get_ref()
	else:
		_error(request_id, "object_not_found", "Invalid path or unknown object reference")
		return
	if not is_instance_valid(object):
		_error(request_id, "object_not_found", "The requested object does not exist")
		return
	var result := {"schemaVersion": 1, "executionId": _execution_id, "select": selection, "sample": {"processFrame": Engine.get_process_frames(), "physicsTick": Engine.get_physics_frames()}, "target": _metadata(object)}
	if result.target.objectRef == "":
		_error(request_id, "budget_exhausted", "The live object reference budget is exhausted")
		return
	if selection == "values":
		if input.has("offset") or input.has("limit") or not input.get("names") is Array or input.names.is_empty() or input.names.size() > 32:
			_error(request_id, "invalid_request", "Values needs 1..32 explicit property names and no pagination")
			return
		for property_name in input.names:
			if not _valid_property_name(property_name):
				_error(request_id, "invalid_request", "Property names must be bounded literal names")
				return
		result["values"] = _read_values(object, input.names)
	else:
		var offset: Variant = input.get("offset", 0)
		var limit: Variant = input.get("limit", 100)
		if input.has("names") or not (offset is int or offset is float) or not (limit is int or limit is float) or offset != floor(offset) or limit != floor(limit) or offset < 0 or offset > 9007199254740991 or limit < 1 or limit > 200:
			_error(request_id, "invalid_request", "Invalid inspection pagination")
			return
		var items: Array = []
		var total := 0
		if selection == "children":
			if not object is Node:
				_error(request_id, "invalid_request", "Only nodes have children")
				return
			total = object.get_child_count()
			for index in range(int(offset), mini(total, int(offset) + int(limit))):
				var metadata := _metadata(object.get_child(index))
				if metadata.objectRef == "":
					_error(request_id, "budget_exhausted", "The live object reference budget is exhausted")
					return
				items.append(metadata)
		else:
			var properties := object.get_property_list()
			total = properties.size()
			for index in range(int(offset), mini(total, int(offset) + int(limit))):
				items.append({"name": str(properties[index].name), "type": type_string(properties[index].type)})
		result["items"] = items
		result["offset"] = int(offset)
		result["total"] = total
	_send("query_result", result, request_id)

func _valid_property_name(value: Variant) -> bool:
	return value is String and not value.is_empty() and value.length() <= 256 and not value.to_utf8_buffer().has(0)

func _read_values(object: Object, names: Array, construction: Array = []) -> Array:
	var property_names := {}
	if is_instance_valid(object):
		for property in object.get_property_list():
			if str(property.name) in names:
				property_names[str(property.name)] = true
	var values: Array = []
	for property_name in names:
		# Reserve the entry envelope and its longest error before allocating a value.
		if not construction.is_empty() and not _charge(construction, 512 + property_name.length() * 6):
			break
		if not is_instance_valid(object):
			values.append({"name": property_name, "status": "invalid_object", "message": "Object became invalid during inspection"})
		elif not property_names.has(property_name):
			values.append({"name": property_name, "status": "missing", "message": "Property is absent from get_property_list"})
		else:
			var encoded: Variant = _value(object.get(property_name), 0, [0], construction)
			if not construction.is_empty() and construction[0] > MAX_WATCH_CONSTRUCTION_BYTES:
				break
			# Include type-tag fields and truncation markers in the serialized budget.
			if not _within_value_budget(encoded, 0, [0]):
				encoded = {"$type": "truncated", "reason": "Serialized value depth or node budget exceeded"}
			if encoded is Dictionary and encoded.get("$type") in ["unsupported", "truncated"]:
				values.append({"name": property_name, "status": encoded["$type"], "message": str(encoded.get("reason", encoded.get("type", "Value unavailable")))})
			else:
				values.append({"name": property_name, "status": "success", "value": encoded})
	return values

func _whole_number(value: Variant, minimum: int, maximum: int) -> bool:
	return (value is int or value is float) and is_finite(value) and value == floor(value) and value >= minimum and value <= maximum

func _watch(input: Variant, request_id: String) -> void:
	if not input is Dictionary or input.get("schemaVersion") != 1 or input.get("executionId") != _execution_id or not input.get("action") in ["start", "read", "stop"]:
		_error(request_id, "invalid_request", "Unsupported watch request or execution")
		return
	var action: String = input.action
	var allowed := ["schemaVersion", "executionId", "action", "targets", "sampleCount", "clock"] if action == "start" else ["schemaVersion", "executionId", "action", "watchId", "afterSequence", "byteBudget"] if action == "read" else ["schemaVersion", "executionId", "action", "watchId"]
	for key in input:
		if not key in allowed:
			_error(request_id, "invalid_request", "Unknown watch field")
			return
	if action == "start":
		if not _watch_state.is_empty():
			_error(request_id, "busy", "Each Execution supports one observation window")
			return
		if input.get("clock") != "physics_tick" or not _whole_number(input.get("sampleCount"), 1, 256) or not input.get("targets") is Array or input.targets.is_empty() or input.targets.size() > 4:
			_error(request_id, "invalid_request", "Watch needs physics_tick, 1..256 samples, and 1..4 targets")
			return
		var bindings: Array = []
		var bound_targets: Array = []
		var construction := [512]
		for entry in input.targets:
			if not entry is Dictionary or entry.size() != 2 or not entry.has("target") or not entry.get("names") is Array or entry.names.is_empty() or entry.names.size() > 8:
				_error(request_id, "invalid_request", "Each target needs 1..8 explicit property names")
				return
			var seen := {}
			for property_name in entry.names:
				if not _valid_property_name(property_name) or seen.has(property_name):
					_error(request_id, "invalid_request", "Watch property names must be bounded and unique")
					return
				seen[property_name] = true
			var target: Variant = entry.target
			if not target is Dictionary or target.size() != 1:
				_error(request_id, "invalid_request", "Exactly one scene-relative path or objectRef is required")
				return
			var object: Object = null
			if target.has("path") and target.path is String and _valid_path(target.path):
				var scene := get_tree().current_scene
				if scene != null:
					object = scene.get_node_or_null(NodePath(target.path))
			elif target.has("objectRef") and target.objectRef is String and _refs.has(target.objectRef):
				object = _refs[target.objectRef].get_ref()
			else:
				_error(request_id, "object_not_found", "Invalid path or unknown object reference")
				return
			if not is_instance_valid(object):
				_error(request_id, "object_not_found", "The requested object does not exist")
				return
			var metadata := _metadata(object)
			if metadata.objectRef == "":
				_error(request_id, "budget_exhausted", "The live object reference budget is exhausted")
				return
			var bound := {"target": metadata, "names": entry.names.duplicate()}
			if not _charge_structure(bound, construction):
				_error(request_id, "budget_exhausted", "Watch registration construction budget exceeded")
				return
			bound_targets.append(bound)
			# Resolve paths once. A freed object is never replaced by a namesake.
			bindings.append(weakref(object))
		_watch_bindings = bindings
		_watch_state = {"schemaVersion": 1, "executionId": _execution_id, "watchId": _execution_id + ".watch.1", "phase": WATCH_PHASE, "status": "sampling", "stopReason": null, "sampleCount": int(input.sampleCount), "recordedCount": 0, "boundTargets": bound_targets}
	else:
		if _watch_state.is_empty() or input.get("watchId") != _watch_state.watchId:
			_error(request_id, "object_not_found", "Unknown watch in this Execution")
			return
		if action == "stop":
			_stop_watch("stopped")
	var result := _watch_state.duplicate()
	result["action"] = action
	if action == "read":
		var after: Variant = input.get("afterSequence", 0)
		var byte_budget: Variant = input.get("byteBudget", 65536)
		if not _whole_number(after, 0, 9007199254740991) or not _whole_number(byte_budget, 256, 65536):
			_error(request_id, "invalid_request", "Invalid watch pagination")
			return
		var records: Array = []
		var bytes := 0
		var next := int(after)
		var required: Variant = null
		for index in range(_watch_records.size()):
			var record: Dictionary = _watch_records[index]
			if record.sequence <= after:
				continue
			var size: int = _watch_record_bytes[index]
			if bytes + size > int(byte_budget):
				if records.is_empty():
					required = size
				break
			records.append(record)
			bytes += size
			next = record.sequence
		result.merge({"records": records, "bytesUsed": bytes, "nextSequence": next, "requiredByteBudget": required, "deliveryComplete": true})
	_send("watch_result", result, request_id)

func _stop_watch(reason: String) -> void:
	if not _watch_state.is_empty() and _watch_state.status == "sampling":
		_watch_state.status = "stopped"
		_watch_state.stopReason = reason

func _sample_watch() -> void:
	if _watch_state.is_empty() or _watch_state.status != "sampling":
		return
	if _watch_records.size() >= MAX_WATCH_RECORDS:
		_stop_watch("record_budget")
		return
	var construction := [512]
	var targets: Array = []
	for index in range(_watch_bindings.size()):
		var bound: Dictionary = _watch_state.boundTargets[index]
		if not _charge_structure(bound.target, construction):
			_stop_watch("construction_budget")
			return
		var object: Object = _watch_bindings[index].get_ref()
		var values := _read_values(object, bound.names, construction)
		if construction[0] > MAX_WATCH_CONSTRUCTION_BYTES:
			_stop_watch("construction_budget")
			return
		targets.append({"target": bound.target, "values": values})
	var record := {"sequence": _watch_records.size() + 1, "sample": {"processFrame": Engine.get_process_frames(), "physicsTick": Engine.get_physics_frames()}, "targets": targets}
	# Constructed output is bounded before this first encoding. No cache eviction.
	var encoded_bytes := _json_bytes(record).size()
	if encoded_bytes > MAX_WATCH_RECORD_BYTES or _watch_bytes + encoded_bytes > MAX_WATCH_BYTES:
		_stop_watch("encoded_budget")
		return
	_watch_records.append(record)
	_watch_record_bytes.append(encoded_bytes)
	_watch_bytes += encoded_bytes
	_watch_state.recordedCount = _watch_records.size()
	if _watch_records.size() >= _watch_state.sampleCount:
		_stop_watch("sample_count")

func _exit_tree() -> void:
	if not _watch_state.is_empty() and _connected and _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_stop_watch("execution_exit")
		_send("watch_final", {"state": _watch_state, "records": _watch_records, "deliveryComplete": true})

func _charge(construction: Array, bytes: int) -> bool:
	construction[0] += bytes
	return construction[0] <= MAX_WATCH_CONSTRUCTION_BYTES

func _charge_value(value: Variant, construction: Array) -> bool:
	match typeof(value):
		TYPE_STRING, TYPE_STRING_NAME:
			return _charge(construction, str(value).length() * 6 + 128)
		TYPE_ARRAY:
			return _charge(construction, 128 + mini(value.size(), 256))
		TYPE_DICTIONARY:
			if not _charge(construction, 128 + mini(value.size(), 256) * 2):
				return false
			if value.size() <= 256:
				for key in value:
					if key is String and not _charge(construction, key.length() * 6 + 2):
						return false
			return true
		TYPE_OBJECT:
			if is_instance_valid(value):
				if not _charge(construction, str(value.get_class()).length() * 6 + (_execution_id.length() + 32) * 6):
					return false
				if value is Resource and not _charge(construction, value.resource_path.length() * 6):
					return false
	return _charge(construction, 256)

func _charge_structure(value: Variant, construction: Array) -> bool:
	if not _charge_value(value, construction):
		return false
	if value is Array:
		for item in value:
			if not _charge_structure(item, construction):
				return false
	elif value is Dictionary:
		for key in value:
			if not _charge_structure(value[key], construction):
				return false
	return true

func _within_value_budget(value: Variant, depth: int, nodes: Array) -> bool:
	nodes[0] += 1
	if nodes[0] > 4096 or depth > 32:
		return false
	if value is Array:
		for item in value:
			if not _within_value_budget(item, depth + 1, nodes):
				return false
	elif value is Dictionary:
		for key in value:
			if not _within_value_budget(value[key], depth + 1, nodes):
				return false
	return true

func _value(value: Variant, depth: int, nodes: Array, construction: Array = []) -> Variant:
	# Charge before constructing or encoding output. The conservative estimate includes
	# container syntax, escaped dictionary keys, and six bytes per string code point.
	if not construction.is_empty() and not _charge_value(value, construction):
		return null
	nodes[0] += 1
	if depth > 32 or nodes[0] > 4096:
		return {"$type": "truncated", "reason": "Value depth or node budget exceeded"}
	match typeof(value):
		TYPE_NIL, TYPE_BOOL:
			return value
		TYPE_INT:
			if value > 9007199254740991 or value < -9007199254740991:
				return {"$type": "int64", "value": str(value)}
			return value
		TYPE_FLOAT:
			if is_finite(value) and value == floor(value) and abs(value) > 9007199254740991:
				return {"$type": "unsupported", "type": "float exceeds safe integer range"}
			return value if is_finite(value) else {"$type": "unsupported", "type": "nonfinite float"}
		TYPE_STRING, TYPE_STRING_NAME:
			if str(value).length() > 32768 or str(value).to_utf16_buffer().size() > 32768:
				return {"$type": "truncated", "reason": "String budget exceeded"}
			return str(value)
		TYPE_VECTOR2:
			return {"$type": "vector2", "x": value.x, "y": value.y} if value.is_finite() else {"$type": "unsupported", "type": "nonfinite Vector2"}
		TYPE_VECTOR3:
			return {"$type": "vector3", "x": value.x, "y": value.y, "z": value.z} if value.is_finite() else {"$type": "unsupported", "type": "nonfinite Vector3"}
		TYPE_COLOR:
			if not is_finite(value.r) or not is_finite(value.g) or not is_finite(value.b) or not is_finite(value.a):
				return {"$type": "unsupported", "type": "nonfinite Color"}
			return {"$type": "color", "r": value.r, "g": value.g, "b": value.b, "a": value.a}
		TYPE_OBJECT:
			if not is_instance_valid(value):
				return {"$type": "unsupported", "type": "invalid Object"}
			var reference := _reference(value)
			if reference.is_empty():
				return {"$type": "truncated", "reason": "Object reference budget exhausted"}
			var result := {"$type": "object", "objectRef": reference, "className": value.get_class()}
			if value is Resource:
				result["resourcePath"] = value.resource_path
			return result
		TYPE_ARRAY:
			if value.size() > 256:
				return {"$type": "truncated", "reason": "Array entry budget exceeded"}
			var result: Array = []
			for item in value:
				result.append(_value(item, depth + 1, nodes, construction))
				if not construction.is_empty() and construction[0] > MAX_WATCH_CONSTRUCTION_BYTES:
					return null
			return result
		TYPE_DICTIONARY:
			if value.size() > 256:
				return {"$type": "truncated", "reason": "Dictionary entry budget exceeded"}
			var result := {}
			for key in value:
				if not key is String or key == "$type":
					return {"$type": "unsupported", "type": "Dictionary with non-string or reserved key"}
				if key.length() > 256:
					return {"$type": "truncated", "reason": "Dictionary key budget exceeded"}
				result[key] = _value(value[key], depth + 1, nodes, construction)
				if not construction.is_empty() and construction[0] > MAX_WATCH_CONSTRUCTION_BYTES:
					return null
			return result
	return {"$type": "unsupported", "type": type_string(typeof(value))}
`;

export const GODOT_INSPECTION_OVERLAY_FILES_V1 = Object.freeze([
  {
    relativePath: "override.cfg",
    bytes: Buffer.from(GODOT_INSPECTION_OVERRIDE_SOURCE_V1, "utf8"),
  },
  {
    relativePath: "addons/chronorift_inspection/observer.gd",
    bytes: Buffer.from(GODOT_INSPECTION_OBSERVER_SOURCE_V1, "utf8"),
  },
]);
