/** Managed autoload only: the project's normal main scene remains its entry. */
export const GODOT_INSPECTION_OVERRIDE_SOURCE_V1 =
  '[autoload]\n\nChronoRiftInspection="*res://addons/chronorift_inspection/observer.gd"\n';

export const GODOT_INSPECTION_OBSERVER_SOURCE_V1 = String.raw`extends Node

const PROFILE := "chronorift-godot-inspection-v1"
const MAX_FRAME_BYTES := 1024 * 1024
const MAX_REFERENCES := 16384
var _peer := StreamPeerTCP.new()
var _buffer := PackedByteArray()
var _connected := false
var _sequence := 0
var _incoming := 0
var _execution_id := ""
var _next_ref := 0
var _refs: Dictionary = {}
var _instance_refs: Dictionary = {}

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
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
		if message.get("kind") != "query" or not message.get("requestId") is String:
			get_tree().quit(1)
			return
		_query(message.get("payload"), message.get("requestId"))

func _write_frame(value: Dictionary) -> void:
	var body := JSON.stringify(value).to_utf8_buffer()
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
	if JSON.stringify(message).to_utf8_buffer().size() > MAX_FRAME_BYTES:
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
		var property_names := {}
		for property in object.get_property_list():
			property_names[str(property.name)] = true
		var values: Array = []
		for property_name in input.names:
			if not property_name is String or property_name.is_empty() or property_name.length() > 256 or property_name.to_utf8_buffer().has(0):
				_error(request_id, "invalid_request", "Property names must be bounded literal names")
				return
			if not is_instance_valid(object):
				values.append({"name": property_name, "status": "invalid_object", "message": "Object became invalid during inspection"})
			elif not property_names.has(property_name):
				values.append({"name": property_name, "status": "missing", "message": "Property is absent from get_property_list"})
			else:
				var encoded: Variant = _value(object.get(property_name), 0, [0])
				# Include type-tag fields and truncation markers in the serialized budget.
				if not _within_value_budget(encoded, 0, [0]):
					encoded = {"$type": "truncated", "reason": "Serialized value depth or node budget exceeded"}
				if encoded is Dictionary and encoded.get("$type") in ["unsupported", "truncated"]:
					values.append({"name": property_name, "status": encoded["$type"], "message": str(encoded.get("reason", encoded.get("type", "Value unavailable")))})
				else:
					values.append({"name": property_name, "status": "success", "value": encoded})
		result["values"] = values
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

func _value(value: Variant, depth: int, nodes: Array) -> Variant:
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
			if str(value).to_utf16_buffer().size() > 32768:
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
				result.append(_value(item, depth + 1, nodes))
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
				result[key] = _value(value[key], depth + 1, nodes)
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
