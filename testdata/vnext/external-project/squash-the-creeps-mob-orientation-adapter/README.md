# Squash the Creeps Mob orientation adapter

This fixed ProjectAdapter V2 is scoped to `3d/squash_the_creeps` at upstream
commit `711822a319c4333a8740522f3c71e97783199fb0`. It passively identifies nodes
whose attached script is `res://Mob.gd` and emits one state-only observation of
their realized orientation and velocity after project initialization.

It does not inject input, reload scenes, manufacture events, label a cause or
fix, or modify project source. Entity identities are execution-local Godot
instance IDs. The projection is limited to the default `Main.tscn` scene and
the source-derived `Player` and `Mob.gd` semantics.
