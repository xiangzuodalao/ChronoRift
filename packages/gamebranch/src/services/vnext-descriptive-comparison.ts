import {
  VNextComparisonV1Schema,
  VNextRuntimeControlReceiptV1Schema,
  VNextRuntimeStateQueryResultV1Schema,
  type ComparisonId,
  type JsonValue,
  type TaskId,
  type VNextComparisonConfounderV1,
  type VNextComparisonExecutionRefV1,
  type VNextComparisonV1,
  type VNextObservableDifferenceV1,
  type VNextRuntimePhaseV1,
  type VNextRuntimeControlReceiptV1,
  type VNextRuntimeStateQueryResultV1,
  type VNextRuntimeStateRowV1,
} from "@chronorift/domain";

export interface VNextDescriptiveComparisonRequest {
  readonly taskId: TaskId;
  readonly comparisonId: ComparisonId;
  readonly leftRef: VNextComparisonExecutionRefV1;
  readonly rightRef: VNextComparisonExecutionRefV1;
  readonly leftControls: VNextRuntimeControlReceiptV1;
  readonly rightControls: VNextRuntimeControlReceiptV1;
  readonly left: VNextRuntimeStateQueryResultV1;
  readonly right: VNextRuntimeStateQueryResultV1;
  readonly firstDivergencePhase?: VNextRuntimePhaseV1 | undefined;
  readonly createdAt: string;
}

const jsonEqual = (left: JsonValue, right: JsonValue): boolean => {
  if (left === null || right === null || typeof left !== typeof right) {
    return left === right;
  }
  if (typeof left !== "object" || typeof right !== "object") {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEqual(entry, right[index] as JsonValue))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonEqual(left[key] as JsonValue, right[key] as JsonValue),
    )
  );
};

const sameStringSet = (left: readonly string[], right: readonly string[]) => {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((entry, index) => entry === sortedRight[index])
  );
};

const entityKey = (row: VNextRuntimeStateRowV1): string | null =>
  row.entity === null
    ? null
    : `${row.entity.stableId}#${row.entity.incarnation}`;

const entityIncarnations = (
  rows: readonly VNextRuntimeStateRowV1[],
): Map<string, Set<number>> => {
  const result = new Map<string, Set<number>>();
  for (const row of rows) {
    if (row.entity === null) continue;
    const incarnations = result.get(row.entity.stableId) ?? new Set<number>();
    incarnations.add(row.entity.incarnation);
    result.set(row.entity.stableId, incarnations);
  }
  return result;
};

const uniqueEntityKeys = (
  rows: readonly VNextRuntimeStateRowV1[],
): Set<string> =>
  new Set(rows.map(entityKey).filter((key): key is string => key !== null));

const rowProjectionKey = (row: VNextRuntimeStateRowV1): string =>
  `${entityKey(row) ?? "-"}|${row.kind}|${row.statePath ?? "-"}`;

const latestProjectionRows = (
  rows: readonly VNextRuntimeStateRowV1[],
  allowedEntities: ReadonlySet<string>,
): Map<string, VNextRuntimeStateRowV1> => {
  const result = new Map<string, VNextRuntimeStateRowV1>();
  for (const row of rows) {
    const key = entityKey(row);
    if (key === null || !allowedEntities.has(key)) continue;
    result.set(rowProjectionKey(row), row);
  }
  return result;
};

const differenceCategory = (
  row: VNextRuntimeStateRowV1,
): VNextObservableDifferenceV1["category"] => {
  switch (row.kind) {
    case "state":
      return "state";
    case "input":
      return "input";
    case "clock":
      return "clock";
    case "lifecycle":
      return "entity";
    case "event":
    case "relation":
    case "log":
    case "error":
    case "rng":
    case "checkpoint":
      return "event";
  }
};

const rowSubject = (row: VNextRuntimeStateRowV1): string =>
  row.statePath ?? entityKey(row) ?? row.kind;

