extends Control

const PARTICIPANT_ID := "switch-door"


func _ready() -> void:
	ChronoProbe.register_checkpoint_participant(PARTICIPANT_ID, self)


func _process(_delta: float) -> void:
	$Status.text = "switch.active=%s | receiver_connected=%s | door.open=%s" % [
		$Switch.active,
		$Door.receiver_connected,
		$Door.open,
	]


func chronorift_capture() -> Dictionary:
	return {
		"switchActive": $Switch.active,
		"doorOpen": $Door.open,
		"receiverConnected": $Door.receiver_connected,
		"initializationPending": $Door.initialization_pending,
	}


func chronorift_restore(state: Dictionary) -> void:
	$Switch.active = bool(state.get("switchActive", false))
	$Switch.disabled = $Switch.active
	$Switch.text = "Switch ACTIVE" if $Switch.active else "Activate Switch\n(Space)"
	$Door.chronorift_set_state({
		"open": state.get("doorOpen", false),
		"receiverConnected": state.get("receiverConnected", false),
		"initializationPending": state.get("initializationPending", true),
	})


func chronorift_validate(expected: Dictionary) -> Dictionary:
	var actual := chronorift_capture()
	var matches := ChronoProbe.payload_hash(actual) == ChronoProbe.payload_hash(expected)
	return {
		"participantId": PARTICIPANT_ID,
		"status": "pass" if matches else "fail",
		"stateHash": ChronoProbe.payload_hash(actual),
		"message": "Fixture participant state matches" if matches else "Fixture participant state differs",
	}
