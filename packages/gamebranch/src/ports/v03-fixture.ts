import type {
  CheckpointContent,
  ExperimentCandidateV1,
  FixtureId,
  FrozenContractV2,
  InputTraceV2,
  JsonPrimitive,
  MechanismCodeV2,
  BranchControls,
} from "@chronorift/domain";

export interface V03FixtureDefinition {
  readonly fixtureId: FixtureId;
  readonly contractInput: Omit<FrozenContractV2, "contractId">;
  readonly initialCheckpointContent: CheckpointContent;
  readonly inputTrace: InputTraceV2;
  readonly baselineControls: BranchControls;
  readonly probeProperties: readonly string[];
  readonly experiments: readonly ExperimentCandidateV1[];
  readonly fixtureControlDefaults: Readonly<Record<string, JsonPrimitive>>;
  readonly checkpointLimitations: readonly string[];
}

/** This oracle is benchmark-only and must never enter Agent-facing data. */
export interface V03BenchmarkOracle {
  readonly fixtureId: FixtureId;
  readonly mechanismCode: Exclude<MechanismCodeV2, "unknown">;
  readonly sourcePath: string;
  readonly sourceSymbol: string;
}
