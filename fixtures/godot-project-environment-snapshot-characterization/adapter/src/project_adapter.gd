extends ChronoRiftProjectAdapterV1


class EntityProjection extends ChronoRiftEntityProjectionV1:
	func sample(current_scene: Node) -> Array:
		return [{
			"entityId": "scene.root",
			"entityTypeId": "root",
			"incarnation": 1,
			"identityScope": "execution_local",
			"projection": {"name": str(current_scene.name)},
		}]


class StateProjection extends ChronoRiftStateProjectionV1:
	func sample(current_scene: Node) -> Array:
		return [{
			"stateDomainId": "world",
			"value": {"counter": int(current_scene.counter)},
			"semanticCoverage": "declared",
		}]


class EventProjection extends ChronoRiftEventProjectionV1:
	func drain(_current_scene: Node) -> Array:
		return []


class InputControl extends ChronoRiftInputControlV1:
	func apply(current_scene: Node, request: Dictionary) -> Dictionary:
		if str(request.get("controlId", "")) != "characterization.set_counter":
			return {
				"status": "rejected",
				"realizedParameters": request.get("parameters", {}),
				"knownSideEffects": [],
			}
		var parameters: Variant = request.get("parameters")
		if not parameters is Dictionary or not parameters.has("counter"):
			return {"status": "rejected", "realizedParameters": {}, "knownSideEffects": []}
		var counter := int(parameters.get("counter"))
		current_scene.set_characterization_counter(counter)
		return {
			"status": "applied",
			"realizedParameters": {"counter": counter},
			"knownSideEffects": [],
		}


class Snapshot extends ChronoRiftSnapshotV1:
	func capture(current_scene: Node) -> Dictionary:
		return {"world": {"counter": int(current_scene.counter)}}


class Restore extends ChronoRiftRestoreV1:
	func restore(current_scene: Node, snapshot: Dictionary) -> Dictionary:
		var world: Variant = snapshot.get("world")
		if not world is Dictionary or not world.has("counter"):
			return {
				"writtenDomains": [],
				"failedDomains": ["world"],
				"knownSideEffects": {},
			}
		current_scene.set_characterization_counter(int(world.get("counter")))
		return {
			"writtenDomains": ["world"],
			"failedDomains": [],
			"knownSideEffects": {"world": []},
		}


func create_modules() -> Dictionary:
	return {
		"entity_projection": EntityProjection.new(),
		"state_projection": StateProjection.new(),
		"event_projection": EventProjection.new(),
		"input_control": InputControl.new(),
		"snapshot": Snapshot.new(),
		"restore": Restore.new(),
	}
