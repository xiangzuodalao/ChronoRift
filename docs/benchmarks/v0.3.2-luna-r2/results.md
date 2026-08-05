# ChronoRift v0.3.2 Luna formal benchmark results

- Execution: `benchmark-execution:0d6c17c8-03f1-441b-aadd-83ed2623aa9b`
- Report hash: `116a57fcc24c7e1e9493a466b6613de9cac7082648d8219575c75d3b2c84353d`
- First-execution selection hash: `906bea23e579fc37b6edab31df5570c7075a25477bb644033851944fbd2f8a96`
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
| godot-runtime-case-02 | generic | r1:missing, r2:missing, r3:invalid | 0/3 | 1 | 3 | 7 | 90458 |
| godot-runtime-case-02 | evidence-only | r1:missing, r2:missing, r3:scored | 0/3 | 1 | 2 | 5 | 40804 |
| godot-runtime-case-02 | chronorift-full | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-03 | generic | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-03 | evidence-only | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-03 | chronorift-full | r1:missing, r2:missing, r3:missing | 0/3 | 0 | 0 | 0 | 0 |
| godot-runtime-case-04 | generic | r1:missing, r2:missing, r3:scored | 0/3 | 1 | 3 | 8 | 111968 |
| godot-runtime-case-04 | evidence-only | r1:missing, r2:missing, r3:scored | 0/3 | 1 | 2 | 5 | 48854 |
| godot-runtime-case-04 | chronorift-full | r1:missing, r2:missing, r3:scored | 1/3 | 1 | 3 | 8 | 113346 |

This file is generated from `benchmark-report.v3.json`. Run `corepack pnpm benchmark:verify -- --report <path> --spec <path>` before interpreting it.
