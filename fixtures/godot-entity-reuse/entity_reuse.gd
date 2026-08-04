extends Node

signal respawned

const PARTICIPANT_ID := "case-04-state"
const EFFECT_DAMAGE := 10

var enemy_ref: Dictionary = {}
var health := 100
var generation := 1
var pooling_enabled := true
var effect_sequence := 0
var pending_effects: Array = []
var last_processed_tick := -1

var _effect_anchors: Dictionary = {}
var _restore_valid := true


func _ready() -> void:
	pooling_enabled = bool(ChronoProbe.fixture_control("pooling_enabled", true))
	enemy_ref = ChronoProbe.register_entity("enemy", self)
	ChronoProbe.register_state_property("enemy.health", self, "health")
	ChronoProbe.register_state_property("enemy.incarnation", self, "generation")
	ChronoProbe.register_state_property("enemy.effect_sequence", self, "effect_sequence")
	ChronoProbe.register_state_provider(
		"enemy.pending_effect_count",
		func() -> int: return pending_effects.size(),
	)
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
	_schedule_pending_effect(ChronoProbe.consume_input_local_id(event.action))


func _process(_delta: float) -> void:
	if not ChronoProbe.execution_active:
		return
	var logical_tick := ChronoProbe.current_step_tick()
	if logical_tick == last_processed_tick:
		return
	last_processed_tick = logical_tick
	_resolve_pending_effects(logical_tick)


func _schedule_pending_effect(caused_by: String) -> void:
	effect_sequence += 1
	var effect := {
		"effectId": "damage:%d" % effect_sequence,
		"target": enemy_ref.duplicate(true),
		"dueTick": ChronoProbe.current_step_tick() + 1,
	}
	pending_effects.append(effect)
	var scheduled_event := ChronoProbe.record_pending_effect(
		"scheduled",
		effect,
		{},
		"",
		caused_by,
	)
	_effect_anchors[effect["effectId"]] = scheduled_event


func _resolve_pending_effects(logical_tick: int) -> void:
	var remaining: Array = []
	for effect_value in pending_effects:
		var effect: Dictionary = effect_value
		if int(effect.get("dueTick", -1)) > logical_tick:
			remaining.append(effect)
			continue
		_resolve_pending_effect(effect)
	pending_effects = remaining


func _resolve_pending_effect(effect: Dictionary) -> void:
	var effect_id: String = effect.get("effectId", "")
	var anchor: String = _effect_anchors.get(effect_id, "")
	var despawn_event := ChronoProbe.record_entity_lifecycle("despawned", enemy_ref, anchor)
	ChronoProbe.unregister_entity("enemy", self)
	var before_generation := generation
	enemy_ref = ChronoProbe.register_entity("enemy", self)
	generation = int(enemy_ref.get("incarnation", before_generation + 1))
	var spawn_event := ChronoProbe.record_entity_lifecycle("spawned", enemy_ref, despawn_event)
	var incarnation_event := ChronoProbe.record_transition(
		"enemy.incarnation",
		before_generation,
		generation,
		spawn_event,
	)
	var requested_target: Dictionary = effect.get("target", {})
	var resolved_target := ChronoProbe.entity_ref(str(requested_target.get("stableId", "")))
	var resolution_event := incarnation_event
	if pooling_enabled and not resolved_target.is_empty():
		var applied_event := ChronoProbe.record_pending_effect(
			"applied",
			effect,
			resolved_target,
			"",
			incarnation_event,
		)
		var before_health := health
		health -= EFFECT_DAMAGE
		resolution_event = ChronoProbe.record_transition("enemy.health", before_health, health, applied_event)
	elif not pooling_enabled:
		resolution_event = ChronoProbe.record_pending_effect(
			"discarded",
			effect,
			{},
			"owner_destroyed",
			incarnation_event,
		)
	else:
		resolution_event = ChronoProbe.record_pending_effect(
			"discarded",
			effect,
			{},
			"target_missing",
			incarnation_event,
		)
	ChronoProbe.emit_observed_signal(
		self,
		"respawned",
		"enemy",
		"enemy.respawned",
		"enemy",
		resolution_event,
	)
	_effect_anchors.erase(effect_id)