type ProjectionCoverageStatus = "full" | "partial" | "unavailable";

const projectionCoverageStatus = (
  result: VNextRuntimeStateQueryResultV1,
): ProjectionCoverageStatus => {
  if (
    result.coverage.length === 0 ||
    result.coverage.some((entry) => entry.status === "unavailable")
  ) {
    return "unavailable";
  }
  if (
    result.incomplete ||
    result.loss.length > 0 ||
    result.coverage.some((entry) => entry.status !== "full")
  ) {
    return "partial";
  }
  return "full";
};

const comparisonCoverageStatus = (
  request: VNextDescriptiveComparisonRequest,
): ProjectionCoverageStatus => {
  const left = projectionCoverageStatus(request.left);
  const right = projectionCoverageStatus(request.right);
  if (left === "unavailable" || right === "unavailable") return "unavailable";
  if (left === "partial" || right === "partial") return "partial";
  return "full";
};

const coverageSummary = (
  result: VNextRuntimeStateQueryResultV1,
  coverageHash: VNextComparisonExecutionRefV1["captureCoverageHash"],
) => ({
  coverageHash,
  status: projectionCoverageStatus(result),
  incomplete: result.incomplete,
  lossCount: result.loss.length,
  channels: result.coverage.map((entry) => ({
    channel: entry.channel,
    status: entry.status,
  })),
});

export class VNextDescriptiveComparisonService {
  public compare(
    request: VNextDescriptiveComparisonRequest,
  ): VNextComparisonV1 {
    VNextRuntimeStateQueryResultV1Schema.parse(request.left);
    VNextRuntimeStateQueryResultV1Schema.parse(request.right);
    VNextRuntimeControlReceiptV1Schema.parse(request.leftControls);
    VNextRuntimeControlReceiptV1Schema.parse(request.rightControls);
    this.assertOwnership(request);
    const leftIncarnations = entityIncarnations(request.left.rows);
    const rightIncarnations = entityIncarnations(request.right.rows);
    const stableIds = new Set([
      ...leftIncarnations.keys(),
      ...rightIncarnations.keys(),
    ]);
    const ambiguousEntities = [...stableIds]
      .filter(
        (stableId) =>
          (leftIncarnations.get(stableId)?.size ?? 0) > 1 ||
          (rightIncarnations.get(stableId)?.size ?? 0) > 1,
      )
      .sort();
    const ambiguousSet = new Set(ambiguousEntities);
    const leftKeys = uniqueEntityKeys(request.left.rows);
    const rightKeys = uniqueEntityKeys(request.right.rows);
    const isAmbiguousKey = (key: string) =>
      ambiguousSet.has(key.slice(0, key.lastIndexOf("#")));
    const matchedEntities = [...leftKeys]
      .filter((key) => rightKeys.has(key) && !isAmbiguousKey(key))
      .sort();
    const matchedSet = new Set(matchedEntities);
    const unmatchedLeftEntities = [...leftKeys]
      .filter((key) => !rightKeys.has(key) && !isAmbiguousKey(key))
      .sort();
    const unmatchedRightEntities = [...rightKeys]
      .filter((key) => !leftKeys.has(key) && !isAmbiguousKey(key))
      .sort();

    const confounders = this.confounders(request);
    const coverageStatus = comparisonCoverageStatus(request);
    const differences = this.differences(
      request,
      matchedSet,
      unmatchedLeftEntities,
      unmatchedRightEntities,
    );
    const firstDifference = differences.find(
      (difference) => difference.clock !== null,
    );
    const firstDivergence =
      firstDifference === undefined && coverageStatus !== "full"
        ? {
            schemaVersion: 1 as const,
            status: "unavailable" as const,
            fidelityBoundary: "queried Runtime State Index projection",
            reason:
              coverageStatus === "unavailable"
                ? "capture coverage is unavailable; first divergence cannot be established"
                : "incomplete coverage prevents establishing the first divergence",
          }
        : firstDifference === undefined
          ? {
              schemaVersion: 1 as const,
              status: "none_observed" as const,
              fidelityBoundary: "queried Runtime State Index projection",
              reason:
                "no difference was observed in the queried projection; complete runtime equivalence is not established",
            }
          : request.firstDivergencePhase === undefined
            ? {
                schemaVersion: 1 as const,
                status: "unavailable" as const,
                fidelityBoundary: "queried Runtime State Index projection",
                reason:
                  "an observable difference exists but its runtime phase was not supplied",
              }
            : {
                schemaVersion: 1 as const,
                status: "observed" as const,
                clock: firstDifference.clock!,
                phase: request.firstDivergencePhase,
                differenceKind:
                  firstDifference.category === "entity"
                    ? ("entity" as const)
                    : firstDifference.category === "clock"
                      ? ("clock" as const)
                      : firstDifference.category === "event" ||
                          firstDifference.category === "input"
                        ? ("event" as const)
                        : ("field" as const),
                subject: firstDifference.subject,
                left: firstDifference.left,
                right: firstDifference.right,
                fidelityBoundary:
                  coverageStatus === "full"
                    ? "queried Runtime State Index projection"
                    : "queried Runtime State Index projection with incomplete coverage",
              };

    const alignmentStatus =
      coverageStatus === "unavailable" ? "unavailable" : "partial";
    const alignmentLimitations = [
      "alignment uses stable entity identity and incarnation",
      ...(coverageStatus === "unavailable"
        ? ["capture coverage is unavailable; entity alignment is uncertain"]
        : coverageStatus === "partial"
          ? [
              "capture coverage is incomplete; entity alignment may omit observations",
            ]
          : []),
      ...(coverageStatus === "unavailable"
        ? []
        : ["cross-execution clock uncertainty is not measured"]),
    ];
    return VNextComparisonV1Schema.parse({
      schemaVersion: 1,
      taskId: request.taskId,
      comparisonId: request.comparisonId,
      mode: confounders.length > 0 ? "confounded" : "descriptive_only",
      left: request.leftRef,
      right: request.rightRef,
      alignment: {
        schemaVersion: 1,
        status: alignmentStatus,
        clockUncertaintyUs: null,
        matchedEntities,
        unmatchedLeftEntities,
        unmatchedRightEntities,
        ambiguousEntities,
        limitations: alignmentLimitations,
      },
      confounders,
      differences,
      firstDivergence,
      limitations: ["observable projection only"],
      createdAt: request.createdAt,
    });
  }

