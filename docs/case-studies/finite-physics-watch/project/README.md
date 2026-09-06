# Capacitor recharge

This small Godot project automatically discharges a capacitor every 120 physics
ticks, then recharges it by `recharge_per_tick` units per tick. It needs no input.

`charge` should stay between zero and `capacity`, reach capacity, and remain ready
until the next automatic discharge. The root node exposes `charge`, `phase`,
`elapsed_ticks`, and `completed_cycles`. Capacity, recharge increment, and cycle
length are exported configuration values. Keep repeated discharge and recharge
working when correcting the reported transient state.

Run with Godot 4: `godot --headless --path .`.
