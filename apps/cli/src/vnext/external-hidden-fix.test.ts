import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asSha256DigestV1 } from "@chronorift/domain";
import { describe, expect, it, vi } from "vitest";

import {
  ExternalHiddenFixEvaluationRequestV1Schema,
  ExternalHiddenFixTerminalOutcomeV1Schema,
  createExternalHiddenFixEvaluationRequestV1,
  createExternalHiddenFixFreshCopyAcceptanceReceiptV1,
  createExternalHiddenFixFreshEvaluationPlanV1,
  createExternalHiddenFixTerminalRecordV1,
  openExternalHiddenFixAssignmentStoreV1,
  runExternalHiddenFixEvaluatorOnceV1,
  type CreateExternalHiddenFixAssignmentV1Input,
  type ExternalHiddenFixAssignmentStoreV1,
  type ExternalHiddenFixAssignmentV1,
  type ExternalHiddenFixEvaluationRequestV1,
  type ExternalHiddenFixFreshCopyRunInputV1,
  type ExternalHiddenFixFreshRunReceiptV1,
  type ExternalHiddenFixTerminalOutcomeV1,
} from "./external-hidden-fix.js";
import {
  ExternalHiddenFixWorkflowAuditV1Schema,
  checkExternalHiddenFixWorkflowV1,
  createExternalHiddenFixWorkflowAuditV1,
} from "./external-hidden-fix-workflow.js";

const sha = (value: string | Uint8Array) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));
const repeatedHash = (character: string) =>
  asSha256DigestV1(character.repeat(64));

interface Fixture {
  readonly parent: string;
  readonly hiddenRoot: string;
  readonly exposedRoot: string;
  readonly baselineRoot: string;
  readonly mutationPath: string;
  readonly evaluatorImplementationPath: string;
  readonly evaluatorBundlePath: string;
  readonly assignmentInput: CreateExternalHiddenFixAssignmentV1Input;
  readonly store: ExternalHiddenFixAssignmentStoreV1;
}

const writePrivate = async (path: string, bytes: string): Promise<string> => {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
};

const fixture = async (): Promise<Fixture> => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-m6-core-"));
  await chmod(parent, 0o700);
  const hiddenRoot = join(parent, "host-only");
  const exposedRoot = join(parent, "agent-exposed");
  const baselineRoot = join(hiddenRoot, "mutated-baseline");
  await Promise.all([
    mkdir(hiddenRoot, { mode: 0o700 }),
    mkdir(exposedRoot, { mode: 0o700 }),
  ]);
  await mkdir(baselineRoot, { mode: 0o700 });
  await mkdir(join(baselineRoot, "scripts"), { mode: 0o755 });
  await writeFile(join(baselineRoot, "project.godot"), "[application]\n", {
    mode: 0o644,
  });
  await writeFile(
    join(baselineRoot, "scripts", "player.gd"),
    "extends Node\n",
    {
      mode: 0o644,
    },
  );
  const mutationBytes = "diff --git a/scripts/player.gd b/scripts/player.gd\n";
  const evaluatorImplementationBytes = "evaluator implementation v1\n";
  const evaluatorBundleBytes = '{"scenarios":3,"repetitions":3}\n';
  const mutationPath = await writePrivate(
    join(hiddenRoot, "mutation.patch"),
    mutationBytes,
  );
  const evaluatorImplementationPath = await writePrivate(
    join(hiddenRoot, "evaluator.mjs"),
    evaluatorImplementationBytes,
  );
  const evaluatorBundlePath = await writePrivate(
    join(hiddenRoot, "evaluator-bundle.json"),
    evaluatorBundleBytes,
  );
  const assignmentInput: CreateExternalHiddenFixAssignmentV1Input = {
    schemaVersion: 1,
    subjectProjectSha256: repeatedHash("1"),
    pristineSelectedTreeSha256: repeatedHash("2"),
    mutatedBaselineSelectedTreeSha256: repeatedHash("3"),
    publicTaskSpecSha256: repeatedHash("4"),
    taskBlindAdapterSha256: repeatedHash("5"),
    mutationSha256: sha(mutationBytes),
    evaluatorImplementationSha256: sha(evaluatorImplementationBytes),
    evaluatorBundleSha256: sha(evaluatorBundleBytes),
    baselineRoot,
    mutationPath,
    evaluatorImplementationPath,
    evaluatorBundlePath,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
  const store = await openExternalHiddenFixAssignmentStoreV1({
    root: hiddenRoot,
    exposedRoots: [exposedRoot],
  });
  return {
    parent,
    hiddenRoot,
    exposedRoot,
    baselineRoot,
    mutationPath,
    evaluatorImplementationPath,
    evaluatorBundlePath,
    assignmentInput,
    store,
  };
};

