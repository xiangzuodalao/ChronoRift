extends Node

signal left_ledge

const PARTICIPANT_ID := "case-02-state"
const COYOTE_WINDOW_FRAMES := 8

var started := false
var jumping := false
var window_open := false
var left_frame := -1
var process_callbacks := 0


func _ready() -> void:
	ChronoProbe.register_entity("player", self)
	ChronoProbe.register_state_property("player.jumping", self, "jumping")
	ChronoProbe.register_state_property("player.window_open", self, "window_open")
	ChronoProbe.register_state_property("player.process_callbacks", self, "process_callbacks")
	ChronoProbe.register_checkpoint_participant(PARTICIPANT_ID, self)
	ChronoProbe.connect_observed_signal(
		self,
		"left_ledge",
		_on_left_ledge,
		"player",
		"player.left_ledge",
		"player",
	)


func _on_left_ledge() -> void:
	ChronoProbe.record_signal_delivery("player", "player.left_ledge", "player")


func _process(_delta: float) -> void:
	if not ChronoProbe.execution_active:
		return
	process_callbacks += 1
	if not started:
		started = true
		left_frame = 0
		var window_event := ChronoProbe.record_transition("player.window_open", false, true)
		window_open = true
		ChronoProbe.emit_observed_signal(
			self,
			"left_ledge",
			"player",
			"player.left_ledge",
			"player",
			window_event,
		)
	else:
		left_frame += 1
	if window_open and left_frame > COYOTE_WINDOW_FRAMES:
		window_open = false
		ChronoProbe.record_transition("player.window_open", true, false)


func _input(event: InputEvent) -> void:
	if not (event is InputEventAction and event.action == "attempt_jump" and event.pressed):
		return
	var input_event := ChronoProbe.consume_input_local_id(event.action)
	if not window_open:
		return
	var before := jumping
	jumping = true
	ChronoProbe.record_transition("player.jumping", before, true, input_event)


func chronorift_capture() -> Dictionary:
	return {
		"started": started,
		"jumping": jumping,
		"windowOpen": window_open,
		"leftFrame": left_frame,
		"processCallbacks": process_callbacks,
	}


func chronorift_restore(state: Dictionary) -> void:
	started = bool(state.get("started", false))
	jumping = bool(state.get("jumping", false))
	window_open = bool(state.get("windowOpen", false))
	left_frame = int(state.get("leftFrame", -1))
	process_callbacks = int(state.get("processCallbacks", 0))


func chronorift_validate(expected: Dictionary) -> Dictionary:
	var actual := chronorift_capture()
	var matches := ChronoProbe.payload_hash(actual) == ChronoProbe.payload_hash(expected)
	return {
		"participantId": PARTICIPANT_ID,
		"status": "pass" if matches else "fail",
		"stateHash": ChronoProbe.payload_hash(actual),
		"message": "Frame input participant matches" if matches else "Frame input participant differs",
	}
