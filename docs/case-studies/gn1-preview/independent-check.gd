extends SceneTree

# One local project assertion, not an Adapter, probe, or gameplay evaluator.
var problems: Array[String] = []

func _initialize() -> void:
	call_deferred("_run")

func _infrastructure_failure(message: String) -> void:
	print("GN1_CHECK_INFRASTRUCTURE_ERROR " + message)
	quit(2)

func _require(condition: bool, message: String) -> void:
	if not condition:
		problems.append(message)

func _run() -> void:
	if root.get_node_or_null("Global") == null:
		_infrastructure_failure("configured Global autoload is missing")
		return
	var scene_path: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	var packed: PackedScene = load(scene_path) as PackedScene
	if packed == null:
		_infrastructure_failure("default scene could not be loaded: " + scene_path)
		return
	var scene: Node = packed.instantiate()
	if scene == null:
		_infrastructure_failure("default scene could not be instantiated")
		return
	root.add_child(scene)
	current_scene = scene
	await process_frame
	await process_frame
	print("GN1_CHECK_CONTEXT " + JSON.stringify({
		"main_scene": scene_path,
		"global_autoload": str(root.get_node("Global").get_path()),
		"process_frame": Engine.get_process_frames(),
		"physics_frame": Engine.get_physics_frames(),
		"settled_process_frames": 2,
		"scope": "initial platform dimensions and resource identity only; no input simulation"
	}))
	var names: Array[String] = ["Platform", "Platform2", "Platform3", "Platform4"]
	var widths: Array[int] = [2, 1, 3, 6]
	var area_shapes: Array[RectangleShape2D] = []
	for index in names.size():
		var name: String = names[index]
		var platform: Node = scene.get_node_or_null("Platforms/" + name)
		if platform == null:
			_infrastructure_failure("missing platform: " + name)
			return
		var sprites: Node = platform.get_node_or_null("RigidBody2D/Sprites")
		var solid_node: CollisionShape2D = platform.get_node_or_null("RigidBody2D/CollisionShape2D") as CollisionShape2D
		var area_node: CollisionShape2D = platform.get_node_or_null("RigidBody2D/Area2D/AreaCollisionShape2D") as CollisionShape2D
		if sprites == null or solid_node == null or area_node == null:
			_infrastructure_failure("missing sprite or collision node: " + name)
			return
		var solid: RectangleShape2D = solid_node.shape as RectangleShape2D
		var area: RectangleShape2D = area_node.shape as RectangleShape2D
		if solid == null or area == null:
			_infrastructure_failure("non-RectangleShape2D shape: " + name)
			return
		var width: Variant = platform.get("width")
		var sprite_count: int = sprites.get_child_count()
		print("GN1_CHECK_OBSERVATION " + JSON.stringify({
			"platform": name,
			"width": width,
			"sprite_count": sprite_count,
			"solid_size": [solid.size.x, solid.size.y],
			"solid_instance_id": str(solid.get_instance_id()),
			"area_size": [area.size.x, area.size.y],
			"area_instance_id": str(area.get_instance_id())
		}))
		_require(width == widths[index], name + ": configured width differs")
		_require(sprite_count == widths[index], name + ": sprite count differs")
		_require(solid.size == Vector2(widths[index] * 128, 128), name + ": solid size differs")
		_require(area.size == Vector2(widths[index] * 128, 40), name + ": area size differs")
		area_shapes.append(area)
	for left in area_shapes.size():
		for right in range(left + 1, area_shapes.size()):
			_require(area_shapes[left] != area_shapes[right], names[left] + " / " + names[right] + ": area shape is shared")
	print("GN1_CHECK_RESULT " + JSON.stringify({
		"passed": problems.is_empty(),
		"problems": problems,
		"observed_platforms": area_shapes.size()
	}))
	quit(0 if problems.is_empty() else 1)