func chronorift_capture() -> Dictionary:
	return {
		"health": health,
		"generation": generation,
		"effectSequence": effect_sequence,
		"pendingEffects": pending_effects.duplicate(true),
		"lastProcessedTick": last_processed_tick,
	}


func chronorift_pending_effect_state() -> Dictionary:
	return {
		"effectSequence": effect_sequence,
		"pendingEffects": pending_effects.duplicate(true),
	}


func chronorift_restore(state: Dictionary) -> void:
	_restore_valid = _valid_checkpoint_state(state)
	if not _restore_valid:
		return
	health = int(state["health"])
	generation = int(state["generation"])
	enemy_ref = ChronoProbe.restore_entity_ref("enemy", self, generation)
	if enemy_ref.is_empty():
		_restore_valid = false
		return
	effect_sequence = int(state["effectSequence"])
	pending_effects = (state["pendingEffects"] as Array).duplicate(true)
	last_processed_tick = int(state["lastProcessedTick"])
	_effect_anchors = {}
	for effect_value in pending_effects:
		var effect: Dictionary = effect_value
		var restored_event := ChronoProbe.record_pending_effect(
			"restored",
			effect,
			{},
			"",
		)
		_effect_anchors[effect["effectId"]] = restored_event


func chronorift_validate(expected: Dictionary) -> Dictionary:
	var actual := chronorift_capture()
	var matches := _restore_valid and ChronoProbe.payload_hash(actual) == ChronoProbe.payload_hash(expected)
	return {
		"participantId": PARTICIPANT_ID,
		"status": "pass" if matches else "fail",
		"stateHash": ChronoProbe.payload_hash(actual),
		"message": (
			"Entity reuse participant matches"
			if matches
			else "Entity reuse participant differs or is incomplete: actual=%s expected=%s valid=%s" % [
				JSON.stringify(actual),
				JSON.stringify(expected),
				_restore_valid,
			]
		),
	}


func _valid_checkpoint_state(state: Dictionary) -> bool:
	for key in ["health", "generation", "effectSequence", "pendingEffects", "lastProcessedTick"]:
		if not state.has(key):
			return false
	if not _is_integer_value(state["health"]) or not _is_integer_value(state["generation"]):
		return false
	if not _is_integer_value(state["effectSequence"]) or not _is_integer_value(state["lastProcessedTick"]):
		return false
	if not (state["pendingEffects"] is Array):
		return false
	var restored_generation := int(state["generation"])
	var restored_sequence := int(state["effectSequence"])
	var restored_last_tick := int(state["lastProcessedTick"])
	if restored_generation <= 0 or restored_sequence < 0 or restored_last_tick < -1:
		return false
	var effect_ids: Dictionary = {}
	for effect_value in state["pendingEffects"]:
		if not (effect_value is Dictionary):
			return false
		var effect: Dictionary = effect_value
		if not effect.has("effectId") or not (effect["effectId"] is String) or effect["effectId"].is_empty():
			return false
		var effect_id: String = effect["effectId"]
		if effect_ids.has(effect_id) or not effect_id.begins_with("damage:"):
			return false
		var effect_number := effect_id.trim_prefix("damage:")
		if not effect_number.is_valid_int() or int(effect_number) <= 0 or int(effect_number) > restored_sequence:
			return false
		effect_ids[effect_id] = true
		if not effect.has("dueTick") or not _is_integer_value(effect["dueTick"]) or int(effect["dueTick"]) <= restored_last_tick:
			return false
		if not effect.has("target") or not (effect["target"] is Dictionary):
			return false
		var target: Dictionary = effect["target"]
		if not target.has("stableId") or target["stableId"] != "enemy":
			return false
		if not target.has("incarnation") or not _is_integer_value(target["incarnation"]) or int(target["incarnation"]) != restored_generation:
			return false
	return true


func _is_integer_value(value: Variant) -> bool:
	return value is int or (value is float and is_equal_approx(value, round(value)))