const createAssignment = async (
  value: Fixture,
): Promise<ExternalHiddenFixAssignmentV1> =>
  value.store.createAssignment(value.assignmentInput);

const patchReference = {
  schemaVersion: 1 as const,
  artifactId: `m6-artifact:${"a".repeat(64)}`,
  rawSha256: repeatedHash("b"),
  byteLength: 128,
};

const evaluationRequest = (
  assignment: ExternalHiddenFixAssignmentV1,
): ExternalHiddenFixEvaluationRequestV1 =>
  createExternalHiddenFixEvaluationRequestV1({
    assignmentId: assignment.assignmentId,
    patch: patchReference,
    expectedCandidateSelectedTreeSha256: repeatedHash("c"),
  });

const attemptBinding = (assignment: ExternalHiddenFixAssignmentV1) => ({
  schemaVersion: 1 as const,
  assignmentId: assignment.assignmentId,
  agentProjectionContentSha256: repeatedHash("d"),
  publicTaskSpecSha256: assignment.publicTaskSpecSha256,
  taskId: "task:m6-hidden-fix",
  provider: "test-provider",
  model: "test-model",
  thinkingLevel: "max" as const,
  agentBudgetSha256: repeatedHash("e"),
  workspaceBaselineSelectedTreeSha256:
    assignment.mutatedBaselineSelectedTreeSha256,
  taskBlindAdapterSha256: assignment.taskBlindAdapterSha256,
  admittedToolSetSha256: repeatedHash("f"),
  sandboxRealizationSha256: repeatedHash("0"),
});

const successfulRun = (
  input: ExternalHiddenFixFreshCopyRunInputV1,
  outcome: "passed" | "failed" = "passed",
): ExternalHiddenFixFreshRunReceiptV1 => ({
  schemaVersion: 1,
  assignmentId: input.assignmentId,
  freshCopyId: input.plan.freshCopyId,
  ordinal: input.plan.ordinal,
  scenarioClass: input.plan.scenarioClass,
  repetition: input.plan.repetition,
  baselineSelectedTreeSha256: input.baselineSelectedTreeSha256,
  candidateSelectedTreeSha256: input.expectedCandidateSelectedTreeSha256,
  patchSha256: input.patch.rawSha256,
  freshWorkspaceCreated: true,
  freshImportCacheCreated: true,
  freshProcessStarted: true,
  outcome,
  observationSha256: sha(
    `${input.assignmentId}\0${input.plan.freshCopyId}\0${outcome}`,
  ),
  cleanupProven: true,
});