  private assertOwnership(request: VNextDescriptiveComparisonRequest): void {
    if (
      request.left.taskId !== request.taskId ||
      request.right.taskId !== request.taskId
    ) {
      throw new Error("comparison inputs do not belong to the requested task");
    }
    if (
      request.left.executionId !== request.leftRef.executionId ||
      request.right.executionId !== request.rightRef.executionId ||
      request.left.runtimeId !== request.leftRef.runtimeId ||
      request.right.runtimeId !== request.rightRef.runtimeId ||
      request.left.sourceId !== request.leftRef.sourceId ||
      request.right.sourceId !== request.rightRef.sourceId ||
      request.left.buildId !== request.leftRef.buildId ||
      request.right.buildId !== request.rightRef.buildId ||
      request.left.adapterId !== request.leftRef.adapterId ||
      request.right.adapterId !== request.rightRef.adapterId ||
      !sameStringSet(request.left.probeIds, request.leftRef.probeIds) ||
      !sameStringSet(request.right.probeIds, request.rightRef.probeIds) ||
      !sameStringSet(
        request.left.captureWindowIds,
        request.leftRef.captureWindowIds,
      ) ||
      !sameStringSet(
        request.right.captureWindowIds,
        request.rightRef.captureWindowIds,
      )
    ) {
      throw new Error(
        "comparison resource references do not match query results",
      );
    }
  }

