extends ChronoRiftProjectAdapterV1

class ProjectionSupport:
	const PLATFORM_SCRIPT_PATH := "res://components/platform/platform.gd"

	static func platform_nodes(current_scene: Node) -> Array[Node]:
		var platforms: Array[Node] = []
		var pending: Array[Node] = [current_scene]
		while not pending.is_empty():
			var node: Node = pending.pop_back()
			var script: Variant = node.get_script()
			if script is Script and str(script.resource_path) == PLATFORM_SCRIPT_PATH:
				platforms.append(node)
			for child in node.get_children():
				pending.append(child)
		platforms.sort_custom(func(left: Node, right: Node) -> bool:
			return str(current_scene.get_path_to(left)) < str(current_scene.get_path_to(right))
		)
		return platforms

	static func node_path(current_scene: Node, platform: Node) -> String:
		return str(current_scene.get_path_to(platform))

	static func entity_id(current_scene: Node, platform: Node) -> String:
		return "platform:" + node_path(current_scene, platform).sha256_text().substr(0, 24)

	static func runtime_geometry(current_scene: Node, platform: Node) -> Dictionary:
		var rigid_body := platform.get_node_or_null("RigidBody2D") as RigidBody2D
		var solid_collision := platform.get_node_or_null("RigidBody2D/CollisionShape2D") as CollisionShape2D
		var area_collision := platform.get_node_or_null("RigidBody2D/Area2D/AreaCollisionShape2D") as CollisionShape2D
		var sprites := platform.get_node_or_null("RigidBody2D/Sprites")
		if rigid_body == null or solid_collision == null or area_collision == null or sprites == null:
			return {}
		var solid_shape := solid_collision.shape as RectangleShape2D
		var area_shape := area_collision.shape as RectangleShape2D
		if solid_shape == null or area_shape == null:
			return {}
		return {
			"node_path": node_path(current_scene, platform),
			"configured_width_tiles": int(platform.get("width")),
			"rendered_sprite_count": sprites.get_child_count(),
			"one_way": bool(platform.get("one_way")),
			"fall_time_seconds": float(platform.get("fall_time")),
			"solid_shape_instance_id": str(solid_shape.get_instance_id()),
			"solid_collision_width_px": float(solid_shape.size.x),
			"area_shape_instance_id": str(area_shape.get_instance_id()),
			"area_collision_width_px": float(area_shape.size.x),
		}

class EntityProjection extends ChronoRiftEntityProjectionV1:
	func sample(current_scene: Node) -> Array:
		var records: Array = []
		for platform in ProjectionSupport.platform_nodes(current_scene):
			records.append({
				"entityId": ProjectionSupport.entity_id(current_scene, platform),
				"entityTypeId": "platform",
				"incarnation": 1,
				"identityScope": "authored",
				"projection": {
					"node_path": ProjectionSupport.node_path(current_scene, platform),
				},
			})
		return records

class StateProjection extends ChronoRiftStateProjectionV1:
	var _has_emitted_sample := false
	var _last_emitted_sample: Dictionary = {}

	func sample(current_scene: Node) -> Array:
		var nodes := ProjectionSupport.platform_nodes(current_scene)
		var platforms: Array = []
		var coverage := "declared"
		if nodes.is_empty():
			coverage = "partial"
		for platform in nodes:
			var geometry := ProjectionSupport.runtime_geometry(current_scene, platform)
			if geometry.is_empty():
				coverage = "partial"
				continue
			platforms.append(geometry)
		var next_sample := {
			"stateDomainId": "platform_geometry",
			"value": {"platforms": platforms},
			"semanticCoverage": coverage,
		}
		if _has_emitted_sample and next_sample == _last_emitted_sample:
			return []
		_has_emitted_sample = true
		_last_emitted_sample = next_sample.duplicate(true)
		return [next_sample]

class EventProjection extends ChronoRiftEventProjectionV1:
	func drain(_current_scene: Node) -> Array:
		return []

func create_modules() -> Dictionary:
	return {
		"entity_projection": EntityProjection.new(),
		"state_projection": StateProjection.new(),
		"event_projection": EventProjection.new(),
	}
