extends Node

# Injected only into independent read-only acceptance stages, never candidates.
# Node callbacks with default physics priority run first; this observer runs at
# priority 1,000,000. This is after those callbacks, not a physics_frame signal.
const SAMPLE_COUNT := 360
const CONFIGURATIONS := [
	{"name": "default", "capacity": 100, "increment": 7, "cycle_length": 120},
	{"name": "smaller_capacity", "capacity": 40, "increment": 6, "cycle_length": 120},
	{"name": "increment_above_capacity", "capacity": 1, "increment": 2, "cycle_length": 120},
]
var scenarios: Array[Dictionary] = []
var subjects: Array[Node] = []
var observed_ticks := 0

func _ready() -> void:
	process_physics_priority = 1000000
	set_physics_process(false)
	call_deferred("_setup")

func _setup() -> void:
	var original := get_tree().current_scene
	if original == null:
		push_error("Independent checker has no main scene")
		get_tree().quit(2)
		return
	original.process_mode = Node.PROCESS_MODE_DISABLED
	var packed: PackedScene = load(original.scene_file_path)
	for configuration in CONFIGURATIONS:
		var subject := packed.instantiate()
		# Set exported parameters before _ready and the first physics callback.
		subject.set("capacity", configuration.capacity)
		subject.set("recharge_per_tick", configuration.increment)
		subject.set("cycle_length_ticks", configuration.cycle_length)
		get_tree().root.add_child(subject)
		subjects.append(subject)
		scenarios.append({"configuration": configuration, "samples": []})
	set_physics_process(true)

func _physics_process(_delta: float) -> void:
	observed_ticks += 1
	for index in range(subjects.size()):
		var subject := subjects[index]
		var sample := {"ordinal": observed_ticks, "physics_tick": Engine.get_physics_frames(),
			"process_frame": Engine.get_process_frames(), "instance_id": str(subject.get_instance_id()),
			"charge": subject.get("charge"), "capacity": subject.get("capacity"),
			"increment": subject.get("recharge_per_tick"), "cycle_length": subject.get("cycle_length_ticks"),
			"phase": subject.get("phase"), "elapsed_ticks": subject.get("elapsed_ticks"),
			"completed_cycles": subject.get("completed_cycles"),
			"physics_processing": subject.is_physics_processing(),
			"physics_priority": subject.process_physics_priority}
		scenarios[index].samples.append(sample)
	if observed_ticks == SAMPLE_COUNT:
		print("CAPACITOR_CHECK_OBSERVATIONS " + JSON.stringify({"schema_version": 1,
			"phase": "checker_physics_process_after_subject_callbacks", "checker_physics_priority": process_physics_priority,
			"scenarios": scenarios}))
		set_physics_process(false)
		get_tree().quit(0)