  private confounders(
    request: VNextDescriptiveComparisonRequest,
  ): VNextComparisonConfounderV1[] {
    const confounders: VNextComparisonConfounderV1[] = [];
    if (
      request.leftRef.buildId !== request.rightRef.buildId ||
      request.leftRef.sourceId !== request.rightRef.sourceId
    ) {
      confounders.push({
        schemaVersion: 1,
        category: "build",
        description: "source or build identity differs",
        left: request.leftRef.buildId,
        right: request.rightRef.buildId,
      });
    }
    if (request.leftRef.adapterId !== request.rightRef.adapterId) {
      confounders.push({
        schemaVersion: 1,
        category: "adapter",
        description: "runtime adapter identity differs",
        left: request.leftRef.adapterId,
        right: request.rightRef.adapterId,
      });
    }
    if (!sameStringSet(request.leftRef.probeIds, request.rightRef.probeIds)) {
      confounders.push({
        schemaVersion: 1,
        category: "probe",
        description: "probe identity set differs",
        left: [...request.leftRef.probeIds],
        right: [...request.rightRef.probeIds],
      });
    }
    const leftCoverageStatus = projectionCoverageStatus(request.left);
    const rightCoverageStatus = projectionCoverageStatus(request.right);
    const coverageUnavailable =
      leftCoverageStatus === "unavailable" ||
      rightCoverageStatus === "unavailable";
    const coverageIncomplete =
      leftCoverageStatus !== "full" || rightCoverageStatus !== "full";
    if (
      coverageIncomplete ||
      request.leftRef.captureCoverageHash !==
        request.rightRef.captureCoverageHash ||
      request.left.incomplete !== request.right.incomplete ||
      request.left.loss.length !== request.right.loss.length
    ) {
      confounders.push({
        schemaVersion: 1,
        category: "coverage",
        description: coverageUnavailable
          ? "capture coverage is unavailable for at least one projection"
          : coverageIncomplete
            ? "capture coverage is incomplete for at least one projection"
            : "capture coverage or loss differs",
        left: coverageSummary(
          request.left,
          request.leftRef.captureCoverageHash,
        ),
        right: coverageSummary(
          request.right,
          request.rightRef.captureCoverageHash,
        ),
      });
    }
    if (
      request.leftRef.checkpointId !== request.rightRef.checkpointId ||
      request.leftRef.checkpointFidelity !== request.rightRef.checkpointFidelity
    ) {
      confounders.push({
        schemaVersion: 1,
        category: "checkpoint_fidelity",
        description: "checkpoint identity or fidelity differs",
        left: {
          checkpointId: request.leftRef.checkpointId,
          fidelity: request.leftRef.checkpointFidelity,
        },
        right: {
          checkpointId: request.rightRef.checkpointId,
          fidelity: request.rightRef.checkpointFidelity,
        },
      });
    }
    if (
      !jsonEqual(request.leftControls.realized, request.rightControls.realized)
    ) {
      confounders.push({
        schemaVersion: 1,
        category: "runtime",
        description: "realized runtime controls differ",
        left: request.leftControls.realized,
        right: request.rightControls.realized,
      });
    }
    if (request.leftRef.traceId !== request.rightRef.traceId) {
      confounders.push({
        schemaVersion: 1,
        category: "trace",
        description: "input/control trace identity differs",
        left: request.leftRef.traceId,
        right: request.rightRef.traceId,
      });
    }
    return confounders;
  }

