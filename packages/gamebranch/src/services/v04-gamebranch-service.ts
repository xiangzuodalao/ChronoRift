import {
  CheckpointSchema,
  ClaimPolicyManifestV1Schema,
  DiagnosisProposalV4Schema,
  DiagnosisVerdictV3Schema,
  EvidenceAccessReceiptV2Schema,
  EvidenceCapsuleV2Schema,
  ExecutionFingerprintV2Schema,
  ExperimentReservationV1Schema,
  FrozenContractBundleV3Schema,
  InputTraceV2Schema,
  V03BranchSpecSchema,
  V03ExecutionComparisonSchema,
  V03ExecutionLogSchema,
  asClaimPolicyId,
  asVerdictId,
  type ArtifactReferenceV4,
  type BranchId,
  type Checkpoint,
  type ContractId,
  type DiagnosisProposalV4,
  type DiagnosisVerdictV3,
  type EvidenceAccessReceiptV2,
  type EvidenceCapsuleV2,
  type ExecutionFingerprintV2,
  type ExecutionId,
  type FrozenContractBundleV3,
  type InterventionId,
  type JsonObject,
  type JsonValue,
  type RunId,
  type Sha256Hex,
  type V03BranchSpec,
  type V03ExecutionComparison,
  type V03ExecutionLog,
} from "@chronorift/domain";

import type { V04ArtifactRepositoryPort } from "../ports/v04-artifact-repository.js";
import type { InvestigationSpecV1 } from "../ports/v04-investigation.js";
import type { GameEnvironmentFactoryPort } from "../ports/game-environment.js";
import type { ClockPort } from "../ports/support.js";
import type { V03FixtureDefinition } from "../ports/v03-fixture.js";
import { ClaimEvidencePolicyRegistryError } from "./claim-evidence-policy.js";
import type {
  ClaimEvidencePolicyRegistry,
  ClaimPolicyAgentDescriptor,
} from "./claim-evidence-policy.js";
import { jsonEqual } from "./canonical.js";
import {
  V03GameBranchService,
  v03TimelineDigest,
  type V03IdGeneratorPort,
} from "./v03-gamebranch-service.js";
import {
  v04ContentHash,
  v04ComparisonBasisContent,
  v04ClaimPolicyManifestFor,
  v04ClaimPolicyManifestHash,
  v04ContractBundleHash,
  v04ContractIdFor,
  v04EvidenceAccessReceiptIdFor,
  v04ExperimentReservationIdFor,
  v04FingerprintSemanticContent,
} from "./v04-canonical.js";

export class V04GameBranchError extends Error {
  public override readonly name = "V04GameBranchError";

