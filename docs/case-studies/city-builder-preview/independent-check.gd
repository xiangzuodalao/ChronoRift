extends SceneTree

# Independent acceptance only. Never exposed to the investigation Agent.
# A late observer samples after Builder._process; process_frame itself fires before it.
class ProcessObserver extends Node:
	signal frame_completed
	var completed_frames: int = 0

	func _process(_delta: float) -> void:
		completed_frames += 1
		frame_completed.emit()

const MODEL_NAMES: Array[String] = [
	"road-straight", "road-straight-lightposts", "road-corner", "road-split",
	"road-intersection", "pavement", "pavement-fountain", "building-small-a",
	"building-small-b", "building-small-c", "building-small-d", "building-garage",
	"grass", "grass-trees", "grass-trees-tall"
]
var builder: Node
var container: Node3D
var selector: Node3D
var observer: ProcessObserver
var events: Array[Dictionary] = []
var scenarios: Array[Dictionary] = []
var additions: int = 0
var removals: int = 0

func _initialize() -> void:
	call_deferred("_run")

func _infrastructure_failure(message: String) -> void:
	print("CITY_CHECK_INFRASTRUCTURE_ERROR " + message)
	quit(2)

func _event(node: Node, kind: String) -> void:
	if kind == "added":
		additions += 1
	else:
		removals += 1
	if events.size() < 4096:
		events.append({
			"kind": kind, "instance_id": str(node.get_instance_id()),
			"model": node.scene_file_path,
			"process_frame": Engine.get_process_frames(),
			"physics_tick": Engine.get_physics_frames()
		})

func _snapshot() -> Dictionary:
	var children: Array[Dictionary] = []
	for node in container.get_children():
		var position_value: Variant = node.get("position")
		children.append({
			"instance_id": str(node.get_instance_id()), "model": node.scene_file_path,
			"position": [position_value.x, position_value.y, position_value.z] if position_value is Vector3 else null
		})
	return {
		"index": builder.get("index"), "children": children,
		"observed_process_completions": observer.completed_frames,
		"additions": additions, "removals": removals,
		"process_frame": Engine.get_process_frames(),
		"physics_tick": Engine.get_physics_frames(),
		"selector_basis": [selector.basis.x.x, selector.basis.x.y, selector.basis.x.z,
			selector.basis.y.x, selector.basis.y.y, selector.basis.y.z,
			selector.basis.z.x, selector.basis.z.y, selector.basis.z.z]
	}

func _frame(actions: Array[String] = []) -> void:
	await process_frame
	for action in actions:
		Input.action_press(action)
	await observer.frame_completed
	for action in actions:
		Input.action_release(action)

func _idle(name: String, frames: int, expected_index: int) -> void:
	var before: Dictionary = _snapshot()
	for frame in frames:
		await _frame()
	scenarios.append({
		"name": name, "kind": "stable", "frames": frames,
		"expected_index": expected_index, "before": before, "after": _snapshot()
	})

func _switch(action: String, expected_index: int, step: int) -> void:
	var before: Dictionary = _snapshot()
	await _frame([action])
	scenarios.append({
		"name": action + "_" + str(step), "kind": "switch", "frames": 1,
		"expected_index": expected_index, "before": before, "after": _snapshot()
	})
	await _idle(action + "_" + str(step) + "_idle", 3, expected_index)

func _run() -> void:
	if root.get_node_or_null("Audio") == null:
		_infrastructure_failure("configured Audio autoload is missing")
		return
	for action in ["structure_next", "structure_previous", "rotate"]:
		if not InputMap.has_action(action):
			_infrastructure_failure("missing input action: " + action)
			return
	var scene_path: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	var packed: PackedScene = load(scene_path) as PackedScene
	if packed == null:
		_infrastructure_failure("main scene could not be loaded")
		return
	var scene: Node = packed.instantiate()
	builder = scene.get_node_or_null("Builder")
	container = scene.get_node_or_null("Builder/Selector/Container") as Node3D
	selector = scene.get_node_or_null("Builder/Selector") as Node3D
	if builder == null or container == null or selector == null:
		_infrastructure_failure("main scene is missing the builder or preview container")
		return
	# Attach before entering the tree so _ready initialization is counted, too.
	container.child_entered_tree.connect(_event.bind("added"))
	container.child_exiting_tree.connect(_event.bind("removed"))
	observer = ProcessObserver.new()
	observer.process_priority = 1000000
	root.add_child(observer)
	root.add_child(scene)
	current_scene = scene
	var configured_models: Array[String] = []
	var structures: Variant = builder.get("structures")
	if not structures is Array or structures.size() != MODEL_NAMES.size():
		_infrastructure_failure("structure list does not match the pinned project's 15 models")
		return
	for structure in structures:
		var model: PackedScene = structure.get("model") as PackedScene
		if model == null:
			_infrastructure_failure("structure lacks a PackedScene model")
			return
		configured_models.append(model.resource_path)
	# Observe initialization synchronously after scene _ready, before any input.
	scenarios.append({"name": "initialization", "kind": "initialization", "expected_index": 0, "after": _snapshot()})
	await _idle("idle_120", 120, 0)
	# Both complete traversals cover every model and both wrap boundaries.
	for step in MODEL_NAMES.size():
		await _switch("structure_next", (step + 1) % MODEL_NAMES.size(), step)
	for step in MODEL_NAMES.size():
		await _switch("structure_previous", posmod(-step - 1, MODEL_NAMES.size()), step)
	var before: Dictionary = _snapshot()
	await _frame(["structure_next", "structure_previous"])
	scenarios.append({"name": "simultaneous_opposites", "kind": "stable", "frames": 1,
		"expected_index": 0, "before": before, "after": _snapshot()})
	await _idle("simultaneous_opposites_idle", 3, 0)
	before = _snapshot()
	await _frame(["rotate"])
	scenarios.append({"name": "rotate", "kind": "rotate", "frames": 1,
		"expected_index": 0, "before": before, "after": _snapshot()})
	await _idle("rotate_idle", 120, 0)
	print("CITY_CHECK_OBSERVATIONS " + JSON.stringify({
		"schema_version": 1,
		"main_scene": scene_path, "audio_autoload": str(root.get_node("Audio").get_path()),
		"configured_models": configured_models, "scenarios": scenarios, "events": events,
		"events_truncated": additions + removals > events.size(),
		"scope": "preview lifecycle, model source, offset, selection actions, and rotation; no pixel or full-gameplay validation"
	}))
	# Observation is finished. Stop audio before teardown so the mixer releases
	# the looping ambience stream; this cleanup is outside the measured interval.
	scene.process_mode = Node.PROCESS_MODE_DISABLED
	root.get_node("Audio").process_mode = Node.PROCESS_MODE_DISABLED
	for player in root.find_children("*", "AudioStreamPlayer", true, false):
		player.stop()
		player.stream = null
	await create_timer(0.1).timeout
	# Finish outside the observer signal and flush queued node destruction.
	packed = null
	structures = null
	scene.queue_free()
	observer.queue_free()
	await process_frame
	await process_frame
	call_deferred("_finish")

func _finish() -> void:
	quit(0)