  private differences(
    request: VNextDescriptiveComparisonRequest,
    matchedEntities: ReadonlySet<string>,
    unmatchedLeftEntities: readonly string[],
    unmatchedRightEntities: readonly string[],
  ): VNextObservableDifferenceV1[] {
    const observability = comparisonCoverageStatus(request);
    const differences: VNextObservableDifferenceV1[] = [];
    if (request.leftRef.sourceId !== request.rightRef.sourceId) {
      differences.push({
        schemaVersion: 1,
        category: "source",
        subject: "sourceId",
        left: request.leftRef.sourceId,
        right: request.rightRef.sourceId,
        observability: "full",
        clock: null,
        details: [],
      });
    }
    if (request.leftRef.buildId !== request.rightRef.buildId) {
      differences.push({
        schemaVersion: 1,
        category: "build",
        subject: "buildId",
        left: request.leftRef.buildId,
        right: request.rightRef.buildId,
        observability: "full",
        clock: null,
        details: [],
      });
    }

    const leftRows = latestProjectionRows(request.left.rows, matchedEntities);
    const rightRows = latestProjectionRows(request.right.rows, matchedEntities);
    const projectionKeys = new Set([...leftRows.keys(), ...rightRows.keys()]);
    for (const key of [...projectionKeys].sort()) {
      const left = leftRows.get(key);
      const right = rightRows.get(key);
      const representative = left ?? right;
      if (representative === undefined) continue;
      if (
        left !== undefined &&
        right !== undefined &&
        jsonEqual(left.value, right.value)
      ) {
        if (!jsonEqual(left.clock, right.clock)) {
          differences.push({
            schemaVersion: 1,
            category: "timeline",
            subject: rowSubject(representative),
            left: left.clock,
            right: right.clock,
            observability,
            clock: right.clock,
            details: ["matched projection was observed at different clocks"],
          });
        }
        continue;
      }
      differences.push({
        schemaVersion: 1,
        category: differenceCategory(representative),
        subject: rowSubject(representative),
        left: left?.value ?? null,
        right: right?.value ?? null,
        observability,
        clock: right?.clock ?? left?.clock ?? null,
        details: [],
      });
    }

    const leftUnscoped = request.left.rows.filter((row) => row.entity === null);
    const rightUnscoped = request.right.rows.filter(
      (row) => row.entity === null,
    );
    const unscopedLength = Math.max(leftUnscoped.length, rightUnscoped.length);
    for (let index = 0; index < unscopedLength; index += 1) {
      const left = leftUnscoped[index];
      const right = rightUnscoped[index];
      if (
        left !== undefined &&
        right !== undefined &&
        left.kind === right.kind &&
        left.statePath === right.statePath &&
        jsonEqual(left.value, right.value)
      ) {
        if (!jsonEqual(left.clock, right.clock)) {
          differences.push({
            schemaVersion: 1,
            category: "timeline",
            subject: rowSubject(left),
            left: left.clock,
            right: right.clock,
            observability,
            clock: right.clock,
            details: ["observable event occurred at a different clock"],
          });
        }
        continue;
      }
      const representative = left ?? right;
      if (representative === undefined) continue;
      differences.push({
        schemaVersion: 1,
        category: differenceCategory(representative),
        subject: rowSubject(representative),
        left: left?.value ?? null,
        right: right?.value ?? null,
        observability,
        clock: right?.clock ?? left?.clock ?? null,
        details: ["observable event projection differs"],
      });
    }

    for (const key of unmatchedLeftEntities) {
      differences.push({
        schemaVersion: 1,
        category: "entity",
        subject: key,
        left: key,
        right: null,
        observability,
        clock: null,
        details: ["entity identity is unmatched"],
      });
    }
    for (const key of unmatchedRightEntities) {
      differences.push({
        schemaVersion: 1,
        category: "entity",
        subject: key,
        left: null,
        right: key,
        observability,
        clock: null,
        details: ["entity identity is unmatched"],
      });
    }
    if (
      request.leftRef.captureCoverageHash !==
      request.rightRef.captureCoverageHash
    ) {
      differences.push({
        schemaVersion: 1,
        category: "coverage",
        subject: "captureCoverageHash",
        left: request.leftRef.captureCoverageHash,
        right: request.rightRef.captureCoverageHash,
        observability: "full",
        clock: null,
        details: [],
      });
    }
    return differences;
  }
}
