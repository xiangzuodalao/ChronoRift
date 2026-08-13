extends ChronoRiftProjectAdapterV2

var _context: ChronoRiftObservationContextV2
var _current := {}

func start(context: ChronoRiftObservationContextV2, current_scene: Node) -> Error:
	_context = context
	current_scene.get_tree().node_added.connect(_node_added)
	_walk(current_scene)
	return OK

func stop() -> void:
	pass

func _walk(node: Node) -> void:
	_consider(node)
	for child in node.get_children():
		_walk(child)

func _node_added(node: Node) -> void:
	call_deferred("_consider", node)

func _consider(node: Node) -> void:
	if not is_instance_valid(node) or not node.has_method("chronorift_fixture_stable_id"):
		return
	var entity_id := str(node.call("chronorift_fixture_stable_id"))
	var reference := _context.register_entity(entity_id, "dynamic_actor", "spawn_lineage", node, {"level": int(node.level)})
	if reference.is_empty():
		return
	_current[entity_id] = reference
	_context.emit_state("dynamic_actor_state", reference, {"level": int(node.level)})
	node.level_changed.connect(_level_changed.bind(node, reference))

func _level_changed(level: int, node: Node, reference: Dictionary) -> void:
	_context.emit_event("level_changed", reference, {"level": level})
	_context.emit_state("dynamic_actor_state", reference, {"level": int(node.level)})
