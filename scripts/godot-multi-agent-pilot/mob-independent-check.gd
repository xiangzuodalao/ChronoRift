extends SceneTree

func _initialize() -> void:
	call_deferred("_run_check")

func _run_check() -> void:
	var mob_script: GDScript = load("res://Mob.gd")
	var observations: Array = []
	var all_accepted := true
	for seed_value in [7301, 7402, 7503]:
		seed(seed_value)
		var mob := mob_script.new() as CharacterBody3D
		var animation := AnimationPlayer.new()
		animation.name = "AnimationPlayer"
		mob.add_child(animation)
		root.add_child(mob)
		mob.initialize(Vector3(10.0, 0.0, 10.0), Vector3(-2.0, 6.0, -4.0))
		var up_alignment := mob.global_basis.y.normalized().dot(Vector3.UP)
		var horizontal_speed := Vector2(mob.velocity.x, mob.velocity.z).length()
		var accepted := up_alignment >= 0.999999 and absf(mob.velocity.y) <= 0.000001 and horizontal_speed >= float(mob.min_speed) - 0.000001 and horizontal_speed <= float(mob.max_speed) + 0.000001
		all_accepted = all_accepted and accepted
		observations.append({"seed": seed_value, "upAlignment": up_alignment, "velocityY": mob.velocity.y, "horizontalSpeed": horizontal_speed, "minSpeed": mob.min_speed, "maxSpeed": mob.max_speed})
		mob.free()
	print("CHRONORIFT_MOB_EVAL=" + JSON.stringify({"schemaVersion": 1, "observations": observations}))
	mob_script = null
	# Stop the project audio autoload before evaluator shutdown.
	var music := root.get_node_or_null("MusicPlayer") as AudioStreamPlayer
	if music != null:
		music.stop()
	await create_timer(2.1).timeout
	call_deferred("quit", 0 if all_accepted else 1)
