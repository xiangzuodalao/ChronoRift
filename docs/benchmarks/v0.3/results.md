# ChronoRift v0.3 formal benchmark results

- Execution: `benchmark-execution:bd9b5d3a-5e3f-4e86-9d70-0098925aade5`
- Report hash: `d58b4b9525a370f2f13731a49df9f2dbe926f2e03c12a8687550b07d55e2d430`
- First-execution selection hash: `9365af39d0f61d011ee9b85735f2518cbc097202d60af92517a56782280275e2`
- Status: **complete**
- Gate: **fail**
- Frozen metric set: `grounded-diagnosis-v2`

| Arm | Grounded success | Mechanism accuracy | Incorrect confirmations | Game executions | Tool calls | Tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Generic | 0/12 | 0.0% | 0 | 12 | 0 | 0 |
| Evidence only | 0/12 | 0.0% | 0 | 12 | 0 | 0 |
| ChronoRift full | 0/12 | 0.0% | 0 | 12 | 0 | 0 |

## Fixture × arm breakdown

| Fixture | Arm | Terminal status by repetition | Grounded | Mechanism correct | Confirmed | Attempts | Game executions | Tool calls | Tokens |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| godot-runtime-case-01 | generic | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-01 | evidence-only | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-01 | chronorift-full | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-02 | generic | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-02 | evidence-only | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-02 | chronorift-full | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-03 | generic | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-03 | evidence-only | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-03 | chronorift-full | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-04 | generic | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-04 | evidence-only | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-04 | chronorift-full | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |

This file is generated from `benchmark-report.v2.json`. Run `corepack pnpm benchmark:verify -- --report <path>` before interpreting it.
