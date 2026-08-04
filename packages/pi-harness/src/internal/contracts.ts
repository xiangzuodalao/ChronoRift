import { PiHarnessError } from "../errors.js";
import type {
  AgentEvidence,
  AgentOutcome,
  AgentReplayResult,
  AgentTimelineBranch,
  AgentTimelineComparison,
  CompareTimelinesRequest,
  DiagnosisComparison,
  DiagnosisExperiment,
  DiagnosisReport,
  ForkTimelineRequest,
  JsonObject,
  JsonValue,
  ReplayTimelineRequest,
} from "../types.js";

type UnknownRecord = Record<string, unknown>;

function invalidGameResult(path: string, message: string): never {
  throw new PiHarnessError("INVALID_GAME_RESULT", `${path}: ${message}`);
}

function invalidDiagnosis(path: string, message: string): never {
  throw new PiHarnessError("INVALID_DIAGNOSIS", `${path}: ${message}`);
}

function expectRecord(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => never,
): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "expected an object");
  }
  return value as UnknownRecord;
}

function expectOnlyKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  path: string,
  fail: (path: string, message: string) => never,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    fail(path, `unexpected properties: ${unexpected.join(", ")}`);
  }
}

function expectLiteralOne(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => never,
): 1 {
  if (value !== 1) return fail(path, "expected schemaVersion 1");
  return 1;
}

export function expectNonEmptyString(
  value: unknown,
  path: string,
  code:
    | "INVALID_ARGUMENT"
    | "INVALID_GAME_RESULT"
    | "INVALID_DIAGNOSIS" = "INVALID_ARGUMENT",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PiHarnessError(code, `${path}: expected a non-empty string`);
  }
  return value;
}

function expectStringArray(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => never,
  minimumLength = 0,
): string[] {
  if (!Array.isArray(value)) return fail(path, "expected an array");
  if (value.length < minimumLength) {
    return fail(path, `expected at least ${minimumLength} item(s)`);
  }
  const result = value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      return fail(`${path}[${index}]`, "expected a non-empty string");
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    return fail(path, "must not contain duplicate values");
  }
  return result;
}

function expectOutcome(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => never,
): AgentOutcome {
  if (
    value !== "pass" &&
    value !== "fail" &&
    value !== "incomplete" &&
    value !== "mixed"
  ) {
    return fail(path, "expected pass, fail, incomplete, or mixed");
  }
  return value;
}

function assertJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  fail: (path: string, message: string) => never,
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "numbers must be finite");
    return;
  }
  if (typeof value !== "object") {
    fail(path, "expected a JSON value");
  }
  if (ancestors.has(value)) fail(path, "cyclic values are not JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        assertJsonValue(item, `${path}[${index}]`, ancestors, fail);
      });
      return;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, "expected a plain JSON object");
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`, ancestors, fail);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function parseJsonObject(
  value: unknown,
  path: string,
  code:
    | "INVALID_ARGUMENT"
    | "INVALID_GAME_RESULT"
    | "INVALID_DIAGNOSIS" = "INVALID_ARGUMENT",
): JsonObject {
  const fail = (errorPath: string, message: string): never => {
    throw new PiHarnessError(code, `${errorPath}: ${message}`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "expected a JSON object");
  }
  assertJsonValue(value, path, new Set(), fail);
  return structuredClone(value) as JsonObject;
}

export function parseAgentEvidence(value: unknown): AgentEvidence {
  const record = expectRecord(value, "evidence", invalidGameResult);
  expectOnlyKeys(
    record,
    [
      "schemaVersion",
      "evidenceId",
      "summary",
      "checkpointId",
      "branchId",
      "eventIds",
      "details",
    ],
    "evidence",
    invalidGameResult,
  );
  return {
    schemaVersion: expectLiteralOne(
      record["schemaVersion"],
      "evidence.schemaVersion",
      invalidGameResult,
    ),
    evidenceId: expectNonEmptyString(
      record["evidenceId"],
      "evidence.evidenceId",
      "INVALID_GAME_RESULT",
    ),
    summary: expectNonEmptyString(
      record["summary"],
      "evidence.summary",
      "INVALID_GAME_RESULT",
    ),
    checkpointId: expectNonEmptyString(
      record["checkpointId"],
      "evidence.checkpointId",
      "INVALID_GAME_RESULT",
    ),
    branchId: expectNonEmptyString(
      record["branchId"],
      "evidence.branchId",
      "INVALID_GAME_RESULT",
    ),
    eventIds: expectStringArray(
      record["eventIds"],
      "evidence.eventIds",
      invalidGameResult,
    ),
    details: parseJsonObject(
      record["details"],
      "evidence.details",
      "INVALID_GAME_RESULT",
    ),
  };
}

export function parseForkRequest(value: unknown): ForkTimelineRequest {
  const record = expectRecord(value, "fork request", (path, message) => {
    throw new PiHarnessError("INVALID_ARGUMENT", `${path}: ${message}`);
  });
  expectOnlyKeys(
    record,
    ["checkpointId", "controls", "label"],
    "fork request",
    (path, message) => {
      throw new PiHarnessError("INVALID_ARGUMENT", `${path}: ${message}`);
    },
  );
  const checkpointId = expectNonEmptyString(
    record["checkpointId"],
    "fork request.checkpointId",
  );
  const controls = parseJsonObject(record["controls"], "fork request.controls");
  const labelValue = record["label"];
  if (labelValue === undefined) return { checkpointId, controls };
  return {
    checkpointId,
    controls,
    label: expectNonEmptyString(labelValue, "fork request.label"),
  };
}

export function parseAgentTimelineBranch(value: unknown): AgentTimelineBranch {
  const record = expectRecord(value, "fork result", invalidGameResult);
  expectOnlyKeys(
    record,
    ["schemaVersion", "branchId", "checkpointId", "controls"],
    "fork result",
    invalidGameResult,
  );
  return {
    schemaVersion: expectLiteralOne(
      record["schemaVersion"],
      "fork result.schemaVersion",
      invalidGameResult,
    ),
    branchId: expectNonEmptyString(
      record["branchId"],
      "fork result.branchId",
      "INVALID_GAME_RESULT",
    ),
    checkpointId: expectNonEmptyString(
      record["checkpointId"],
      "fork result.checkpointId",
      "INVALID_GAME_RESULT",
    ),
    controls: parseJsonObject(
      record["controls"],
      "fork result.controls",
      "INVALID_GAME_RESULT",
    ),
  };
}

export function parseReplayRequest(value: unknown): ReplayTimelineRequest {
  const record = expectRecord(value, "replay request", (path, message) => {
    throw new PiHarnessError("INVALID_ARGUMENT", `${path}: ${message}`);
  });
  expectOnlyKeys(record, ["branchId"], "replay request", (path, message) => {
    throw new PiHarnessError("INVALID_ARGUMENT", `${path}: ${message}`);
  });
  return {
    branchId: expectNonEmptyString(
      record["branchId"],
      "replay request.branchId",
    ),
  };
}

export function parseAgentReplayResult(value: unknown): AgentReplayResult {
  const record = expectRecord(value, "replay result", invalidGameResult);
  expectOnlyKeys(
    record,
    [
      "schemaVersion",
      "branchId",
      "outcome",
      "evidenceIds",
      "finalCheckpointId",
      "summary",
      "details",
    ],
    "replay result",
    invalidGameResult,
  );
  return {
    schemaVersion: expectLiteralOne(
      record["schemaVersion"],
      "replay result.schemaVersion",
      invalidGameResult,
    ),
    branchId: expectNonEmptyString(
      record["branchId"],
      "replay result.branchId",
      "INVALID_GAME_RESULT",
    ),
    outcome: expectOutcome(
      record["outcome"],
      "replay result.outcome",
      invalidGameResult,
    ),
    evidenceIds: expectStringArray(
      record["evidenceIds"],
      "replay result.evidenceIds",
      invalidGameResult,
    ),
    finalCheckpointId: expectNonEmptyString(
      record["finalCheckpointId"],
      "replay result.finalCheckpointId",
      "INVALID_GAME_RESULT",
    ),
    summary: expectNonEmptyString(
      record["summary"],
      "replay result.summary",
      "INVALID_GAME_RESULT",
    ),
    details: parseJsonObject(
      record["details"],
      "replay result.details",
      "INVALID_GAME_RESULT",
    ),
  };
}

export function parseCompareRequest(value: unknown): CompareTimelinesRequest {
  const record = expectRecord(value, "compare request", (path, message) => {
    throw new PiHarnessError("INVALID_ARGUMENT", `${path}: ${message}`);
  });
  expectOnlyKeys(
    record,
    ["baselineBranchId", "candidateBranchId"],
    "compare request",
    (path, message) => {
      throw new PiHarnessError("INVALID_ARGUMENT", `${path}: ${message}`);
    },
  );
  return {
    baselineBranchId: expectNonEmptyString(
      record["baselineBranchId"],
      "compare request.baselineBranchId",
    ),
    candidateBranchId: expectNonEmptyString(
      record["candidateBranchId"],
      "compare request.candidateBranchId",
    ),
  };
}

export function parseAgentTimelineComparison(
  value: unknown,
): AgentTimelineComparison {
  const record = expectRecord(value, "comparison result", invalidGameResult);
  expectOnlyKeys(
    record,
    [
      "schemaVersion",
      "baselineBranchId",
      "candidateBranchId",
      "baselineOutcome",
      "candidateOutcome",
      "evidenceIds",
      "firstDivergenceTick",
      "summary",
      "details",
    ],
    "comparison result",
    invalidGameResult,
  );
  const divergence = record["firstDivergenceTick"];
  if (
    divergence !== null &&
    (typeof divergence !== "number" ||
      !Number.isInteger(divergence) ||
      divergence < 0)
  ) {
    invalidGameResult(
      "comparison result.firstDivergenceTick",
      "expected a non-negative integer or null",
    );
  }
  return {
    schemaVersion: expectLiteralOne(
      record["schemaVersion"],
      "comparison result.schemaVersion",
      invalidGameResult,
    ),
    baselineBranchId: expectNonEmptyString(
      record["baselineBranchId"],
      "comparison result.baselineBranchId",
      "INVALID_GAME_RESULT",
    ),
    candidateBranchId: expectNonEmptyString(
      record["candidateBranchId"],
      "comparison result.candidateBranchId",
      "INVALID_GAME_RESULT",
    ),
    baselineOutcome: expectOutcome(
      record["baselineOutcome"],
      "comparison result.baselineOutcome",
      invalidGameResult,
    ),
    candidateOutcome: expectOutcome(
      record["candidateOutcome"],
      "comparison result.candidateOutcome",
      invalidGameResult,
    ),
    evidenceIds: expectStringArray(
      record["evidenceIds"],
      "comparison result.evidenceIds",
      invalidGameResult,
    ),
    firstDivergenceTick: divergence,
    summary: expectNonEmptyString(
      record["summary"],
      "comparison result.summary",
      "INVALID_GAME_RESULT",
    ),
    details: parseJsonObject(
      record["details"],
      "comparison result.details",
      "INVALID_GAME_RESULT",
    ),
  };
}

function parseDiagnosisExperiment(
  value: unknown,
  index: number,
): DiagnosisExperiment {
  const path = `diagnosis.experiments[${index}]`;
  const record = expectRecord(value, path, invalidDiagnosis);
  expectOnlyKeys(
    record,
    ["branchId", "outcome", "evidenceIds", "observation"],
    path,
    invalidDiagnosis,
  );
  return {
    branchId: expectNonEmptyString(
      record["branchId"],
      `${path}.branchId`,
      "INVALID_DIAGNOSIS",
    ),
    outcome: expectOutcome(
      record["outcome"],
      `${path}.outcome`,
      invalidDiagnosis,
    ),
    evidenceIds: expectStringArray(
      record["evidenceIds"],
      `${path}.evidenceIds`,
      invalidDiagnosis,
    ),
    observation: expectNonEmptyString(
      record["observation"],
      `${path}.observation`,
      "INVALID_DIAGNOSIS",
    ),
  };
}

function parseDiagnosisComparison(
  value: unknown,
  index: number,
): DiagnosisComparison {
  const path = `diagnosis.comparisons[${index}]`;
  const record = expectRecord(value, path, invalidDiagnosis);
  expectOnlyKeys(
    record,
    ["baselineBranchId", "candidateBranchId", "finding"],
    path,
    invalidDiagnosis,
  );
  return {
    baselineBranchId: expectNonEmptyString(
      record["baselineBranchId"],
      `${path}.baselineBranchId`,
      "INVALID_DIAGNOSIS",
    ),
    candidateBranchId: expectNonEmptyString(
      record["candidateBranchId"],
      `${path}.candidateBranchId`,
      "INVALID_DIAGNOSIS",
    ),
    finding: expectNonEmptyString(
      record["finding"],
      `${path}.finding`,
      "INVALID_DIAGNOSIS",
    ),
  };
}

export function parseDiagnosisReport(value: unknown): DiagnosisReport {
  const record = expectRecord(value, "diagnosis", invalidDiagnosis);
  expectOnlyKeys(
    record,
    [
      "schemaVersion",
      "conclusion",
      "confidence",
      "evidenceIds",
      "experiments",
      "comparisons",
      "suggestedFix",
    ],
    "diagnosis",
    invalidDiagnosis,
  );

  const confidence = record["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    invalidDiagnosis("diagnosis.confidence", "expected a number from 0 to 1");
  }
  if (!Array.isArray(record["experiments"])) {
    invalidDiagnosis("diagnosis.experiments", "expected an array");
  }
  if (record["experiments"].length === 0) {
    invalidDiagnosis(
      "diagnosis.experiments",
      "expected at least one experiment",
    );
  }
  if (!Array.isArray(record["comparisons"])) {
    invalidDiagnosis("diagnosis.comparisons", "expected an array");
  }
  if (record["comparisons"].length === 0) {
    invalidDiagnosis(
      "diagnosis.comparisons",
      "expected at least one comparison",
    );
  }

  return {
    schemaVersion: expectLiteralOne(
      record["schemaVersion"],
      "diagnosis.schemaVersion",
      invalidDiagnosis,
    ),
    conclusion: expectNonEmptyString(
      record["conclusion"],
      "diagnosis.conclusion",
      "INVALID_DIAGNOSIS",
    ),
    confidence,
    evidenceIds: expectStringArray(
      record["evidenceIds"],
      "diagnosis.evidenceIds",
      invalidDiagnosis,
      1,
    ),
    experiments: record["experiments"].map(parseDiagnosisExperiment),
    comparisons: record["comparisons"].map(parseDiagnosisComparison),
    suggestedFix: expectNonEmptyString(
      record["suggestedFix"],
      "diagnosis.suggestedFix",
      "INVALID_DIAGNOSIS",
    ),
  };
}
