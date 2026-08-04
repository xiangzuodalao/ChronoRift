import {
  BranchSpecSchema,
  CapsuleIdSchema,
  DiagnosisProposalSchema,
  EvidenceCapsuleSchema,
  ExecutionComparisonSchema,
  ExecutionIdSchema,
  ExecutionLogSchema,
  type CapsuleId,
  type DiagnosisProposal,
  type EvidenceCapsule,
  type ExecutionComparison,
  type ExecutionId,
} from "@chronorift/domain";

import { PiHarnessError } from "../errors.js";
import type {
  AgentInterventionResult,
  AgentReplayResult,
  CompareExecutionsRequest,
  RunInterventionRequest,
} from "../types.js";

type UnknownRecord = Record<string, unknown>;

function formatIssues(
  issues: readonly { readonly path: PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function parseDomain<T>(
  schema: {
    safeParse(value: unknown):
      | { readonly success: true; readonly data: T }
      | {
          readonly success: false;
          readonly error: {
            readonly issues: readonly {
              readonly path: PropertyKey[];
              readonly message: string;
            }[];
          };
        };
  },
  value: unknown,
  label: string,
  code: "INVALID_ARGUMENT" | "INVALID_GAME_RESULT" | "INVALID_DIAGNOSIS",
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PiHarnessError(
      code,
      `${label}: ${formatIssues(result.error.issues)}`,
    );
  }
  return structuredClone(result.data);
}

function expectRecord(
  value: unknown,
  label: string,
  code: "INVALID_ARGUMENT" | "INVALID_GAME_RESULT",
): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PiHarnessError(code, `${label}: expected an object`);
  }
  return value as UnknownRecord;
}

function expectOnlyKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  label: string,
  code: "INVALID_ARGUMENT" | "INVALID_GAME_RESULT",
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new PiHarnessError(
      code,
      `${label}: unexpected properties: ${unexpected.join(", ")}`,
    );
  }
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

export function parseCapsuleId(value: unknown): CapsuleId {
  return parseDomain(CapsuleIdSchema, value, "capsuleId", "INVALID_ARGUMENT");
}

export function parseExecutionId(
  value: unknown,
  path = "executionId",
): ExecutionId {
  return parseDomain(ExecutionIdSchema, value, path, "INVALID_ARGUMENT");
}

export function parseEvidenceCapsule(value: unknown): EvidenceCapsule {
  return parseDomain(
    EvidenceCapsuleSchema,
    value,
    "evidence capsule",
    "INVALID_GAME_RESULT",
  );
}

export function parseReplayRequest(value: unknown): {
  readonly executionId: ExecutionId;
} {
  const record = expectRecord(value, "replay request", "INVALID_ARGUMENT");
  expectOnlyKeys(record, ["executionId"], "replay request", "INVALID_ARGUMENT");
  return {
    executionId: parseExecutionId(
      record["executionId"],
      "replay request.executionId",
    ),
  };
}

export function parseAgentReplayResult(value: unknown): AgentReplayResult {
  const record = expectRecord(value, "replay result", "INVALID_GAME_RESULT");
  expectOnlyKeys(
    record,
    ["execution", "matches", "sourceDigest", "replayDigest"],
    "replay result",
    "INVALID_GAME_RESULT",
  );
  if (typeof record["matches"] !== "boolean") {
    throw new PiHarnessError(
      "INVALID_GAME_RESULT",
      "replay result.matches: expected a boolean",
    );
  }
  return {
    execution: parseDomain(
      ExecutionLogSchema,
      record["execution"],
      "replay result.execution",
      "INVALID_GAME_RESULT",
    ),
    matches: record["matches"],
    sourceDigest: expectNonEmptyString(
      record["sourceDigest"],
      "replay result.sourceDigest",
      "INVALID_GAME_RESULT",
    ),
    replayDigest: expectNonEmptyString(
      record["replayDigest"],
      "replay result.replayDigest",
      "INVALID_GAME_RESULT",
    ),
  };
}

export function parseRunInterventionRequest(
  value: unknown,
): RunInterventionRequest {
  const record = expectRecord(
    value,
    "intervention request",
    "INVALID_ARGUMENT",
  );
  expectOnlyKeys(
    record,
    ["baselineExecutionId", "deltaTicks"],
    "intervention request",
    "INVALID_ARGUMENT",
  );
  if (record["deltaTicks"] !== 1) {
    throw new PiHarnessError(
      "INVALID_ARGUMENT",
      "intervention request.deltaTicks: v0.1 only supports exactly 1",
    );
  }
  return {
    baselineExecutionId: parseExecutionId(
      record["baselineExecutionId"],
      "intervention request.baselineExecutionId",
    ),
    deltaTicks: 1,
  };
}

export function parseAgentInterventionResult(
  value: unknown,
): AgentInterventionResult {
  const record = expectRecord(
    value,
    "intervention result",
    "INVALID_GAME_RESULT",
  );
  expectOnlyKeys(
    record,
    ["branch", "execution"],
    "intervention result",
    "INVALID_GAME_RESULT",
  );
  return {
    branch: parseDomain(
      BranchSpecSchema,
      record["branch"],
      "intervention result.branch",
      "INVALID_GAME_RESULT",
    ),
    execution: parseDomain(
      ExecutionLogSchema,
      record["execution"],
      "intervention result.execution",
      "INVALID_GAME_RESULT",
    ),
  };
}

export function parseCompareRequest(value: unknown): CompareExecutionsRequest {
  const record = expectRecord(value, "compare request", "INVALID_ARGUMENT");
  expectOnlyKeys(
    record,
    ["baselineExecutionId", "candidateExecutionId"],
    "compare request",
    "INVALID_ARGUMENT",
  );
  return {
    baselineExecutionId: parseExecutionId(
      record["baselineExecutionId"],
      "compare request.baselineExecutionId",
    ),
    candidateExecutionId: parseExecutionId(
      record["candidateExecutionId"],
      "compare request.candidateExecutionId",
    ),
  };
}

export function parseExecutionComparison(value: unknown): ExecutionComparison {
  return parseDomain(
    ExecutionComparisonSchema,
    value,
    "execution comparison",
    "INVALID_GAME_RESULT",
  );
}

export function parseDiagnosisProposal(value: unknown): DiagnosisProposal {
  return parseDomain(
    DiagnosisProposalSchema,
    value,
    "diagnosis proposal",
    "INVALID_DIAGNOSIS",
  );
}
