import { z } from "zod";

import {
  BranchIdSchema,
  CheckpointIdSchema,
  InputTraceIdSchema,
  ReportIdSchema,
  RunIdSchema,
  type BranchId,
  type CheckpointId,
  type InputTraceId,
  type ReportId,
  type RunId,
} from "./ids.js";
import {
  BranchControlsSchema,
  type BranchControls,
  type BranchStatus,
} from "./timeline.js";

export interface GitSourceRef {
  readonly commit: string | null;
  readonly dirty: boolean;
  readonly worktreePatchHash: string | null;
}

export interface ModelRef {
  readonly piSessionId: string | null;
  readonly provider: string | null;
  readonly model: string | null;
}

export interface ManifestBranchEntry {
  readonly branchId: BranchId;
  readonly parentBranchId?: BranchId | undefined;
  readonly forkCheckpointId: CheckpointId;
  readonly inputTraceId: InputTraceId;
  readonly controls: BranchControls;
  readonly status: BranchStatus;
  readonly timelineDigest?: string | undefined;
  readonly finalCheckpointId?: CheckpointId | undefined;
}

export interface RunManifest {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly runId: RunId;
  readonly createdAt: string;
  readonly source: GitSourceRef;
  readonly model: ModelRef;
  readonly environmentAdapter: string;
  readonly initialCheckpointId: CheckpointId;
  readonly initialInputTraceId: InputTraceId;
  readonly seed: string;
  readonly branches: readonly ManifestBranchEntry[];
  readonly diagnosisReportId?: ReportId | undefined;
}

const branchEntrySchema: z.ZodType<ManifestBranchEntry> = z
  .object({
    branchId: BranchIdSchema,
    parentBranchId: BranchIdSchema.optional(),
    forkCheckpointId: CheckpointIdSchema,
    inputTraceId: InputTraceIdSchema,
    controls: BranchControlsSchema,
    status: z.enum(["created", "running", "completed", "failed"]),
    timelineDigest: z.string().min(1).optional(),
    finalCheckpointId: CheckpointIdSchema.optional(),
  })
  .strict();

export const RunManifestSchema: z.ZodType<RunManifest> = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    runId: RunIdSchema,
    createdAt: z.string().datetime(),
    source: z
      .object({
        commit: z.string().min(1).nullable(),
        dirty: z.boolean(),
        worktreePatchHash: z.string().min(1).nullable(),
      })
      .strict(),
    model: z
      .object({
        piSessionId: z.string().min(1).nullable(),
        provider: z.string().min(1).nullable(),
        model: z.string().min(1).nullable(),
      })
      .strict(),
    environmentAdapter: z.string().min(1),
    initialCheckpointId: CheckpointIdSchema,
    initialInputTraceId: InputTraceIdSchema,
    seed: z.string().min(1),
    branches: z.array(branchEntrySchema),
    diagnosisReportId: ReportIdSchema.optional(),
  })
  .strict();
