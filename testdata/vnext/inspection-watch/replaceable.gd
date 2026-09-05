extends Node

var _replace_requested := false
var identity: String:
	get:
		_replace_requested = true
		return "original"

func _physics_process(_delta: float) -> void:
	if not _replace_requested:
		return
	var replacement := Node.new()
	replacement.name = name
	var parent := get_parent()
	parent.remove_child(self)
	parent.add_child(replacement)
	queue_free()
