# ChronoRift v0.3.2 Luna formal benchmark results

- Execution: `benchmark-execution:3207d7d4-9e14-40bc-bca0-840897416739`
- Report hash: `ef08aa6a727093ce8b9741d188a5b0b2bdbb0240e82a6a39d1265cb42e28b77d`
- First-execution selection hash: `c869f64755c7cd1a871ba05263d7d75aa4acee786653d9976b8ef6624442c6e3`
- Status: **invalid**
- Gate: **not_evaluated**
- Frozen metric set: `grounded-diagnosis-v3`
- Score eligibility: 0/36 cells; infrastructure-unavailable cells remain unscored.

No aggregate is available for an incomplete or invalid execution.

## Fixture × arm breakdown

| Fixture | Arm | Terminal status by repetition | Grounded | Attempts | Game executions | Tool calls | Tokens |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| godot-runtime-case-01 | generic | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-01 | evidence-only | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-01 | chronorift-full | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-02 | generic | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-02 | evidence-only | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-02 | chronorift-full | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-03 | generic | r1:missing, r2:invalid, r3:missing | 0/3 | 1 | 3 | 7 | 109589 |
| godot-runtime-case-03 | evidence-only | r1:missing, r2:scored, r3:missing | 0/3 | 1 | 2 | 5 | 55781 |
| godot-runtime-case-03 | chronorift-full | r1:missing, r2:scored, r3:missing | 0/3 | 1 | 3 | 8 | 128387 |
| godot-runtime-case-04 | generic | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-04 | evidence-only | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-04 | chronorift-full | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |

This file is generated from `benchmark-report.v3.json`. Run `corepack pnpm benchmark:verify -- --report <path> --spec <path>` before interpreting it.
