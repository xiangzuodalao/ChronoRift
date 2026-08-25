extends ChronoRiftProjectAdapterV2

const MOB_SCRIPT_PATH := "res://Mob.gd"
const ENTITY_TYPE_ID := "mob"
const STATE_DOMAIN_ID := "mob_spawn_orientation"

var _context: ChronoRiftObservationContextV2
var _current_scene: Node
var _seen_instance_ids := {}


func start(context: ChronoRiftObservationContextV2, current_scene: Node) -> Error:
	_context = context
	_current_scene = current_scene
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
	# Main.gd initializes each Mob before adding it to the tree. Deferring once
	# samples the realized transform and velocity after that initialization.
	_consider.call_deferred(node)


func _consider(node: Node) -> void:
	if not is_instance_valid(node) or _seen_instance_ids.has(node.get_instance_id()):
		return
	var script: Variant = node.get_script()
	if not script is Script or str(script.resource_path) != MOB_SCRIPT_PATH:
		return
	var mob := node as CharacterBody3D
	if mob == null:
		return
	_seen_instance_ids[mob.get_instance_id()] = true
	var node_path := str(_current_scene.get_path_to(mob))
	var reference := _context.register_entity(
		"mob:%s" % str(mob.get_instance_id()),
		ENTITY_TYPE_ID,
		"execution_local",
		mob,
		{"node_path": node_path},
	)
	if reference.is_empty():
		return
	var player := _current_scene.get_node_or_null("Player") as Node3D
	var player_y := mob.global_position.y
	if player != null:
		player_y = player.global_position.y
	_context.emit_state(
		STATE_DOMAIN_ID,
		reference,
		{
			"node_path": node_path,
			"mob_y": mob.global_position.y,
			"player_y": player_y,
			"height_delta": player_y - mob.global_position.y,
			"up_alignment": mob.global_basis.y.normalized().dot(Vector3.UP),
			"velocity_y": mob.velocity.y,
			"horizontal_speed": Vector2(mob.velocity.x, mob.velocity.z).length(),
		},
	)
