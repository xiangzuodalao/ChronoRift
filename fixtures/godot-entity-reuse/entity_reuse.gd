extends Node

signal respawned

const PARTICIPANT_ID := "case-04-state"

var enemy_ref: Dictionary = {}
var health := 100
var generation := 1
var pooling_enabled := true


func _ready() -> void:
	pooling_enabled = bool(ChronoProbe.fixture_control("pooling_enabled", true))
	enemy_ref = ChronoProbe.register_entity("enemy", self)
	ChronoProbe.register_state_property("enemy.health", self, "health")
	ChronoProbe.register_state_property("enemy.incarnation", self, "generation")
	ChronoProbe.register_state_property("control.pooling_enabled", self, "pooling_enabled")
	ChronoProbe.register_checkpoint_participant(PARTICIPANT_ID, self)
	ChronoProbe.connect_observed_signal(
		self,
		"respawned",
		_on_respawned,
		"enemy",
		"enemy.respawned",
		"enemy",
	)


func _on_respawned() -> void:
	ChronoProbe.record_signal_delivery("enemy", "enemy.respawned", "enemy")


func _input(event: InputEvent) -> void:
	if not (event is InputEventAction and event.action == "recycle_enemy" and event.pressed):
		return
	_recycle_enemy(ChronoProbe.consume_input_local_id(event.action))


func _recycle_enemy(caused_by: String) -> void:
	var despawn_event := ChronoProbe.record_entity_lifecycle("despawned", enemy_ref, caused_by)
	ChronoProbe.unregister_entity("enemy", self)
	var before_generation := generation
	enemy_ref = ChronoProbe.register_entity("enemy", self)
	generation = int(enemy_ref.get("incarnation", before_generation + 1))
	var spawn_event := ChronoProbe.record_entity_lifecycle("spawned", enemy_ref, despawn_event)
	ChronoProbe.record_transition("enemy.incarnation", before_generation, generation, spawn_event)
	var respawn_event := ChronoProbe.emit_observed_signal(
		self,
		"respawned",
		"enemy",
		"enemy.respawned",
		"enemy",
		spawn_event,
	)
	if pooling_enabled:
		var before_health := health
		health = 90
		ChronoProbe.record_transition("enemy.health", before_health, health, respawn_event)


func chronorift_capture() -> Dictionary:
	return {"health": health, "generation": generation}


func chronorift_restore(state: Dictionary) -> void:
	health = int(state.get("health", 100))
	generation = int(state.get("generation", 1))


func chronorift_validate(expected: Dictionary) -> Dictionary:
	var actual := chronorift_capture()
	var matches := ChronoProbe.payload_hash(actual) == ChronoProbe.payload_hash(expected)
	return {
		"participantId": PARTICIPANT_ID,
		"status": "pass" if matches else "fail",
		"stateHash": ChronoProbe.payload_hash(actual),
		"message": "Entity reuse participant matches" if matches else "Entity reuse participant differs",
	}
