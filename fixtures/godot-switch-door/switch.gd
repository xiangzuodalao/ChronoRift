extends Button

signal activated

var active := false


func _ready() -> void:
	ChronoProbe.register_entity("switch", self)
	pressed.connect(_activate)


func _input(event: InputEvent) -> void:
	if event is InputEventAction and event.action == "interact_switch" and event.pressed:
		_activate(ChronoProbe.consume_input_local_id(event.action))


func _activate(caused_by := "") -> void:
	if active:
		return
	var before := active
	active = true
	disabled = true
	text = "Switch ACTIVE"
	var property_event := ChronoProbe.record_transition(
		"switch.active",
		before,
		active,
		caused_by if not caused_by.is_empty() else ChronoProbe.current_input_local_id(),
	)
	ChronoProbe.emit_observed_signal(
		self,
		"activated",
		"switch",
		"switch.activated",
		"door",
		property_event,
	)
