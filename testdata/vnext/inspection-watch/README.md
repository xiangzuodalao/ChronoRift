# Finite physics watch fixture

This fixture deliberately synchronizes on the first actual `observed_value`
property read. The getter's side effect is test synchronization; ChronoRift does
not expose a method call, input command, or expression capability to arm it.

For the same three-sample watch window, the scene runs this order:

1. Observer physics-frame signal: `observed_value = 42`, `recoverable = 42`.
2. Node physics callback introduces the fault.
3. Observer physics-frame signal: `observed_value = -1`, `recoverable` is absent.
4. Node physics callback repairs the fault.
5. Observer physics-frame signal: both values are `42` again.

`callback_tick` records the most recent node physics callback. The tests compare
it with the observer's tick to verify that the signal is before node callbacks,
not a frame-end observation. Polling waits for actual watch completion, without
fixed sleeps. A later `game_query` sees healthy values while the watch retains
the earlier error. Changing only `FIXED` to `true` prevents the fault in the same
window.

`Replaceable.identity` independently arms replacement in the next node physics
callback. The replacement uses the same scene path; a watch remains bound to the
original object and records invalidation. `page_payload` exercises UTF-8 paging;
`large_nested` exercises aggregate construction budgets. `exit_after_sample`
arms a normal exit after three physics callbacks so shutdown delivery can be
tested without timing a process from the Host.
`escaped_payload` fits the construction budget but expands past the encoded
single-record limit when JSON escapes its control characters.
After retrieving an actual watch page, the test queries `crash_after_sample` to
arm self-termination after two callbacks. This explicitly establishes delivery
before failure without relying on Host speed or an elapsed-time grace period.
