extends Node

signal fired

const PARTICIPANT_ID := "case-03-state"
const PROJECTILE_SPEED := 600.0
const TARGET_X := 10.0
const TARGET_HALF_WIDTH := 0.5

var projectile_ref: Dictionary = {}
var fired_state := false
var fire_event_anchor := ""
var projectile_x := 0.0
var target_hit := false


func _ready() -> void:
	projectile_ref = ChronoProbe.register_entity("projectile", self)
	ChronoProbe.register_entity("target", self)
	ChronoProbe.register_state_property("projectile.x", self, "projectile_x")
	ChronoProbe.register_state_property("target.hit", self, "target_hit")
	ChronoProbe.register_checkpoint_participant(PARTICIPANT_ID, self)
	ChronoProbe.connect_observed_signal(
		self,
		"fired",
		_on_fired,
		"projectile",
		"projectile.fired",
		"target",
	)


func _on_fired() -> void:
	ChronoProbe.record_signal_delivery("projectile", "projectile.fired", "target")


func _input(event: InputEvent) -> void:
	if not (event is InputEventAction and event.action == "fire_projectile" and event.pressed):
		return
	var input_event := ChronoProbe.consume_input_local_id(event.action)
	fired_state = true
	fire_event_anchor = ChronoProbe.emit_observed_signal(
		self,
		"fired",
		"projectile",
		"projectile.fired",
		"target",
		input_event,
	)


func _physics_process(delta: float) -> void:
	if not ChronoProbe.execution_active or not fired_state or target_hit:
		return
	var before := projectile_x
	projectile_x += PROJECTILE_SPEED * delta
	var movement_event := ChronoProbe.record_transition(
		"projectile.x",
		before,
		projectile_x,
		fire_event_anchor,
	)
	var sample_event := ChronoProbe.record_spatial_sample(
		projectile_ref,
		Vector2(projectile_x, 0.0),
		movement_event,
	)
	if absf(projectile_x - TARGET_X) <= TARGET_HALF_WIDTH:
		target_hit = true
		ChronoProbe.record_transition("target.hit", false, true, sample_event)


func chronorift_capture() -> Dictionary:
	return {
		"fired": fired_state,
		"fireEventAnchor": fire_event_anchor,
		"projectileX": projectile_x,
		"targetHit": target_hit,
	}


func chronorift_restore(state: Dictionary) -> void:
	fired_state = bool(state.get("fired", false))
	fire_event_anchor = str(state.get("fireEventAnchor", ""))
	projectile_x = float(state.get("projectileX", 0.0))
	target_hit = bool(state.get("targetHit", false))


func chronorift_validate(expected: Dictionary) -> Dictionary:
	var actual := chronorift_capture()
	var matches := ChronoProbe.payload_hash(actual) == ChronoProbe.payload_hash(expected)
	return {
		"participantId": PARTICIPANT_ID,
		"status": "pass" if matches else "fail",
		"stateHash": ChronoProbe.payload_hash(actual),
		"message": "Physics participant matches" if matches else "Physics participant differs",
	}
