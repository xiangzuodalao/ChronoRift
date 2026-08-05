# ChronoRift v0.3 formal benchmark results

- Execution: `benchmark-execution:e16b8aa7-2f63-444b-9aec-bfcc3aeb426d`
- Report hash: `cfb29c7878500dcbd7ac0cbd3683fdf52362088ea26d7bf55573e11227f4457a`
- First-execution selection hash: `9847e1b19475464c0a7dce2bd1dd846435f8e9b2f99c36257da13868ee40e236`
- Status: **complete**
- Gate: **fail**
- Frozen metric set: `grounded-diagnosis-v2`

| Arm | Grounded success | Mechanism accuracy | Incorrect confirmations | Game executions | Tool calls | Tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Generic | 0/12 | 0.0% | 0 | 12 | 66 | 1379780 |
| Evidence only | 0/12 | 0.0% | 0 | 12 | 24 | 245515 |
| ChronoRift full | 0/12 | 0.0% | 0 | 12 | 56 | 901886 |

## Fixture × arm breakdown

| Fixture | Arm | Terminal status by repetition | Grounded | Mechanism correct | Confirmed | Attempts | Game executions | Tool calls | Tokens |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| godot-runtime-case-01 | generic | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-01 | evidence-only | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-01 | chronorift-full | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-02 | generic | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 49 | 1238769 |
| godot-runtime-case-02 | evidence-only | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 24 | 245515 |
| godot-runtime-case-02 | chronorift-full | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 56 | 901886 |
| godot-runtime-case-03 | generic | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-03 | evidence-only | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-03 | chronorift-full | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-04 | generic | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 17 | 141011 |
| godot-runtime-case-04 | evidence-only | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |
| godot-runtime-case-04 | chronorift-full | r1:diagnostic_failure, r2:diagnostic_failure, r3:diagnostic_failure | 0/3 | 0/3 | 0/3 | 3 | 3 | 0 | 0 |

This file is generated from `benchmark-report.v2.json`. Run `corepack pnpm benchmark:verify -- --report <path>` before interpreting it.
