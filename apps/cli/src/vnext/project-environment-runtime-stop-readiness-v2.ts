export interface ProjectEnvironmentRuntimeStopReadinessV2 {
  readonly dynamicTraceCount: number;
  readonly entityRows: number;
  readonly stateRows: number;
  readonly eventRows: number;
  readonly captureWindowCount: number;
}

export const projectEnvironmentRuntimeStopMissingEvidenceV2 = (
  input: ProjectEnvironmentRuntimeStopReadinessV2,
): readonly string[] =>
  Object.freeze([
    ...(input.dynamicTraceCount > 0 ? [] : ["validated dynamic trace"]),
    ...(input.entityRows > 0 ? [] : ["nonempty entity query"]),
    ...(input.stateRows > 0 ? [] : ["nonempty state query"]),
    ...(input.eventRows > 0 ? [] : ["nonempty event query"]),
    ...(input.captureWindowCount > 0 ? [] : ["durable pinned capture"]),
  ]);

export const projectEnvironmentRuntimeStopReadinessSummaryV2 = (
  input: ProjectEnvironmentRuntimeStopReadinessV2,
): string => {
  const missing = projectEnvironmentRuntimeStopMissingEvidenceV2(input);
  return [
    `PE-B stop readiness ${missing.length === 0 ? "complete" : "incomplete"}`,
    `dynamicTraces=${input.dynamicTraceCount}`,
    `entityRows=${input.entityRows}`,
    `stateRows=${input.stateRows}`,
    `eventRows=${input.eventRows}`,
    `pinnedCaptures=${input.captureWindowCount}`,
    `missing=${missing.length === 0 ? "none" : missing.join("|")}`,
  ].join("; ");
};
