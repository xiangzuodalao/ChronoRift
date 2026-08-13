import {
  AdapterConformanceReceiptV1Schema,
  AdapterConformanceReceiptV2Schema,
  EnvironmentBindingEpochV1Schema,
  EnvironmentPublicationIntentV1Schema,
  EnvironmentPublicationReceiptV1Schema,
  ProjectAdapterCandidateReferenceV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  ProjectEnvironmentTurnV1Schema,
  ProjectInitializationAttemptEventV1Schema,
  ProjectTurnBudgetV1Schema,
  foldProjectInitializationAttemptV1,
  type AdapterConformanceReceiptV1,
  type AdapterConformanceReceiptV2,
  type AdapterId,
  type EnvironmentBindingEpochId,
  type EnvironmentBindingEpochV1,
  type EnvironmentPublicationIntentV1,
  type EnvironmentPublicationReceiptV1,
  type ProjectAdapterCandidateReferenceV1,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentRevisionV1,
  type ProjectEnvironmentTurnId,
  type ProjectEnvironmentTurnV1,
  type ProjectInitializationAttemptEventId,
  type ProjectInitializationAttemptEventV1,
  type ProjectInitializationAttemptId,
  type ProjectInitializationAttemptV1,
  type ProjectSessionId,
  type ProjectTurnBudgetV1,
  type ProjectTurnUsageV1,
  type SourceId,
  type TaskId,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

export const PROJECT_ADAPTER_CANDIDATE_SANDBOX_PATH_V1 =
  "/workspace/.chronorift/adapter-candidate" as const;

const cleanText = (value: string, label: string, maximum = 4_096): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${label} must be non-empty bounded text`);
  }
  return value;
};

export const composeProjectEnvironmentInitializationPromptV1 = (input: {
  readonly adapterId: AdapterId;
  readonly mainScene: string;
  readonly requestedGodotVersion: "4.7.1";
  readonly sourceIdentity: string;
}): string => {
  const mainScene = cleanText(input.mainScene, "mainScene", 1_024);
  const sourceIdentity = cleanText(input.sourceIdentity, "sourceIdentity", 256);
  return [
    "Initialize this Godot project environment so later turns can work on the project normally.",
    "Use your normal coding-agent judgment to inspect the project; there is no required tool order.",
    `Create the one ProjectAdapter candidate below ${PROJECT_ADAPTER_CANDIDATE_SANDBOX_PATH_V1}.`,
    "Inspect the managed SDK and manifest reference at /workspace/.chronorift/adapter-sdk-v1 before writing adapter code; the Host separately pins the runtime SDK bytes.",
    "Follow the loaded project-adapter skill and its exact manifest, SDK, schema, and capability rules.",
    `The manifest adapterId must be exactly: ${input.adapterId}`,
    "Do not edit game source during this initialization turn. Do not claim readiness yourself: after this turn returns, the Host independently freezes, validates, and publishes the candidate.",
    `Realized project source identity: ${sourceIdentity}`,
    `Realized default main scene: ${mainScene}`,
    `Required managed Godot version: ${input.requestedGodotVersion}`,
  ].join("\n");
};

export const composeProjectEnvironmentInitializationPromptV2 = (input: {
  readonly adapterId: AdapterId;
  readonly mainScene: string;
  readonly requestedGodotVersion: "4.7.1";
  readonly sourceIdentity: string;
}): string =>
  composeProjectEnvironmentInitializationPromptV1(input)
    .replace("adapter-sdk-v1", "adapter-sdk-v2")
    .replace("loaded project-adapter skill", "loaded project-adapter-v2 skill")
    .replace(
      "Create the one ProjectAdapter candidate below /workspace/.chronorift/adapter-candidate.",
      "Edit the pre-created ProjectAdapter scaffold at /workspace/.chronorift/adapter-candidate in place; do not copy the reference package.",
    )
    .concat(
      "\nAuthor a manifest/SDK/observation V2 adapter. Inspect project source first, replace every dynamic-placeholder identifier, and implement only source-derived node and Signal semantics. Keep the existing schema files and change each document's schemaId as needed; preserve their small payload shapes when they honestly represent the project and do not invent extra fields. Once the semantic declarations and GDScript agree, call project_adapter_finalize_v2 once. It rebuilds the manifest schema inventory and hashes from the actual schema documents, restores Host-bound adapter, launch, SDK, and engine fields, and freezes the candidate for the rest of this turn. If that call rejects a semantic reference, fix exactly that reference and retry once; do not manually repair hashes or schema declaration paths. After it succeeds, do not call bash, edit, write, or finalize again; finish immediately. Ready requires one lossless declared dynamic trace with entity-bound state and event observations across exactly consecutive incarnations. Do not run Godot or perform conformance yourself because the Host performs authoritative validation after this turn.",
    );

interface ProjectEnvironmentPiTurnResultFieldsV1 {
  readonly status: "completed" | "failed" | "cancelled";
  readonly sessionId: ProjectSessionId;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export type ProjectEnvironmentPiTurnResultV1 =
  ProjectEnvironmentPiTurnResultFieldsV1 &
    (
      | {
          readonly usageStatus: "observed";
          readonly usage: ProjectTurnUsageV1;
        }
      | {
          readonly usageStatus: "partial";
          readonly usage: ProjectTurnUsageV1;
        }
      | {
          readonly usageStatus: "unavailable";
          readonly usage: null;
        }
    );

const observedBudgetExcesses = (
  budget: ProjectTurnBudgetV1,
  usage: ProjectTurnUsageV1,
): readonly string[] => {
  const excesses: string[] = [];
  const exceeds = (
    label: string,
    observed: number | null,
    limit: number,
  ): void => {
    if (observed !== null && observed > limit) {
      excesses.push(`${label} ${observed} exceeded ${limit}`);
    }
  };
  exceeds("wall-time milliseconds", usage.wallTimeMs, budget.wallTimeMs);
  exceeds("tool calls", usage.toolCalls, budget.toolCallLimit);
  exceeds("runtime milliseconds", usage.runtimeTimeMs, budget.runtimeTimeMs);
  exceeds("storage bytes", usage.storageBytes, budget.storageByteLimit);
  exceeds("storage inodes", usage.storageInodes, budget.storageInodeLimit);
  if (budget.tokenPolicy === "limited" && budget.tokenLimit !== null) {
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
    if (inputTokens !== null && outputTokens !== null) {
      if (
        inputTokens > budget.tokenLimit ||
        outputTokens > budget.tokenLimit - inputTokens
      ) {
        excesses.push(
          `total tokens ${inputTokens + outputTokens} exceeded ${budget.tokenLimit}`,
        );
      }
    } else {
      exceeds("input tokens", inputTokens, budget.tokenLimit);
      exceeds("output tokens", outputTokens, budget.tokenLimit);
    }
  }
  return Object.freeze(excesses);
};

/**
 * A Pi completion is not a successful turn when an observed counter exceeded
 * its declared budget. Counters that the Host cannot measure remain null and
 * keep the usage status partial; they are never filled with an assumed zero.
 */
export const enforceProjectEnvironmentTurnBudgetV1 = (
  result: ProjectEnvironmentPiTurnResultV1,
  untrustedBudget: ProjectTurnBudgetV1,
  options: {
    readonly toolCallAdmissionExhausted?: boolean | undefined;
  } = {},
): ProjectEnvironmentPiTurnResultV1 => {
  const budget = ProjectTurnBudgetV1Schema.parse(untrustedBudget);
  if (options.toolCallAdmissionExhausted === true) {
    return Object.freeze({
      ...result,
      status: "failed",
      errorCode: "budget_exhausted",
      errorMessage: `Project Environment turn tool-call budget exhausted after ${budget.toolCallLimit} admitted call(s)`,
    });
  }
  if (result.status !== "completed" || result.usage === null) return result;
  const excesses = observedBudgetExcesses(budget, result.usage);
  if (excesses.length === 0) return result;
  return Object.freeze({
    ...result,
    status: "failed",
    errorCode: "budget_exhausted",
    errorMessage: `Project Environment turn budget exhausted: ${excesses.join("; ")}`,
  });
};

export const projectEnvironmentTurnTimeoutMsV1 = (
  requestedTimeoutMs: number | undefined,
  untrustedBudget: ProjectTurnBudgetV1,
): number => {
  const budget = ProjectTurnBudgetV1Schema.parse(untrustedBudget);
  if (
    requestedTimeoutMs !== undefined &&
    (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs < 1)
  ) {
    throw new TypeError("Project Environment turn timeout must be positive");
  }
  return Math.min(requestedTimeoutMs ?? budget.wallTimeMs, budget.wallTimeMs);
};

export interface ProjectEnvironmentAuthoritativeValidationV1 {
  readonly candidate: ProjectAdapterCandidateReferenceV1;
  readonly conformance:
    AdapterConformanceReceiptV1 | AdapterConformanceReceiptV2;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly environmentRevision: ProjectEnvironmentRevisionV1;
  readonly publicationIntent: EnvironmentPublicationIntentV1;
  readonly revisionFiles: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
}

export interface ProjectEnvironmentInitializationPortV1 {
  appendAttemptEvent(event: ProjectInitializationAttemptEventV1): Promise<void>;
  putTurn(turn: ProjectEnvironmentTurnV1): Promise<void>;
  runTurn(input: {
    readonly purpose: "environment_initialization" | "user_goal";
    readonly prompt: string;
    readonly sessionId: ProjectSessionId;
    readonly bindingEpochId: EnvironmentBindingEpochId | null;
    readonly budget: ProjectTurnBudgetV1;
  }): Promise<ProjectEnvironmentPiTurnResultV1>;
  assertGameSourceUnchanged(): Promise<void>;
  freezeCandidate(): Promise<ProjectAdapterCandidateReferenceV1>;
  validateCandidate(
    candidate: ProjectAdapterCandidateReferenceV1,
  ): Promise<ProjectEnvironmentAuthoritativeValidationV1>;
  publish(
    validation: ProjectEnvironmentAuthoritativeValidationV1,
  ): Promise<EnvironmentPublicationReceiptV1>;
  bind(input: {
    readonly validation: ProjectEnvironmentAuthoritativeValidationV1;
    readonly publication: EnvironmentPublicationReceiptV1;
    readonly bindingEpochId: EnvironmentBindingEpochId;
  }): Promise<EnvironmentBindingEpochV1>;
  resolvePublication(input: {
    readonly validation: ProjectEnvironmentAuthoritativeValidationV1;
    readonly publication: EnvironmentPublicationReceiptV1;
    readonly binding: EnvironmentBindingEpochV1 | null;
    readonly attempt: ProjectInitializationAttemptV1;
  }): Promise<void>;
}

export interface ProjectEnvironmentInitializationIdsV1 {
  readonly attemptId: ProjectInitializationAttemptId;
  readonly initializationTurnId: ProjectEnvironmentTurnId;
  readonly goalTurnId: ProjectEnvironmentTurnId;
  readonly bindingEpochId: EnvironmentBindingEpochId;
  attemptEventId(sequence: number): ProjectInitializationAttemptEventId;
}

export interface InitializeProjectEnvironmentV1Request {
  readonly taskId: TaskId;
  readonly sessionId: ProjectSessionId;
  readonly sourceId: SourceId;
  readonly adapterId: AdapterId;
  readonly sourceIdentity: string;
  readonly mainScene: string;
  readonly requestedGodotVersion: "4.7.1";
  readonly providerId: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly budget: ProjectTurnBudgetV1;
  readonly queuedGoal: string | null;
  readonly adapterContractVersion?: 1 | 2 | undefined;
  readonly ids: ProjectEnvironmentInitializationIdsV1;
}

export interface ProjectEnvironmentInitializationResultV1 {
  readonly attempt: ProjectInitializationAttemptV1;
  readonly initializationTurn: ProjectEnvironmentTurnV1;
  readonly binding: EnvironmentBindingEpochV1 | null;
  readonly goalTurn: ProjectEnvironmentTurnV1 | null;
  readonly goalDelivered: boolean;
  readonly validation: ProjectEnvironmentAuthoritativeValidationV1 | null;
  readonly publication: EnvironmentPublicationReceiptV1 | null;
}

const digestText = (value: string): string =>
  contentHash({ schemaVersion: 1, text: value });

const terminalTurn = (input: {
  readonly turnId: ProjectEnvironmentTurnId;
  readonly taskId: TaskId;
  readonly sessionId: ProjectSessionId;
  readonly purpose: "environment_initialization" | "user_goal";
  readonly attemptId: ProjectInitializationAttemptId | null;
  readonly bindingEpochId: EnvironmentBindingEpochId | null;
  readonly prompt: string;
  readonly queuedGoal: string | null;
  readonly budget: ProjectTurnBudgetV1;
  readonly result: ProjectEnvironmentPiTurnResultV1;
  readonly startedAt: string;
  readonly endedAt: string;
}): ProjectEnvironmentTurnV1 => {
  const failure = projectEnvironmentPiTurnTerminalFailureV1(input.result);
  return ProjectEnvironmentTurnV1Schema.parse({
    schemaVersion: 1,
    turnId: input.turnId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    purpose: input.purpose,
    attemptId: input.attemptId,
    bindingEpochId: input.bindingEpochId,
    promptDigest: digestText(input.prompt),
    queuedGoalDigest:
      input.queuedGoal === null ? null : digestText(input.queuedGoal),
    budget: input.budget,
    usageStatus: input.result.usageStatus,
    usage: input.result.usage,
    status: input.result.status,
    terminalCode: failure?.failureCode ?? null,
    terminalMessage: failure?.message ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  });
};

const validFailureCode = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) &&
  !value.includes("..");

const boundedFailureMessage = (value: unknown, fallback: string): string => {
  const raw =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint"
          ? String(value)
          : typeof value === "symbol"
            ? (value.description ?? "")
            : "";
  const sanitized = raw
    .replace(/[\r\n\0]/gu, " ")
    .trim()
    .slice(0, 4_096);
  return sanitized.length === 0 ? fallback : sanitized;
};

const normalizedFailureFields = (
  code: unknown,
  message: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): { readonly failureCode: string; readonly message: string } => ({
  failureCode: validFailureCode(code) ? code : fallbackCode,
  message: boundedFailureMessage(message, fallbackMessage),
});

export const projectEnvironmentPiTurnTerminalFailureV1 = (
  result: ProjectEnvironmentPiTurnResultV1,
): { readonly failureCode: string; readonly message: string } | null =>
  result.status === "completed"
    ? null
    : normalizedFailureFields(
        result.errorCode,
        result.errorMessage,
        result.status === "cancelled" ? "cancelled" : "pi_turn_failed",
        result.status === "cancelled"
          ? "Pi turn was cancelled"
          : "Pi turn failed",
      );

const failureFields = (
  error: unknown,
  fallbackCode = "initialization_failed",
): { readonly failureCode: string; readonly message: string } =>
  normalizedFailureFields(
    error instanceof Error && "code" in error
      ? (error as { readonly code?: unknown }).code
      : null,
    error instanceof Error ? error.message : error,
    fallbackCode,
    "Project Environment operation failed",
  );

const isCancellationError = (error: unknown): boolean => {
  if (error instanceof Error && error.name === "AbortError") return true;
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { readonly code?: unknown }).code
      : null;
  return (
    typeof code === "string" &&
    ["ABORT_ERR", "ERR_CANCELED", "aborted", "cancelled"].includes(code)
  );
};

export const projectEnvironmentPiTurnExceptionResultV1 = (
  error: unknown,
  sessionId: ProjectSessionId,
): ProjectEnvironmentPiTurnResultV1 => {
  const cancelled = isCancellationError(error);
  const failure = failureFields(
    error,
    cancelled ? "cancelled" : "pi_turn_exception",
  );
  return Object.freeze({
    status: cancelled ? "cancelled" : "failed",
    sessionId,
    usageStatus: "unavailable",
    usage: null,
    errorCode: cancelled ? "cancelled" : failure.failureCode,
    errorMessage: failure.message,
  });
};

const assertValidationBindings = (
  request: InitializeProjectEnvironmentV1Request,
  candidate: ProjectAdapterCandidateReferenceV1,
  raw: ProjectEnvironmentAuthoritativeValidationV1,
): ProjectEnvironmentAuthoritativeValidationV1 => {
  const validation = Object.freeze({
    candidate: ProjectAdapterCandidateReferenceV1Schema.parse(raw.candidate),
    conformance:
      raw.conformance.schemaVersion === 2
        ? AdapterConformanceReceiptV2Schema.parse(raw.conformance)
        : AdapterConformanceReceiptV1Schema.parse(raw.conformance),
    adapterRevision: ProjectAdapterRevisionV1Schema.parse(raw.adapterRevision),
    environmentRevision: ProjectEnvironmentRevisionV1Schema.parse(
      raw.environmentRevision,
    ),
    publicationIntent: EnvironmentPublicationIntentV1Schema.parse(
      raw.publicationIntent,
    ),
    revisionFiles: Object.freeze(
      raw.revisionFiles.map((file) =>
        Object.freeze({ path: file.path, bytes: Uint8Array.from(file.bytes) }),
      ),
    ),
  });
  if (
    validation.candidate.taskId !== request.taskId ||
    validation.candidate.attemptId !== request.ids.attemptId ||
    validation.candidate.sourceId !== request.sourceId ||
    validation.candidate.candidateId !== candidate.candidateId ||
    validation.candidate.contentDigest !== candidate.contentDigest ||
    validation.conformance.taskId !== request.taskId ||
    validation.conformance.attemptId !== request.ids.attemptId ||
    validation.conformance.candidateId !== candidate.candidateId ||
    validation.conformance.candidateDigest !== candidate.contentDigest ||
    validation.conformance.outcome !== "conformed" ||
    validation.adapterRevision.sourceId !== request.sourceId ||
    validation.adapterRevision.adapterRevisionId !==
      validation.environmentRevision.adapterRevisionId ||
    validation.environmentRevision.sourceId !== request.sourceId ||
    validation.environmentRevision.publicationOperationId !==
      validation.publicationIntent.operationId ||
    validation.publicationIntent.taskId !== request.taskId ||
    validation.publicationIntent.attemptId !== request.ids.attemptId ||
    validation.publicationIntent.candidateId !== candidate.candidateId ||
    validation.publicationIntent.sourceId !== request.sourceId ||
    validation.publicationIntent.targetEnvironmentRevisionId !==
      validation.environmentRevision.environmentRevisionId ||
    validation.publicationIntent.targetAdapterRevisionId !==
      validation.adapterRevision.adapterRevisionId ||
    validation.publicationIntent.expectedCurrentRevisionId !== null
  ) {
    throw new Error(
      "authoritative validation crossed the PE-A Task, source, candidate, or initial-publication binding",
    );
  }
  return validation;
};

export async function initializeProjectEnvironmentV1(
  rawRequest: InitializeProjectEnvironmentV1Request,
  port: ProjectEnvironmentInitializationPortV1,
  now: () => string = () => new Date().toISOString(),
): Promise<ProjectEnvironmentInitializationResultV1> {
  const request = {
    ...rawRequest,
    budget: rawRequest.budget,
    queuedGoal:
      rawRequest.queuedGoal === null
        ? null
        : cleanText(rawRequest.queuedGoal, "queuedGoal", 128 * 1_024),
  };
  cleanText(request.providerId, "providerId", 256);
  cleanText(request.modelId, "modelId", 256);
  cleanText(request.thinkingLevel, "thinkingLevel", 256);
  const prompt =
    request.adapterContractVersion === 2
      ? composeProjectEnvironmentInitializationPromptV2(request)
      : composeProjectEnvironmentInitializationPromptV1(request);
  const events: ProjectInitializationAttemptEventV1[] = [];
  const append = async (
    fields: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const event = ProjectInitializationAttemptEventV1Schema.parse({
      schemaVersion: 1,
      eventId: request.ids.attemptEventId(events.length),
      attemptId: request.ids.attemptId,
      taskId: request.taskId,
      sequence: events.length,
      occurredAt: now(),
      ...fields,
    });
    await port.appendAttemptEvent(event);
    events.push(event);
  };

  await append({
    eventKind: "created",
    predecessorAttemptId: null,
    sessionId: request.sessionId,
    sourceId: request.sourceId,
    providerId: request.providerId,
    modelId: request.modelId,
    thinkingLevel: request.thinkingLevel,
    budget: request.budget,
  });
  await append({ eventKind: "agent_running" });
  const initializationStartedAt = now();
  let initializationResult: ProjectEnvironmentPiTurnResultV1;
  try {
    initializationResult = enforceProjectEnvironmentTurnBudgetV1(
      await port.runTurn({
        purpose: "environment_initialization",
        prompt,
        sessionId: request.sessionId,
        bindingEpochId: null,
        budget: request.budget,
      }),
      request.budget,
    );
    if (initializationResult.sessionId !== request.sessionId) {
      throw Object.assign(
        new Error(
          "initialization turn switched away from its visible Pi Session",
        ),
        { code: "session_mismatch" },
      );
    }
  } catch (error) {
    initializationResult = projectEnvironmentPiTurnExceptionResultV1(
      error,
      request.sessionId,
    );
  }
  const initializationTurn = terminalTurn({
    turnId: request.ids.initializationTurnId,
    taskId: request.taskId,
    sessionId: request.sessionId,
    purpose: "environment_initialization",
    attemptId: request.ids.attemptId,
    bindingEpochId: null,
    prompt,
    queuedGoal: request.queuedGoal,
    budget: request.budget,
    result: initializationResult,
    startedAt: initializationStartedAt,
    endedAt: now(),
  });
  await port.putTurn(initializationTurn);
  if (initializationResult.status !== "completed") {
    if (initializationResult.status === "cancelled") {
      await append({
        eventKind: "cancelled",
        reason: initializationTurn.terminalMessage ?? "Pi turn was cancelled",
      });
    } else {
      await append({
        eventKind: "failed",
        failureCode: initializationTurn.terminalCode ?? "pi_turn_failed",
        message: initializationTurn.terminalMessage ?? "Pi turn failed",
      });
    }
    return {
      attempt: foldProjectInitializationAttemptV1(events),
      initializationTurn,
      binding: null,
      goalTurn: null,
      goalDelivered: false,
      validation: null,
      publication: null,
    };
  }

  let validation: ProjectEnvironmentAuthoritativeValidationV1 | null = null;
  let publication: EnvironmentPublicationReceiptV1 | null = null;
  let binding: EnvironmentBindingEpochV1 | null = null;
  try {
    await port.assertGameSourceUnchanged();
    const candidate = ProjectAdapterCandidateReferenceV1Schema.parse(
      await port.freezeCandidate(),
    );
    if (
      candidate.taskId !== request.taskId ||
      candidate.attemptId !== request.ids.attemptId ||
      candidate.sourceId !== request.sourceId
    ) {
      throw new Error("frozen ProjectAdapter candidate crossed Task ownership");
    }
    await append({ eventKind: "candidate_frozen", candidate });
    await append({ eventKind: "validating" });
    validation = assertValidationBindings(
      request,
      candidate,
      await port.validateCandidate(candidate),
    );
    await port.assertGameSourceUnchanged();
    await append({
      eventKind: "publishing",
      operationId: validation.publicationIntent.operationId,
    });
    publication = EnvironmentPublicationReceiptV1Schema.parse(
      await port.publish(validation),
    );
    if (
      publication.outcome !== "committed" ||
      publication.operationId !== validation.publicationIntent.operationId ||
      publication.taskId !== request.taskId ||
      publication.attemptId !== request.ids.attemptId ||
      publication.targetEnvironmentRevisionId !==
        validation.environmentRevision.environmentRevisionId
    ) {
      throw new Error(
        "Project Environment initial publication did not commit exactly",
      );
    }
    await append({
      eventKind: "publication_committed",
      operationId: publication.operationId,
      environmentRevisionId:
        validation.environmentRevision.environmentRevisionId,
      adapterRevisionId: validation.adapterRevision.adapterRevisionId,
      publicationReceiptId: publication.receiptId,
    });
    await append({ eventKind: "binding" });
    binding = EnvironmentBindingEpochV1Schema.parse(
      await port.bind({
        validation,
        publication,
        bindingEpochId: request.ids.bindingEpochId,
      }),
    );
    if (
      binding.state !== "bound" ||
      binding.taskId !== request.taskId ||
      binding.attemptId !== request.ids.attemptId ||
      binding.bindingEpochId !== request.ids.bindingEpochId ||
      binding.environment.environmentRevisionId !==
        validation.environmentRevision.environmentRevisionId ||
      binding.publicationOperationId !== publication.operationId ||
      binding.publicationReceiptId !== publication.receiptId
    ) {
      throw new Error("Task binding does not match the committed publication");
    }
    await append({
      eventKind: "succeeded",
      bindingEpochId: binding.bindingEpochId,
    });
  } catch (error) {
    const failure = failureFields(error);
    if (events.some((event) => event.eventKind === "publication_committed")) {
      await append({ eventKind: "binding_failed", ...failure });
    } else {
      await append({ eventKind: "failed", ...failure });
    }
    const attempt = foldProjectInitializationAttemptV1(events);
    if (validation !== null && publication !== null) {
      await port.resolvePublication({
        validation,
        publication,
        binding: null,
        attempt,
      });
    }
    return {
      attempt,
      initializationTurn,
      binding: null,
      goalTurn: null,
      goalDelivered: false,
      validation,
      publication,
    };
  }

  if (validation === null || publication === null || binding === null) {
    throw new Error(
      "successful initialization lost publication recovery identities",
    );
  }
  const succeededAttempt = foldProjectInitializationAttemptV1(events);
  await port.resolvePublication({
    validation,
    publication,
    binding,
    attempt: succeededAttempt,
  });

  let goalTurn: ProjectEnvironmentTurnV1 | null = null;
  if (request.queuedGoal !== null) {
    const goalStartedAt = now();
    let goalResult: ProjectEnvironmentPiTurnResultV1;
    try {
      goalResult = enforceProjectEnvironmentTurnBudgetV1(
        await port.runTurn({
          purpose: "user_goal",
          prompt: request.queuedGoal,
          sessionId: request.sessionId,
          bindingEpochId: request.ids.bindingEpochId,
          budget: request.budget,
        }),
        request.budget,
      );
      if (goalResult.sessionId !== request.sessionId) {
        throw Object.assign(
          new Error(
            "queued goal switched away from the initialization Session",
          ),
          { code: "session_mismatch" },
        );
      }
    } catch (error) {
      goalResult = projectEnvironmentPiTurnExceptionResultV1(
        error,
        request.sessionId,
      );
    }
    goalTurn = terminalTurn({
      turnId: request.ids.goalTurnId,
      taskId: request.taskId,
      sessionId: request.sessionId,
      purpose: "user_goal",
      attemptId: null,
      bindingEpochId: request.ids.bindingEpochId,
      prompt: request.queuedGoal,
      queuedGoal: null,
      budget: request.budget,
      result: goalResult,
      startedAt: goalStartedAt,
      endedAt: now(),
    });
    await port.putTurn(goalTurn);
  }
  return {
    attempt: succeededAttempt,
    initializationTurn,
    binding,
    goalTurn,
    goalDelivered:
      request.queuedGoal === null || goalTurn?.status === "completed",
    validation,
    publication,
  };
}
