import type {
  BranchControls,
  CheckpointContent,
  ClaimPolicyManifestV1,
  ExperimentCandidateV1,
  FixtureId,
  FrozenContractBundleV3,
  InputTraceV2,
  InvestigationId,
  JsonPrimitive,
  Sha256Hex,
} from "@chronorift/domain";

/**
 * Engine-neutral, immutable input for one v0.4 investigation. The legacy
 * `FixtureId` is retained only as the subject identity required by v2 runtime
 * artifacts; Agent-facing APIs are scoped by `investigationId` instead.
 */
export interface InvestigationSpecV1 {
  readonly schemaVersion: 1;
  readonly investigationId: InvestigationId;
  readonly executionSubjectId: FixtureId;
  readonly contract: FrozenContractBundleV3;
  readonly claimPolicyManifest: ClaimPolicyManifestV1;
  readonly initialCheckpointContent: CheckpointContent;
  readonly inputTrace: InputTraceV2;
  readonly baselineControls: BranchControls;
  readonly probeProperties: readonly string[];
  readonly interventions: readonly ExperimentCandidateV1[];
  readonly experimentBudget: {
    readonly maxInterventions: number;
  };
  readonly runtimeControlDefaults: Readonly<Record<string, JsonPrimitive>>;
  readonly checkpointLimitations: readonly string[];
  readonly fingerprint: {
    readonly repositoryId: string;
    readonly sourceTreeHash: Sha256Hex;
    readonly gitRevision: string | null;
    readonly dirtyPatchHash: Sha256Hex | null;
    readonly gameBuildHash: Sha256Hex;
    readonly importCacheHash: Sha256Hex | null;
    readonly physicsEngine: string;
    readonly pluginVersion: string;
    readonly inputMapHash: Sha256Hex;
    readonly probeProfileHash: Sha256Hex;
    readonly telemetrySchemaHash: Sha256Hex;
  };
}
