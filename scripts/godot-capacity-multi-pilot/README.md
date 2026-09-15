# Godot capacity comparison

This profile gives complete feature tasks more execution capacity: 90 minutes per
trial, 2048 team execution calls, and 45 minutes / 512 execution calls per worker
turn. Single and Adaptive use the same model, thinking effort, coding/game tools,
and total limits. Adaptive allows zero to three direct workers. Collaboration
guidance is unchanged; the common instructions only substitute the budget values.

The implementation reuses the feature pilot's source isolation, frozen input
checks, serial process lifecycle, telemetry, candidate capture, and independent
evaluation. The original feature entry point keeps its 20-minute / 256-call
profile. Explicit resource limits produce Preview V5 with the actual limits.

Preparation supplies three ordered decisions in `prep/pr180/manifest.json`,
`prep/truck1295/manifest.json`, and `prep/gloot313/manifest.json`: template state
persistence, the Truck Town driving demo improvements, and grid inventory
occupancy maps. A listed decision may be blocked; listing does not imply eligibility.
These identify real upstream features; they do not prescribe agent roles.
Only complete tasks with passing offline controls become eligible. The final
list and evaluator are frozen before any model invocation. Selection should be
based on independent code delivery opportunities and a reliable behavioral
oracle, not observed Single/Multi wins.

Use the pinned Node 22.23.1 environment. All paths below refer to new, private
directories outside the product repository:

```bash
node --dns-result-order=ipv4first --import tsx scripts/godot-capacity-multi-pilot/run.mjs freeze --preparation /private/prep --output /private/new-batch
node --dns-result-order=ipv4first --import tsx scripts/godot-capacity-multi-pilot/run.mjs run --output /private/new-batch
node --dns-result-order=ipv4first --import tsx scripts/godot-capacity-multi-pilot/run.mjs evaluate --output /private/new-batch
node --dns-result-order=ipv4first --import tsx scripts/godot-capacity-multi-pilot/run.mjs summarize --output /private/new-batch
```

`run` intentionally invokes the configured live provider once per eligible case
and arm. Trials execute serially with alternating first arms; independent
evaluations run only after all observed writers stop. Existing output directories
are not overwritten and result-dependent model retries are not provided.

Budget cancellation is distinct from acceptance failure. A cancelled trial does
not establish natural completion speed. SDK usage reconciliation does not prove
complete billing information, and successful game operation outcomes do not by
themselves establish complete feature acceptance.