  public constructor(
    public readonly code:
      | "INVALID_INVESTIGATION"
      | "INVALID_FINGERPRINT"
      | "INVALID_RESERVATION"
      | "INVALID_PROPOSAL",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface V04InitializedInvestigation {
  readonly contract: FrozenContractBundleV3;
  readonly executionContractId: ContractId;
  readonly checkpoint: Checkpoint;
  readonly branch: V03BranchSpec;
}

const asSha = (value: string): Sha256Hex => value;

const policyManifestMatches = (
  spec: InvestigationSpecV1,
  policies: ClaimEvidencePolicyRegistry,
): boolean => {
  const manifest = ClaimPolicyManifestV1Schema.parse(spec.claimPolicyManifest);
  return (
    manifest.manifestHash === v04ClaimPolicyManifestHash(manifest) &&
    jsonEqual(
      manifest as unknown as JsonValue,
      v04ClaimPolicyManifestFor(policies.descriptors()) as unknown as JsonValue,
    )
  );
};

const assertInvestigationSpec = (
  spec: InvestigationSpecV1,
  policies: ClaimEvidencePolicyRegistry,
): void => {
  const contract = FrozenContractBundleV3Schema.parse(spec.contract);
  if (
    contract.contractId !==
    v04ContractIdFor({
      schemaVersion: contract.schemaVersion,
      contractVersion: contract.contractVersion,
      scope: contract.scope,
      authority: contract.authority,
      evaluator: contract.evaluator,
      rule: contract.rule,
    })
  ) {
    throw new V04GameBranchError(
      "INVALID_INVESTIGATION",
      "The frozen Contract bundle has an invalid content-addressed ID",
    );
  }
  if (
    contract.scope.fixtureId !== undefined &&
    contract.scope.fixtureId !== spec.executionSubjectId
  ) {
    throw new V04GameBranchError(
      "INVALID_INVESTIGATION",
      "The Contract scope does not match the runtime execution subject",
    );
  }
  if (
    spec.interventions.length !== 2 ||
    !Number.isInteger(spec.experimentBudget.maxInterventions) ||
    spec.experimentBudget.maxInterventions <= 0 ||
    spec.experimentBudget.maxInterventions > spec.interventions.length
  ) {
    throw new V04GameBranchError(
      "INVALID_INVESTIGATION",
      "The current v2 runtime compatibility adapter requires two catalog entries and a positive budget no larger than the catalog",
    );
  }
  if (
    new Set(spec.interventions.map((entry) => entry.interventionId)).size !==
    spec.interventions.length
  ) {
    throw new V04GameBranchError(
      "INVALID_INVESTIGATION",
      "Intervention IDs must be unique",
    );
  }
  if (!policyManifestMatches(spec, policies)) {
    throw new V04GameBranchError(
      "INVALID_INVESTIGATION",
      "The Claim Policy manifest does not match the active registry",
    );
  }
};

const toV03Fixture = (spec: InvestigationSpecV1): V03FixtureDefinition => ({
  fixtureId: spec.executionSubjectId,
  contractInput: {
    schemaVersion: 2,
    fixtureId: spec.executionSubjectId,
    authority: {
      status: "frozen",
      approvedBy: `${spec.contract.authority.approvedBy} via ${spec.contract.contractId}`,
    },
    rule: spec.contract.rule,
  },
  initialCheckpointContent: spec.initialCheckpointContent,
  inputTrace: spec.inputTrace,
  baselineControls: spec.baselineControls,
  probeProperties: spec.probeProperties,
  experiments: spec.interventions,
  fixtureControlDefaults: spec.runtimeControlDefaults,
  checkpointLimitations: spec.checkpointLimitations,
});

const healthy = (execution: V03ExecutionLog): boolean =>
  execution.controlReceipt.accepted &&
  jsonEqual(
    execution.controlReceipt.requested,
    execution.controlReceipt.realized,
  ) &&
  execution.observationHealth.droppedEvents === 0 &&
  execution.observationHealth.truncatedEvents === 0 &&
  !execution.observationHealth.backpressure &&
  execution.timelineDigest ===
    v03TimelineDigest(execution.events, execution.finalState);

/**
 * v0.4 compatibility engine. It reuses the proven v2 runtime executor while
 * adding investigation scope, mandatory fingerprints, durable reservations,
 * open claim policies, and a benchmark-neutral Conclusion Gate.
 */
export class V04GameBranchService {
  readonly #legacy: V03GameBranchService;
  #reservationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly repository: V04ArtifactRepositoryPort,
    environments: GameEnvironmentFactoryPort,
    private readonly spec: InvestigationSpecV1,
    private readonly policies: ClaimEvidencePolicyRegistry,
    private readonly ids: V03IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {
    assertInvestigationSpec(spec, policies);
    this.#legacy = new V03GameBranchService(
      repository,
      environments,
      toV03Fixture(spec),
      ids,
      clock,
    );
  }

  public async initialize(runId: RunId): Promise<V04InitializedInvestigation> {
    await this.repository.putContractBundle(this.spec.contract);
    const initialized = await this.#legacy.initialize(runId);
    if (
      !jsonEqual(
        initialized.contract.rule as unknown as JsonValue,
        this.spec.contract.rule as unknown as JsonValue,
      )
    ) {
      throw new V04GameBranchError(
        "INVALID_INVESTIGATION",
        "The executable Contract adapter changed the frozen rule",
      );
    }
    return {
      contract: this.spec.contract,
      executionContractId: initialized.contract.contractId,
      checkpoint: initialized.checkpoint,
      branch: initialized.branch,
    };
  }

  public listInterventions() {
    return this.#legacy.listExperiments();
  }

  /** Agent-visible claim shapes for the active, hash-bound policy registry. */
  public listClaimPolicyContracts(): readonly ClaimPolicyAgentDescriptor[] {
    return this.policies.agentDescriptors();
  }

  private async fingerprint(
    execution: V03ExecutionLog,
  ): Promise<ExecutionFingerprintV2> {
    const branch = V03BranchSpecSchema.parse(
      await this.repository.getBranch(execution.branchId),
    );
    const trace = InputTraceV2Schema.parse(
      await this.repository.getInputTrace(execution.inputTraceId),
    );
    const checkpoint = CheckpointSchema.parse(
      await this.repository.getCheckpoint(execution.startCheckpointId),
    );
    const runtime = execution.runtimeFingerprint;
    const certificate = checkpoint.content.certificate;
    if (runtime === undefined || certificate === undefined) {
      throw new V04GameBranchError(
        "INVALID_FINGERPRINT",
        "v0.4 requires runtime and checkpoint-certificate provenance",
      );
    }
    const intervention =
      branch.branchKind === "intervention"
        ? {
            interventionId: branch.interventionId,
            specification: branch.intervention as unknown as JsonObject,
          }
        : { interventionId: null, specification: null };
    const content: Omit<
      ExecutionFingerprintV2,
      "fingerprintHash" | "comparisonBasisHash"
    > = {
      schemaVersion: 2,
      executionId: execution.executionId,
      runId: execution.runId,
      investigationId: this.spec.investigationId,
      source: {
        repositoryId: this.spec.fingerprint.repositoryId,
        treeHash: this.spec.fingerprint.sourceTreeHash,
        gitRevision: this.spec.fingerprint.gitRevision,
        dirtyPatchHash: this.spec.fingerprint.dirtyPatchHash,
      },
      build: {
        gameBuildHash: this.spec.fingerprint.gameBuildHash,
        importCacheHash: this.spec.fingerprint.importCacheHash,
      },
      runtime: {
        engine: runtime.engine,
        engineVersion: runtime.engineVersion,
        platform: runtime.platform,
        renderer: runtime.renderer,
        physicsEngine: this.spec.fingerprint.physicsEngine,
        adapterVersion: runtime.adapterVersion,
        protocolVersion: String(runtime.protocolVersion),
        pluginVersion: this.spec.fingerprint.pluginVersion,
        configurationHash: asSha(
          v04ContentHash({
            fixedFps: runtime.fixedFps,
            physicsTicksPerSecond: runtime.physicsTicksPerSecond,
            controls: execution.controlReceipt.realized,
          }),
        ),
        registeredRngDomains:
          checkpoint.content.snapshot.rngState !== null &&
          typeof checkpoint.content.snapshot.rngState === "object" &&
          !Array.isArray(checkpoint.content.snapshot.rngState)
            ? Object.keys(checkpoint.content.snapshot.rngState)
            : [],
      },
      contract: {
        contractId: this.spec.contract.contractId,
        bundleHash: asSha(v04ContractBundleHash(this.spec.contract)),
      },
      claimPolicyManifest: this.spec.claimPolicyManifest,
      checkpoint: {
        checkpointId: checkpoint.checkpointId,
        descriptorHash: asSha(
          v04ContentHash(checkpoint.content as unknown as JsonValue),
        ),
        restoreRecipeHash: asSha(certificate.restoreRecipeHash),
        coverageHash: asSha(
          v04ContentHash({
            covered: certificate.coveredStateDomains,
            missing: certificate.missingStateDomains,
            external: certificate.externalDependencies,
            pending: certificate.pendingAsyncOperations,
            limitations: certificate.limitations,
          } as unknown as JsonValue),
        ),
      },
      input: {
        inputTraceId: trace.inputTraceId,
        traceHash: asSha(v04ContentHash(trace as unknown as JsonValue)),
        inputMapHash: this.spec.fingerprint.inputMapHash,
      },
      controls: {
        requested: execution.controlReceipt.requested,
        realized: execution.controlReceipt.realized,
      },
      intervention,
      probe: { profileHash: this.spec.fingerprint.probeProfileHash },
      telemetry: {
        schemaVersion: 2,
        schemaHash: this.spec.fingerprint.telemetrySchemaHash,
      },
    };
    const fingerprint = ExecutionFingerprintV2Schema.parse({
      ...content,
      fingerprintHash: v04ContentHash(v04FingerprintSemanticContent(content)),
      comparisonBasisHash: v04ContentHash(v04ComparisonBasisContent(content)),
    });
    await this.repository.putExecutionFingerprint(fingerprint);
    return fingerprint;
  }

  public async execute(branchId: BranchId): Promise<V03ExecutionLog> {
    const execution = await this.#legacy.execute(branchId);
    await this.fingerprint(execution);
    return execution;
  }

  public async replayExecution(executionId: ExecutionId): Promise<{
    readonly execution: V03ExecutionLog;
    readonly matches: boolean;
    readonly sourceDigest: string;
    readonly replayDigest: string;
  }> {
    const sourceFingerprint =
      await this.repository.getExecutionFingerprint(executionId);
    const result = await this.#legacy.replayExecution(executionId);
    const replayFingerprint = await this.fingerprint(result.execution);
    return {
      ...result,
      matches:
        result.matches &&
        sourceFingerprint.fingerprintHash === replayFingerprint.fingerprintHash,
    };
  }

  private async withReservationLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#reservationTail;
    let release!: () => void;
    this.#reservationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  public runIntervention(
    baselineExecutionId: ExecutionId,
    interventionId: InterventionId,
  ): Promise<{
    readonly branch: V03BranchSpec;
    readonly execution: V03ExecutionLog;
  }> {
    return this.withReservationLock(async () => {
      const candidate = this.spec.interventions.find(
        (entry) => entry.interventionId === interventionId,
      );
      if (candidate === undefined) {
        throw new V04GameBranchError(
          "INVALID_RESERVATION",
          `Intervention ${interventionId} is outside the investigation catalog`,
        );
      }
      const existing = (
        await this.repository.listExperimentReservations(
          this.spec.investigationId,
        )
      ).filter((entry) => entry.reservationKind === "intervention");
      if (existing.some((entry) => entry.interventionId === interventionId)) {
        throw new V04GameBranchError(
          "INVALID_RESERVATION",
          `Intervention ${interventionId} is already reserved`,
        );
      }
      if (existing.length >= this.spec.experimentBudget.maxInterventions) {
        throw new V04GameBranchError(
          "INVALID_RESERVATION",
          "The persisted intervention budget is exhausted",
        );
      }
      const reservation = ExperimentReservationV1Schema.parse({
        schemaVersion: 1,
        reservationId: v04ExperimentReservationIdFor(
          this.spec.investigationId,
          interventionId,
        ),
        investigationId: this.spec.investigationId,
        runId: (await this.repository.getExecution(baselineExecutionId)).runId,
        reservedAt: this.clock.nowIso(),
        budget: {
          scope: "investigation",
          ordinal: existing.length + 1,
          maxInterventions: this.spec.experimentBudget.maxInterventions,
        },
        reservationKind: "intervention",
        interventionId,
      });
      await this.repository.putExperimentReservation(reservation);
      const result = await this.#legacy.runIntervention(
        baselineExecutionId,
        interventionId,
      );
      await this.fingerprint(result.execution);
      return result;
    });
  }

  public async compareExecutions(
    baselineExecutionId: ExecutionId,
    candidateExecutionId: ExecutionId,
  ): Promise<V03ExecutionComparison> {
    const comparison = await this.#legacy.compareExecutions(
      baselineExecutionId,
      candidateExecutionId,
    );
    const [baselineFingerprint, candidateFingerprint] = await Promise.all([
      this.repository.getExecutionFingerprint(baselineExecutionId),
      this.repository.getExecutionFingerprint(candidateExecutionId),
    ]);
    if (
      baselineFingerprint.comparisonBasisHash !==
      candidateFingerprint.comparisonBasisHash
    ) {
      throw new V04GameBranchError(
        "INVALID_FINGERPRINT",
        "The execution fingerprints do not share a comparison basis",
      );
    }
    return comparison;
  }

  public compileEvidence(executionId: ExecutionId): Promise<EvidenceCapsuleV2> {
    return this.#legacy.compileEvidence(executionId);
  }

  public async conclude(
    proposalInput: DiagnosisProposalV4,
    receiptInputs: readonly EvidenceAccessReceiptV2[],
  ): Promise<DiagnosisVerdictV3> {
    const proposal = DiagnosisProposalV4Schema.parse(proposalInput);
    const blockers: string[] = [];
    const block = (message: string): void => {
      if (!blockers.includes(message)) blockers.push(message);
    };
    if (proposal.investigationId !== this.spec.investigationId) {
      block("Proposal is outside the active investigation");
    }
    if (proposal.blockers.length > 0) {
      block("Agent reported unresolved diagnostic blockers");
    }
    if (!policyManifestMatches(this.spec, this.policies)) {
      block("Active Claim Policy registry does not match the frozen manifest");
    }
    const contract = FrozenContractBundleV3Schema.parse(
      await this.repository.getContractBundle(this.spec.contract.contractId),
    );
    if (
      contract.contractId !== this.spec.contract.contractId ||
      contract.contractId !==
        v04ContractIdFor({
          schemaVersion: contract.schemaVersion,
          contractVersion: contract.contractVersion,
          scope: contract.scope,
          authority: contract.authority,
          evaluator: contract.evaluator,
          rule: contract.rule,
        })
    ) {
      block("Frozen Contract bundle failed authority or hash validation");
    }

    const receipts = new Map<string, EvidenceAccessReceiptV2>();
    for (const input of receiptInputs) {
      const parsed = EvidenceAccessReceiptV2Schema.safeParse(input);
      if (!parsed.success) {
        block("A supplied evidence receipt failed strict validation");
        continue;
      }
      const receipt = parsed.data;
      if (
        receipt.receiptId !==
        v04EvidenceAccessReceiptIdFor({
          schemaVersion: 2,
          runId: receipt.runId,
          investigationId: receipt.investigationId,
          accessKind: receipt.accessKind,
          resourceId: receipt.resourceId,
          requestHash: receipt.requestHash,
          contentHash: receipt.contentHash,
          sourceCoverage: receipt.sourceCoverage,
        })
      ) {
        block("A supplied evidence receipt has an invalid content ID");
        continue;
      }
      if (receipts.has(receipt.receiptId)) {
        block("Evidence receipt IDs must be unique");
        continue;
      }
      try {
        const stored = EvidenceAccessReceiptV2Schema.parse(
          await this.repository.getEvidenceAccessReceipt(receipt.receiptId),
        );
        if (
          !jsonEqual(
            stored as unknown as JsonValue,
            receipt as unknown as JsonValue,
          )
        ) {
          block(
            `Evidence receipt ${receipt.receiptId} does not match the persisted Session receipt`,
          );
          continue;
        }
      } catch {
        block(`Evidence receipt ${receipt.receiptId} is not persisted`);
        continue;
      }
      receipts.set(receipt.receiptId, receipt);
    }
    const referencedReceipts = proposal.accessReceiptIds.flatMap((id) => {
      const receipt = receipts.get(id);
      if (receipt === undefined) {
        block(`Referenced evidence receipt ${id} is missing`);
        return [];
      }
      if (
        receipt.runId !== proposal.runId ||
        receipt.investigationId !== proposal.investigationId
      ) {
        block(`Referenced evidence receipt ${id} is outside the investigation`);
      }
      return [receipt];
    });
    if (referencedReceipts.length === 0) {
      block("At least one evidence receipt is required");
    }

    let capsule: EvidenceCapsuleV2 | undefined;
    let baseline: V03ExecutionLog | undefined;
    let replay: V03ExecutionLog | undefined;
    try {
      capsule = EvidenceCapsuleV2Schema.parse(
        await this.repository.getCapsule(proposal.capsuleId),
      );
      baseline = V03ExecutionLogSchema.parse(
        await this.repository.getExecution(proposal.baselineExecutionId),
      );
    } catch {
      block("Capsule or baseline execution could not be resolved");
    }
    if (
      capsule !== undefined &&
      baseline !== undefined &&
      (capsule.runId !== proposal.runId ||
        baseline.runId !== proposal.runId ||
        capsule.fixtureId !== this.spec.executionSubjectId ||
        capsule.baselineExecutionId !== baseline.executionId ||
        capsule.timelineDigest !== baseline.timelineDigest ||
        capsule.eventLossDetected ||
        baseline.evaluation.status !== "fail" ||
        !healthy(baseline))
    ) {
      block("Baseline evidence does not pass the canonical integrity Gate");
    }
    let baselineFingerprint: ExecutionFingerprintV2 | undefined;
    try {
      baselineFingerprint = ExecutionFingerprintV2Schema.parse(
        await this.repository.getExecutionFingerprint(
          proposal.baselineExecutionId,
        ),
      );
      if (
        baselineFingerprint.investigationId !== proposal.investigationId ||
        baselineFingerprint.contract.contractId !== contract.contractId
      ) {
        block("Baseline fingerprint is outside the investigation");
      }
    } catch {
      block("Baseline execution fingerprint is missing or invalid");
    }

    if (proposal.replayExecutionId === undefined) {
      block("A matching failing strict replay is required");
    } else {
      try {
        replay = V03ExecutionLogSchema.parse(
          await this.repository.getExecution(proposal.replayExecutionId),
        );
        const replayFingerprint = ExecutionFingerprintV2Schema.parse(
          await this.repository.getExecutionFingerprint(
            proposal.replayExecutionId,
          ),
        );
        if (
          baseline === undefined ||
          baselineFingerprint === undefined ||
          replay.executionId === baseline.executionId ||
          replay.branchId !== baseline.branchId ||
          replay.timelineDigest !== baseline.timelineDigest ||
          replay.evaluation.status !== "fail" ||
          !healthy(replay) ||
          replayFingerprint.fingerprintHash !==
            baselineFingerprint.fingerprintHash
        ) {
          block("A matching failing strict replay is required");
        }
      } catch {
        block("A matching failing strict replay is required");
      }
    }

    const candidates: V03ExecutionLog[] = [];
    for (const id of proposal.candidateExecutionIds) {
      try {
        candidates.push(
          V03ExecutionLogSchema.parse(await this.repository.getExecution(id)),
        );
      } catch {
        block(`Candidate execution ${id} could not be resolved`);
      }
    }
    const comparisons: V03ExecutionComparison[] = [];
    for (const id of proposal.comparisonIds) {
      try {
        comparisons.push(
          V03ExecutionComparisonSchema.parse(
            await this.repository.getComparison(id),
          ),
        );
      } catch {
        block(`Comparison ${id} could not be resolved`);
      }
    }
    const passing: V03ExecutionComparison[] = [];
    for (const comparison of comparisons) {
      const candidate = candidates.find(
        (entry) => entry.executionId === comparison.candidateExecutionId,
      );
      try {
        const candidateFingerprint = ExecutionFingerprintV2Schema.parse(
          await this.repository.getExecutionFingerprint(
            comparison.candidateExecutionId,
          ),
        );
        if (
          baseline === undefined ||
          baselineFingerprint === undefined ||
          candidate === undefined ||
          candidate.runId !== proposal.runId ||
          candidate.fixtureId !== this.spec.executionSubjectId ||
          comparison.baselineExecutionId !== baseline.executionId ||
          comparison.baselineOutcome !== "fail" ||
          comparison.candidateOutcome !== "pass" ||
          !comparison.comparable ||
          comparison.blockers.length > 0 ||
          candidate.evaluation.status !== "pass" ||
          !healthy(candidate) ||
          candidateFingerprint.runId !== proposal.runId ||
          candidateFingerprint.investigationId !== proposal.investigationId ||
          candidateFingerprint.contract.contractId !== contract.contractId ||
          candidateFingerprint.comparisonBasisHash !==
            baselineFingerprint.comparisonBasisHash
        ) {
          block(
            `Comparison ${comparison.comparisonId} does not pass the canonical comparison Gate`,
          );
        } else {
          passing.push(comparison);
        }
      } catch {
        block(
          `Comparison ${comparison.comparisonId} has no admissible candidate fingerprint`,
        );
      }
    }
    if (passing.length === 0 && proposal.claim.kind === "mechanism") {
      block("No comparable single-variable intervention changed fail to pass");
    }

    const requireReceipt = (
      kind: EvidenceAccessReceiptV2["accessKind"],
      resourceId: string,
    ): EvidenceAccessReceiptV2 | undefined => {
      const receipt = referencedReceipts.find(
        (entry) => entry.accessKind === kind && entry.resourceId === resourceId,
      );
      if (receipt === undefined) {
        block(`${kind} resource ${resourceId} is not covered by a receipt`);
      }
      return receipt;
    };
    const capsuleReceipt = requireReceipt("capsule", proposal.capsuleId);
    const replayReceipt =
      proposal.replayExecutionId === undefined
        ? undefined
        : requireReceipt("replay", proposal.replayExecutionId);
    for (const candidate of candidates) {
      requireReceipt("experiment", candidate.executionId);
    }
    for (const comparison of comparisons) {
      requireReceipt("comparison", comparison.comparisonId);
    }
    const receiptMatches = (
      receipt: EvidenceAccessReceiptV2,
      request: JsonValue,
      content: JsonValue,
    ): boolean =>
      receipt.requestHash === v04ContentHash(request) &&
      receipt.contentHash === v04ContentHash(content);
    if (
      capsuleReceipt !== undefined &&
      capsule !== undefined &&
      !receiptMatches(
        capsuleReceipt,
        { capsuleId: capsule.capsuleId },
        capsule as unknown as JsonValue,
      )
    ) {
      block("Capsule receipt does not match the resolved tool material");
    }
    if (
      replayReceipt !== undefined &&
      replay !== undefined &&
      baseline !== undefined &&
      !receiptMatches(replayReceipt, { executionId: baseline.executionId }, {
        execution: replay,
        matches: replay.timelineDigest === baseline.timelineDigest,
        sourceDigest: baseline.timelineDigest,
        replayDigest: replay.timelineDigest,
      } as unknown as JsonValue)
    ) {
      block("Replay receipt does not match the resolved tool material");
    }
    for (const receipt of referencedReceipts) {
      if (receipt.accessKind === "experiment") {
        if (receipt.resourceId === "intervention-catalog") {
          if (
            !receiptMatches(
              receipt,
              {},
              this.spec.interventions as unknown as JsonValue,
            )
          ) {
            block(
              "Intervention catalog receipt does not match the frozen investigation",
            );
          }
          continue;
        }
        const candidate = candidates.find(
          (entry) => entry.executionId === receipt.resourceId,
        );
        if (candidate === undefined) continue;
        try {
          const branch = V03BranchSpecSchema.parse(
            await this.repository.getBranch(candidate.branchId),
          );
          if (
            branch.branchKind !== "intervention" ||
            !receiptMatches(
              receipt,
              {
                baselineExecutionId: proposal.baselineExecutionId,
                interventionId: branch.interventionId,
              },
              {
                interventionId: branch.interventionId,
                execution: candidate,
              } as unknown as JsonValue,
            )
          ) {
            block(
              `Experiment receipt ${receipt.receiptId} does not match the resolved tool material`,
            );
          }
        } catch {
          block(
            `Experiment receipt ${receipt.receiptId} has no valid intervention branch`,
          );
        }
      } else if (receipt.accessKind === "comparison") {
        const comparison = comparisons.find(
          (entry) => entry.comparisonId === receipt.resourceId,
        );
        if (
          comparison !== undefined &&
          !receiptMatches(
            receipt,
            {
              baselineExecutionId: comparison.baselineExecutionId,
              candidateExecutionId: comparison.candidateExecutionId,
            },
            comparison as unknown as JsonValue,
          )
        ) {
          block(
            `Comparison receipt ${receipt.receiptId} does not match the resolved tool material`,
          );
        }
      }
    }
    if (proposal.suspectedSource !== undefined) {
      const covered = referencedReceipts.some(
        (receipt) =>
          (receipt.accessKind === "source_read" ||
            receipt.accessKind === "source_search") &&
          receipt.sourceCoverage.some(
            (coverage) =>
              coverage.virtualPath === proposal.suspectedSource?.path &&
              (proposal.suspectedSource.symbol === undefined ||
                coverage.coveredSymbols.includes(
                  proposal.suspectedSource.symbol,
                )),
          ),
      );
      if (!covered)
        block("Suspected source is not covered by a source receipt");
    }

    const allowedEventIds = new Set([
      ...(capsule?.eventChain.map((event) => event.eventId) ?? []),
      ...(replay?.events.map((event) => event.eventId) ?? []),
      ...candidates.flatMap((candidate) =>
        candidate.events.map((event) => event.eventId),
      ),
    ]);
    if (
      proposal.claim.kind === "mechanism" &&
      (proposal.evidenceEventIds.length === 0 ||
        proposal.evidenceEventIds.some((id) => !allowedEventIds.has(id)))
    ) {
      block(
        "Mechanism evidence references are missing or outside the investigation",
      );
    }

    let claimPolicyId: ReturnType<typeof asClaimPolicyId> | null = null;
    if (
      proposal.claim.kind === "mechanism" &&
      capsule !== undefined &&
      baseline !== undefined
    ) {
      try {
        const mechanismClaim = proposal.claim;
        const descriptor = this.policies
          .descriptors()
          .find((entry) => entry.mechanismId === mechanismClaim.mechanismId);
        if (descriptor === undefined) {
          throw new ClaimEvidencePolicyRegistryError(
            "UNKNOWN_MECHANISM_ID",
            `No policy is registered for ${mechanismClaim.mechanismId}`,
          );
        }
        claimPolicyId = asClaimPolicyId(descriptor.policyId);
        const decision = this.policies.evaluate({
          mechanismId: mechanismClaim.mechanismId,
          assertion: mechanismClaim.assertion,
          context: {
            capsule,
            baselineExecution: baseline,
            ...(replay === undefined ? {} : { replayExecution: replay }),
            comparisons: passing,
            candidateExecutions: candidates.filter((candidate) =>
              passing.some(
                (comparison) =>
                  comparison.candidateExecutionId === candidate.executionId,
              ),
            ),
            citedEventIds: proposal.evidenceEventIds,
          },
        });
        if (!decision.supported) {
          for (const policyBlocker of decision.blockers) {
            block(
              `Claim policy ${descriptor.policyId}: ${policyBlocker.message}`,
            );
          }
        }
      } catch (error) {
        block(
          error instanceof Error
            ? `Claim policy rejected the assertion: ${error.message}`
            : "Claim policy rejected the assertion",
        );
      }
    } else if (proposal.claim.kind === "unknown") {
      block("Agent abstained from a typed mechanism claim");
    }

    await this.repository.putProposalV4(proposal);
    const status = blockers.length === 0 ? "confirmed" : "inconclusive";
    const references: ArtifactReferenceV4[] = [
      { artifactKind: "contract", contractId: contract.contractId },
      { artifactKind: "capsule", capsuleId: proposal.capsuleId },
      { artifactKind: "execution", executionId: proposal.baselineExecutionId },
      {
        artifactKind: "fingerprint",
        executionId: proposal.baselineExecutionId,
      },
      ...proposal.accessReceiptIds.map((receiptId) => ({
        artifactKind: "receipt" as const,
        receiptId,
      })),
    ];
    const verdict = DiagnosisVerdictV3Schema.parse(
      status === "confirmed" &&
        proposal.claim.kind === "mechanism" &&
        claimPolicyId !== null
        ? {
            schemaVersion: 3,
            verdictId: asVerdictId(this.ids.next("verdict")),
            proposalId: proposal.proposalId,
            runId: proposal.runId,
            investigationId: proposal.investigationId,
            status,
            claimLevel: "mechanism_supported",
            mechanismId: proposal.claim.mechanismId,
            claimPolicyId,
            summary: `Harness evidence supports ${proposal.claim.mechanismId}`,
            validatedReferences: references,
            blockers: [],
            nextExperiment: null,
          }
        : {
            schemaVersion: 3,
            verdictId: asVerdictId(this.ids.next("verdict")),
            proposalId: proposal.proposalId,
            runId: proposal.runId,
            investigationId: proposal.investigationId,
            status: "inconclusive",
            claimLevel: "none",
            mechanismId:
              proposal.claim.kind === "mechanism"
                ? proposal.claim.mechanismId
                : null,
            claimPolicyId,
            summary: "Evidence is insufficient for a canonical diagnosis",
            validatedReferences: references,
            blockers,
            nextExperiment:
              proposal.nextExperiment ??
              "Resolve the Gate blockers and repeat the smallest controlled experiment.",
          },
    );
    await this.repository.putVerdictV3(verdict);
    return verdict;
  }
}
