extends ColorRect

@export var switch_path: NodePath

var open := false
var receiver_connected := false
var initialization_pending := true


func _ready() -> void:
	ChronoProbe.register_entity("door", self)
	ChronoProbe.register_state_property("door.open", self, "open")
	ChronoProbe.register_state_property("door.receiver_connected", self, "receiver_connected")


func _process(_delta: float) -> void:
	if (
		not ChronoProbe.execution_active
		or Engine.get_process_frames() <= ChronoProbe.step_activation_frame
		or not initialization_pending
	):
		return
	initialization_pending = false
	var switch_node: Node = get_node(switch_path)
	ChronoProbe.connect_observed_signal(
		switch_node,
		"activated",
		_on_activated,
		"switch",
		"switch.activated",
		"door",
	)
	var before := receiver_connected
	receiver_connected = true
	ChronoProbe.record_transition("door.receiver_connected", before, true)


func _on_activated() -> void:
	var delivery_event := ChronoProbe.record_signal_delivery(
		"switch",
		"switch.activated",
		"door",
	)
	if open:
		return
	var before := open
	open = true
	color = Color(0.12, 0.58, 0.2, 1.0)
	$DoorLabel.text = "OPEN"
	ChronoProbe.record_transition("door.open", before, true, delivery_event)


func chronorift_set_state(state: Dictionary) -> void:
	open = bool(state.get("open", false))
	receiver_connected = bool(state.get("receiverConnected", false))
	initialization_pending = bool(state.get("initializationPending", true))
	var switch_node: Node = get_node(switch_path)
	var callback := Callable(self, "_on_activated")
	if switch_node.is_connected("activated", callback):
		switch_node.disconnect("activated", callback)
	if receiver_connected:
		ChronoProbe.connect_observed_signal(
			switch_node,
			"activated",
			callback,
			"switch",
			"switch.activated",
			"door",
		)
	color = Color(0.12, 0.58, 0.2, 1.0) if open else Color(0.5, 0.13, 0.13, 1.0)
	$DoorLabel.text = "OPEN" if open else "CLOSED"
