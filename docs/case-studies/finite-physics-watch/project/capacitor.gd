extends Node

@export var capacity := 100
@export var recharge_per_tick := 7
@export var cycle_length_ticks := 120

var charge := 100
var phase := "ready"
var elapsed_ticks := 0
var completed_cycles := 0

func _ready() -> void:
	charge = capacity

func _physics_process(_delta: float) -> void:
	elapsed_ticks += 1
	var cycle_tick := (elapsed_ticks - 1) % cycle_length_ticks + 1
	if cycle_tick == 1:
		charge = 0
		phase = "charging"
	elif phase == "charging":
		if charge >= capacity:
			charge = capacity
			phase = "ready"
			completed_cycles += 1
		else:
			charge += recharge_per_tick
