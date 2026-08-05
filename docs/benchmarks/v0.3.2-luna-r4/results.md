# ChronoRift v0.3.2 Luna formal benchmark results

- Execution: `benchmark-execution:22c2dee9-e508-41fe-b0db-2e90de8a2b7b`
- Report hash: `7aef5376cca43bfd01bdef8ca46b73357c9d5608c83295ba9812de80dd897b2f`
- First-execution selection hash: `fd5faf448e71cbd8156ca4c202f70dc9074b67b32830634f796ba722e463eaf0`
- Status: **complete**
- Gate: **fail**
- Frozen metric set: `grounded-diagnosis-v3`
- Score eligibility: 36/36 cells; infrastructure-unavailable cells remain unscored.

| Arm | Score eligible | Infra unavailable | Grounded success | Mechanism accuracy | Incorrect confirmations | Game executions | Tool calls | Tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Generic | 12/12 | 0 | 6/12 | 91.7% | 0 | 36 | 85 | 1103071 |
| Evidence only | 12/12 | 0 | 0/12 | 83.3% | 0 | 24 | 60 | 540781 |
| ChronoRift full | 12/12 | 0 | 6/12 | 75.0% | 0 | 36 | 94 | 1213944 |

## Fixture × arm breakdown

| Fixture | Arm | Terminal status by repetition | Grounded | Attempts | Game executions | Tool calls | Tokens |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| godot-runtime-case-01 | generic | r1:scored, r2:scored, r3:scored | 3/3 | 3 | 9 | 21 | 210301 |
| godot-runtime-case-01 | evidence-only | r1:scored, r2:scored, r3:scored | 0/3 | 3 | 6 | 15 | 105374 |
| godot-runtime-case-01 | chronorift-full | r1:scored, r2:diagnostic_failure, r3:scored | 2/3 | 3 | 9 | 22 | 217459 |
| godot-runtime-case-02 | generic | r1:scored, r2:scored, r3:scored | 1/3 | 3 | 9 | 21 | 282667 |
| godot-runtime-case-02 | evidence-only | r1:scored, r2:scored, r3:scored | 0/3 | 3 | 6 | 15 | 124877 |
| godot-runtime-case-02 | chronorift-full | r1:scored, r2:scored, r3:scored | 2/3 | 3 | 9 | 24 | 311940 |
| godot-runtime-case-03 | generic | r1:scored, r2:scored, r3:scored | 0/3 | 3 | 9 | 21 | 313180 |
| godot-runtime-case-03 | evidence-only | r1:scored, r2:diagnostic_failure, r3:scored | 0/3 | 3 | 6 | 15 | 165943 |
| godot-runtime-case-03 | chronorift-full | r1:scored, r2:scored, r3:scored | 1/3 | 3 | 9 | 24 | 350039 |
| godot-runtime-case-04 | generic | r1:diagnostic_failure, r2:scored, r3:scored | 2/3 | 3 | 9 | 22 | 296923 |
| godot-runtime-case-04 | evidence-only | r1:scored, r2:diagnostic_failure, r3:scored | 0/3 | 3 | 6 | 15 | 144587 |
| godot-runtime-case-04 | chronorift-full | r1:diagnostic_failure, r2:diagnostic_failure, r3:scored | 1/3 | 3 | 9 | 24 | 334506 |

This file is generated from `benchmark-report.v3.json`. Run `corepack pnpm benchmark:verify -- --report <path> --spec <path>` before interpreting it.
