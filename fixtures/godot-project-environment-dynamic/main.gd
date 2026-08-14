extends Node

class DynamicThing extends Node:
	signal level_changed(level: int)
	var level := 0

	func chronorift_fixture_stable_id() -> String:
		return "dynamic.actor"

	func pulse() -> void:
		level += 1
		level_changed.emit(level)

var _frame := 0
var _thing: DynamicThing

func _process(_delta: float) -> void:
	_frame += 1
	if _frame == 30:
		_spawn()
	elif _frame == 32:
		_thing.pulse()
	elif _frame == 34:
		_thing.queue_free()
	elif _frame == 38:
		_spawn()
	elif _frame == 40:
		_thing.pulse()

func _spawn() -> void:
	_thing = DynamicThing.new()
	_thing.name = "DynamicThing"
	add_child(_thing)
