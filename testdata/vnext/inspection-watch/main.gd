extends Node

const FIXED := false

var _armed := false
var _transition := 0
var _value := 42
var _exit_armed := false
var _exit_callbacks := 0
var _crash_armed := false
var _crash_callbacks := 0
var callback_tick := -1
var precise_value := 0.12345678901234566
var escaped_small := String.chr(1) + "\t\n"
var observed_value: int:
	get:
		# Fixture synchronization only: the first actual value read starts the
		# transient. Registration and metadata inspection do not start it.
		_armed = true
		return _value
var exit_after_sample: bool:
	get:
		_exit_armed = true
		return true
var crash_after_sample: bool:
	get:
		_crash_armed = true
		return true
var page_payload := "page:" + "界".repeat(300)
var escaped_payload := String.chr(1).repeat(6000)
var large_nested: Array = []

func _ready() -> void:
	for index in range(128):
		large_nested.append({"index": index, "text": "x".repeat(16000)})
	var replaceable := preload("res://replaceable.gd").new()
	replaceable.name = "Replaceable"
	add_child(replaceable)

func _get_property_list() -> Array[Dictionary]:
	if FIXED or _transition != 1:
		return [{"name": "recoverable", "type": TYPE_INT}]
	return []

func _get(property: StringName) -> Variant:
	if property == &"recoverable" and (FIXED or _transition != 1):
		return 42
	return null

func _physics_process(_delta: float) -> void:
	callback_tick = Engine.get_physics_frames()
	if _armed:
		if _transition == 0:
			_transition = 1
			_value = 42 if FIXED else -1
			notify_property_list_changed()
		elif _transition == 1:
			_transition = 2
			_value = 42
			notify_property_list_changed()
	if _exit_armed:
		_exit_callbacks += 1
		if _exit_callbacks == 3:
			get_tree().quit()
	if _crash_armed:
		_crash_callbacks += 1
		if _crash_callbacks == 2:
			OS.kill(OS.get_process_id())