const workflowEvidence = (
  assignment: ExternalHiddenFixAssignmentV1,
  candidateSelectedTreeSha256 = repeatedHash("c"),
) => {
  const patchIdentity = {
    schemaVersion: 1 as const,
    baselineSelectedTreeSha256: assignment.mutatedBaselineSelectedTreeSha256,
    candidateSelectedTreeSha256,
    patchSha256: patchReference.rawSha256,
    byteLength: patchReference.byteLength,
  };
  const workflowInput = {
    schemaVersion: 1 as const,
    assignmentId: assignment.assignmentId,
    agentTurnCount: 1,
    agentLoopStatus: "completed" as const,
    baselineSelectedTreeSha256: assignment.mutatedBaselineSelectedTreeSha256,
    patchIdentity,
    patchObservedAt: "2026-08-14T00:00:05.000Z",
    patchAdmissible: true,
    patchRoundTripVerified: true,
    sourceObservations: [
      {
        schemaVersion: 1 as const,
        boundary: "game_build_freeze" as const,
        sourceSha256: assignment.mutatedBaselineSelectedTreeSha256,
        buildId: "build.baseline",
        observedAt: "2026-08-14T00:00:01.000Z",
      },
      {
        schemaVersion: 1 as const,
        boundary: "coding_tool_return" as const,
        sourceSha256: candidateSelectedTreeSha256,
        buildId: null,
        observedAt: "2026-08-14T00:00:03.000Z",
      },
      {
        schemaVersion: 1 as const,
        boundary: "game_build_freeze" as const,
        sourceSha256: candidateSelectedTreeSha256,
        buildId: "build.candidate",
        observedAt: "2026-08-14T00:00:03.100Z",
      },
    ],
    executions: [
      {
        schemaVersion: 1 as const,
        executionId: "execution.baseline",
        buildId: "build.baseline",
        sourceSha256: assignment.mutatedBaselineSelectedTreeSha256,
        startedAt: "2026-08-14T00:00:01.100Z",
        endedAt: "2026-08-14T00:00:02.000Z",
        sealed: true,
        coverageComplete: true,
        cleanupProven: true,
        publicSymptomObserved: true,
        publicObservationSha256: repeatedHash("8"),
      },
      {
        schemaVersion: 1 as const,
        executionId: "execution.candidate",
        buildId: "build.candidate",
        sourceSha256: candidateSelectedTreeSha256,
        startedAt: "2026-08-14T00:00:03.200Z",
        endedAt: "2026-08-14T00:00:04.000Z",
        sealed: true,
        coverageComplete: true,
        cleanupProven: true,
        publicSymptomObserved: false,
        publicObservationSha256: repeatedHash("9"),
      },
    ],
    taskCleanupProven: true,
  };
  const receipt = checkExternalHiddenFixWorkflowV1(workflowInput);
  const audit = createExternalHiddenFixWorkflowAuditV1({
    workflowInput,
    workflowReceipt: receipt,
  });
  return { workflowInput, receipt, audit };
};

const putWorkflowEvidence = async (
  store: ExternalHiddenFixAssignmentStoreV1,
  assignment: ExternalHiddenFixAssignmentV1,
): Promise<void> => {
  const evidence = workflowEvidence(assignment);
  await store.putWorkflowAuditOnce({
    assignmentId: assignment.assignmentId,
    audit: evidence.audit,
    parse: (value) => ExternalHiddenFixWorkflowAuditV1Schema.parse(value),
  });
  await store.putWorkflowReceiptOnce(evidence.receipt, (value) =>
    ExternalHiddenFixWorkflowAuditV1Schema.parse(value),
  );
};

describe("M6 Host-only hidden-fix core", () => {
  it("retains a strict create-once workflow audit across reopen and detects tampering", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await value.store.beginAttemptOnce({
        binding: attemptBinding(assignment),
        startedAt: "2026-08-14T00:00:01.000Z",
      });
      const evidence = workflowEvidence(assignment);
      const parseAudit = (input: unknown) =>
        ExternalHiddenFixWorkflowAuditV1Schema.parse(input);

      await expect(
        value.store.putWorkflowReceiptOnce(evidence.receipt, parseAudit),
      ).rejects.toThrow();
      await value.store.putWorkflowAuditOnce({
        assignmentId: assignment.assignmentId,
        audit: evidence.audit,
        parse: parseAudit,
      });

      const reopened = await openExternalHiddenFixAssignmentStoreV1({
        root: value.hiddenRoot,
        exposedRoots: [value.exposedRoot],
      });
      expect(
        await reopened.readWorkflowAudit(assignment.assignmentId, parseAudit),
      ).toEqual(evidence.audit);
      await expect(
        reopened.putWorkflowAuditOnce({
          assignmentId: assignment.assignmentId,
          audit: evidence.audit,
          parse: parseAudit,
        }),
      ).rejects.toThrow(/already exists/u);
      const crossedEvidence = workflowEvidence(assignment, repeatedHash("d"));
      await expect(
        reopened.putWorkflowReceiptOnce(crossedEvidence.receipt, parseAudit),
      ).rejects.toThrow(/does not match its retained workflow audit/u);
      await reopened.putWorkflowReceiptOnce(evidence.receipt, parseAudit);

      const auditPath = join(
        value.hiddenRoot,
        `${sha(assignment.assignmentId)}.workflow-audit.json`,
      );
      const tampered = JSON.parse(await readFile(auditPath, "utf8")) as {
        workflowInput: { taskCleanupProven: boolean };
      };
      tampered.workflowInput.taskCleanupProven = false;
      await writeFile(auditPath, `${JSON.stringify(tampered)}\n`, {
        mode: 0o600,
      });
      await expect(
        reopened.readWorkflowAudit(assignment.assignmentId, parseAudit),
      ).rejects.toThrow(/content hash/u);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("creates one protected assignment and resolves its baseline only inside the evaluator", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await value.store.beginAttemptOnce({
        binding: attemptBinding(assignment),
        startedAt: "2026-08-14T00:00:01.000Z",
      });
      await putWorkflowEvidence(value.store, assignment);
      const request = evaluationRequest(assignment);
      expect(Object.keys(request).sort()).toEqual([
        "assignmentId",
        "expectedCandidateSelectedTreeSha256",
        "patch",
        "requestContentSha256",
        "requestKind",
        "schemaVersion",
      ]);
      expect(JSON.stringify(request)).not.toMatch(
        /baseline|patchIdentity|taskId|runtime|workflow|prompt|adapter/iu,
      );
      expect(() =>
        ExternalHiddenFixEvaluationRequestV1Schema.parse({
          ...request,
          baselineRoot: value.baselineRoot,
        }),
      ).toThrow();

      const observedInputs: ExternalHiddenFixFreshCopyRunInputV1[] = [];
      const result = await runExternalHiddenFixEvaluatorOnceV1({
        store: value.store,
        request,
        runner: {
          runFreshCopy: (input) => {
            observedInputs.push(input);
            return Promise.resolve(successfulRun(input));
          },
        },
      });
      expect(result.outcome).toBe("accepted");
      expect(observedInputs).toHaveLength(9);
      expect(observedInputs[0]).toMatchObject({
        baselineRoot: value.baselineRoot,
        baselineSelectedTreeSha256:
          assignment.mutatedBaselineSelectedTreeSha256,
      });
      for (const input of observedInputs) {
        expect(Object.keys(input).join("\n")).not.toMatch(
          /taskId|runtime|workflow|prompt|adapter|agent/iu,
        );
      }
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("freezes the complete deterministic three-by-three fresh-copy plan", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      const plan = createExternalHiddenFixFreshEvaluationPlanV1(
        assignment.assignmentId,
      );
      expect(plan).toHaveLength(9);
      expect(new Set(plan.map((entry) => entry.freshCopyId)).size).toBe(9);
      expect(
        plan.map((entry) => [entry.scenarioClass, entry.repetition]),
      ).toEqual([
        ["public_reproduction", 1],
        ["public_reproduction", 2],
        ["public_reproduction", 3],
        ["hidden_variant", 1],
        ["hidden_variant", 2],
        ["hidden_variant", 3],
        ["regression_control", 1],
        ["regression_control", 2],
        ["regression_control", 3],
      ]);
      expect(plan.every((entry) => entry.requiresFreshWorkspace)).toBe(true);
      expect(plan.every((entry) => entry.requiresFreshImportCache)).toBe(true);
      expect(plan.every((entry) => entry.requiresFreshProcess)).toBe(true);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("refuses evaluator or accepted-terminal persistence without their stored receipts", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await value.store.beginAttemptOnce({
        binding: attemptBinding(assignment),
        startedAt: "2026-08-14T00:00:01.000Z",
      });
      const runner = vi.fn();
      await expect(
        runExternalHiddenFixEvaluatorOnceV1({
          store: value.store,
          request: evaluationRequest(assignment),
          runner: { runFreshCopy: runner },
        }),
      ).rejects.toThrow(/verified public workflow/u);
      expect(runner).not.toHaveBeenCalled();

      const forged = createExternalHiddenFixTerminalRecordV1({
        assignmentId: assignment.assignmentId,
        outcome: "accepted",
        agentFailureCode: null,
        noCandidateReason: null,
        primaryOutcome: null,
        patchSha256: repeatedHash("a"),
        workflowReceiptSha256: repeatedHash("b"),
        evaluatorReceiptSha256: repeatedHash("c"),
        cleanupReceiptSha256: repeatedHash("d"),
        completedAt: "2026-08-14T00:00:10.000Z",
      });
      await expect(value.store.putTerminalOnce(forged)).rejects.toThrow();
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("rejects an Agent attempt detached from the assignment baseline", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await expect(
        value.store.beginAttemptOnce({
          binding: {
            ...attemptBinding(assignment),
            workspaceBaselineSelectedTreeSha256: repeatedHash("9"),
          },
          startedAt: "2026-08-14T00:00:01.000Z",
        }),
      ).rejects.toThrow(/crossed its frozen assignment identities/u);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("refuses to evaluate a candidate different from the frozen public workflow candidate", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await value.store.beginAttemptOnce({
        binding: attemptBinding(assignment),
        startedAt: "2026-08-14T00:00:01.000Z",
      });
      await putWorkflowEvidence(value.store, assignment);
      const crossedRequest = createExternalHiddenFixEvaluationRequestV1({
        assignmentId: assignment.assignmentId,
        patch: {
          ...patchReference,
          artifactId: `m6-artifact:${repeatedHash("8")}`,
          rawSha256: repeatedHash("8"),
        },
        expectedCandidateSelectedTreeSha256: repeatedHash("9"),
      });
      await expect(
        value.store.claimEvaluatorRequestOnce(crossedRequest),
      ).rejects.toThrow(/crossed the candidate verified/u);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("refuses an evaluator receipt detached from the frozen evaluator bytes", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await value.store.beginAttemptOnce({
        binding: attemptBinding(assignment),
        startedAt: "2026-08-14T00:00:01.000Z",
      });
      await putWorkflowEvidence(value.store, assignment);
      const request = evaluationRequest(assignment);
      await value.store.claimEvaluatorRequestOnce(request);
      const completedRuns = createExternalHiddenFixFreshEvaluationPlanV1(
        assignment.assignmentId,
      ).map((plan) =>
        successfulRun({
          assignmentId: assignment.assignmentId,
          baselineRoot: assignment.baselineRoot,
          baselineSelectedTreeSha256:
            assignment.mutatedBaselineSelectedTreeSha256,
          evaluatorImplementationPath: assignment.evaluatorImplementationPath,
          evaluatorImplementationSha256:
            assignment.evaluatorImplementationSha256,
          evaluatorBundlePath: assignment.evaluatorBundlePath,
          evaluatorBundleSha256: assignment.evaluatorBundleSha256,
          patch: request.patch,
          expectedCandidateSelectedTreeSha256:
            request.expectedCandidateSelectedTreeSha256,
          plan,
        }),
      );
      const crossedReceipt =
        createExternalHiddenFixFreshCopyAcceptanceReceiptV1({
          assignmentId: assignment.assignmentId,
          requestContentSha256: request.requestContentSha256,
          baselineSelectedTreeSha256:
            assignment.mutatedBaselineSelectedTreeSha256,
          expectedCandidateSelectedTreeSha256:
            request.expectedCandidateSelectedTreeSha256,
          patchSha256: request.patch.rawSha256,
          evaluatorImplementationSha256: repeatedHash("9"),
          evaluatorBundleSha256: assignment.evaluatorBundleSha256,
          completedRuns,
          infrastructureFailureCode: null,
          cleanupProven: true,
        });
      await expect(
        value.store.putEvaluatorReceiptOnce(crossedReceipt),
      ).rejects.toThrow(/detached from its assignment/u);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("refuses assignment, Agent-attempt, evaluator, and terminal reruns without losing the first records", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await expect(createAssignment(value)).rejects.toThrow(/already exists/u);
      const attempt = await value.store.beginAttemptOnce({
        binding: attemptBinding(assignment),
        startedAt: "2026-08-14T00:00:01.000Z",
      });
      await expect(
        value.store.beginAttemptOnce({
          binding: attemptBinding(assignment),
          startedAt: "2026-08-14T00:00:02.000Z",
        }),
      ).rejects.toThrow(/reruns/u);
      await putWorkflowEvidence(value.store, assignment);
      const runner = vi.fn((input: ExternalHiddenFixFreshCopyRunInputV1) =>
        Promise.resolve(successfulRun(input)),
      );
      const request = evaluationRequest(assignment);
      const accepted = await runExternalHiddenFixEvaluatorOnceV1({
        store: value.store,
        request,
        runner: { runFreshCopy: runner },
      });
      expect(runner).toHaveBeenCalledTimes(9);
      await expect(
        runExternalHiddenFixEvaluatorOnceV1({
          store: value.store,
          request,
          runner: { runFreshCopy: runner },
        }),
      ).rejects.toThrow(/reruns/u);
      expect(runner).toHaveBeenCalledTimes(9);

      const terminal = createExternalHiddenFixTerminalRecordV1({
        assignmentId: assignment.assignmentId,
        outcome: "accepted",
        agentFailureCode: null,
        noCandidateReason: null,
        primaryOutcome: null,
        patchSha256: request.patch.rawSha256,
        workflowReceiptSha256: (
          await value.store.readWorkflowReceipt(assignment.assignmentId)
        ).receiptContentSha256,
        evaluatorReceiptSha256: accepted.receiptContentSha256,
        cleanupReceiptSha256: repeatedHash("9"),
        completedAt: "2026-08-14T00:00:10.000Z",
      });
      await value.store.putTerminalOnce(terminal);
      await expect(value.store.putTerminalOnce(terminal)).rejects.toThrow(
        /overwrites/u,
      );
      expect(await value.store.readAttempt(assignment.assignmentId)).toEqual(
        attempt,
      );
      expect(await value.store.readTerminal(assignment.assignmentId)).toEqual(
        terminal,
      );
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("retains a nine-run behavioral rejection and never retries it", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await value.store.beginAttemptOnce({
        binding: attemptBinding(assignment),
        startedAt: "2026-08-14T00:00:01.000Z",
      });
      await putWorkflowEvidence(value.store, assignment);
      const runner = vi.fn((input: ExternalHiddenFixFreshCopyRunInputV1) =>
        Promise.resolve(
          successfulRun(input, input.plan.ordinal === 5 ? "failed" : "passed"),
        ),
      );
      const receipt = await runExternalHiddenFixEvaluatorOnceV1({
        store: value.store,
        request: evaluationRequest(assignment),
        runner: { runFreshCopy: runner },
      });
      expect(receipt).toMatchObject({
        outcome: "rejected",
        plannedRunCount: 9,
        cleanupProven: true,
      });
      expect(receipt.completedRuns).toHaveLength(9);
      expect(receipt.completedRuns[4]?.outcome).toBe("failed");
      expect(
        await value.store.readEvaluatorReceipt(assignment.assignmentId),
      ).toEqual(receipt);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("retains infrastructure failure without inventing observations or starting later fresh copies", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await value.store.beginAttemptOnce({
        binding: attemptBinding(assignment),
        startedAt: "2026-08-14T00:00:01.000Z",
      });
      await putWorkflowEvidence(value.store, assignment);
      let calls = 0;
      const receipt = await runExternalHiddenFixEvaluatorOnceV1({
        store: value.store,
        request: evaluationRequest(assignment),
        runner: {
          runFreshCopy: (input) => {
            calls += 1;
            if (calls === 4) throw new Error("fresh copy unavailable");
            return Promise.resolve(successfulRun(input));
          },
        },
      });
      expect(calls).toBe(4);
      expect(receipt).toMatchObject({
        outcome: "infrastructure_failed",
        infrastructureFailureCode: "runner_failed",
        cleanupProven: false,
      });
      expect(receipt.completedRuns).toHaveLength(3);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("preserves a concrete fresh-copy failure code after proven cleanup", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      await value.store.beginAttemptOnce({
        binding: attemptBinding(assignment),
        startedAt: "2026-08-14T00:00:01.000Z",
      });
      await putWorkflowEvidence(value.store, assignment);
      const receipt = await runExternalHiddenFixEvaluatorOnceV1({
        store: value.store,
        request: evaluationRequest(assignment),
        runner: {
          runFreshCopy: () => {
            throw Object.assign(new Error("candidate identity mismatch"), {
              failureCode: "candidate_tree_mismatch" as const,
              cleanupProven: true,
            });
          },
        },
      });
      expect(receipt).toMatchObject({
        outcome: "infrastructure_failed",
        infrastructureFailureCode: "candidate_tree_mismatch",
        cleanupProven: true,
        completedRuns: [],
      });
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("keeps the public workflow receipt structurally separate from evaluator identities", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      const receipt = workflowEvidence(assignment).receipt;
      expect(JSON.stringify(receipt)).not.toMatch(
        /evaluatorImplementation|evaluatorBundle|mutationPath|baselineRoot/iu,
      );
      expect(receipt.outcome).toBe("verified");
      expect(receipt.checks[1]?.check).toBe(
        "baseline_execution_before_host_observed_source_change",
      );
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("defines exactly seven terminal outcomes and preserves primary failure details through cleanup failure", () => {
    expect(ExternalHiddenFixTerminalOutcomeV1Schema.options).toEqual([
      "accepted",
      "no_candidate",
      "agent_failed",
      "workflow_rejected",
      "evaluator_rejected",
      "infrastructure_failed",
      "cleanup_failed",
    ] satisfies ExternalHiddenFixTerminalOutcomeV1[]);
    const terminal = createExternalHiddenFixTerminalRecordV1({
      assignmentId: "m6-assignment:0123456789abcdef01234567",
      outcome: "cleanup_failed",
      agentFailureCode: "provider_failure",
      noCandidateReason: null,
      primaryOutcome: "agent_failed",
      patchSha256: null,
      workflowReceiptSha256: null,
      evaluatorReceiptSha256: null,
      cleanupReceiptSha256: null,
      completedAt: "2026-08-14T00:00:10.000Z",
    });
    expect(terminal).toMatchObject({
      outcome: "cleanup_failed",
      primaryOutcome: "agent_failed",
      agentFailureCode: "provider_failure",
    });
    expect(() =>
      createExternalHiddenFixTerminalRecordV1({
        ...terminal,
        agentFailureCode: null,
      }),
    ).toThrow(/must survive cleanup failure/u);
  });

  it("rejects exposed or non-private roots and symlink/hard-link aliases", async () => {
    const value = await fixture();
    try {
      await chmod(value.hiddenRoot, 0o755);
      await expect(
        openExternalHiddenFixAssignmentStoreV1({
          root: value.hiddenRoot,
          exposedRoots: [value.exposedRoot],
        }),
      ).rejects.toThrow(/0700/u);
      await chmod(value.hiddenRoot, 0o700);
      const hiddenAlias = join(value.parent, "host-only-alias");
      await symlink(value.hiddenRoot, hiddenAlias);
      await expect(
        openExternalHiddenFixAssignmentStoreV1({
          root: hiddenAlias,
          exposedRoots: [value.exposedRoot],
        }),
      ).rejects.toThrow(/real directory|canonical/u);
      await expect(
        openExternalHiddenFixAssignmentStoreV1({
          root: value.hiddenRoot,
          exposedRoots: [value.parent],
        }),
      ).rejects.toThrow(/outside/u);

      const evaluatorAlias = join(value.hiddenRoot, "evaluator-hardlink.mjs");
      await link(value.evaluatorImplementationPath, evaluatorAlias);
      await expect(createAssignment(value)).rejects.toThrow(/one link/u);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("recursively rejects baseline symlinks and one-link violations while preserving normal project modes", async () => {
    const value = await fixture();
    try {
      const outside = await writePrivate(
        join(value.hiddenRoot, "outside.txt"),
        "x",
      );
      await symlink(outside, join(value.baselineRoot, "scripts", "escape.gd"));
      await expect(createAssignment(value)).rejects.toThrow(/symbolic links/u);
      await rm(join(value.baselineRoot, "scripts", "escape.gd"));
      await link(
        join(value.baselineRoot, "scripts", "player.gd"),
        join(value.baselineRoot, "scripts", "player-copy.gd"),
      );
      await expect(createAssignment(value)).rejects.toThrow(/one-link/u);
      expect(
        (await lstat(join(value.baselineRoot, "project.godot"))).mode & 0o777,
      ).toBe(0o644);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });

  it("detects hard-linked private records on read instead of trusting JSON content", async () => {
    const value = await fixture();
    try {
      const assignment = await createAssignment(value);
      const recordName = (await readdir(value.hiddenRoot)).find((name) =>
        name.endsWith(".assignment.json"),
      );
      if (recordName === undefined)
        throw new Error("assignment record missing");
      await link(
        join(value.hiddenRoot, recordName),
        join(value.hiddenRoot, "assignment-record-alias.json"),
      );
      await expect(
        value.store.readAssignment(assignment.assignmentId),
      ).rejects.toThrow(/one link/u);
      expect(
        await readFile(join(value.hiddenRoot, recordName), "utf8"),
      ).toContain(assignment.assignmentId);
    } finally {
      await rm(value.parent, { recursive: true, force: true });
    }
  });
});
