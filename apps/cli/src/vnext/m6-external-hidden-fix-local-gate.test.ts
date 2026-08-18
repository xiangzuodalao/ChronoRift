import { describe, expect, it, vi } from "vitest";

import {
  BwrapExternalHiddenFixEvaluatorProcessV1,
  type LocalExternalHiddenFixPatchStoreV1,
} from "./external-hidden-fix-evaluator.js";
import { runM6ExternalHiddenFixLocalGateV1 } from "./m6-external-hidden-fix-local-gate.js";
import type { PreparedM6ProjectEnvironmentOneTurnTaskV1 } from "./m6-project-environment-one-turn.js";

const preparedTask = (
  patchStore: LocalExternalHiddenFixPatchStoreV1,
): PreparedM6ProjectEnvironmentOneTurnTaskV1 =>
  ({
    patchStore,
    broker: {
      cleanup: vi.fn(async () => ({
        processGroupTerminated: true,
        cgroupPopulated: false,
        scopeRemoved: true,
        storageReconciled: true,
      })),
    },
    layout: { taskRootDirectory: "/agent/task" },
    assignment: {
      assignment: {
        assignmentId: "m6-assignment:0123456789abcdef01234567",
      },
      pristineSource: { repositoryRoot: "/host/pristine" },
      mutatedSource: { repositoryRoot: "/host/mutant" },
      baseline: { workspaceDirectory: "/host/assignment-workspace" },
      protectedBaselineRoot: "/host/protected-baseline",
    },
  }) as unknown as PreparedM6ProjectEnvironmentOneTurnTaskV1;

describe("M6 formal local hidden-fix Gate composition", () => {
  it("refuses a patch store different from the one used by Agent handoff", async () => {
    const taskPatchStore = {} as LocalExternalHiddenFixPatchStoreV1;
    await expect(
      runM6ExternalHiddenFixLocalGateV1({
        task: preparedTask(taskPatchStore),
        store: {} as never,
        patchStore: {} as LocalExternalHiddenFixPatchStoreV1,
        evaluator: {
          bwrapPath: "/usr/bin/bwrap",
          nodePath: "/usr/bin/node",
          temporaryRoot: "/host/evaluator-runs",
        },
      }),
    ).rejects.toThrow(/same protected patch store/u);
  });

  it("constructs the formal evaluator through bwrap with Agent and source roots forbidden", async () => {
    const patchStore = {} as LocalExternalHiddenFixPatchStoreV1;
    const stopped = new Error("stop after evaluator isolation admission");
    const open = vi
      .spyOn(BwrapExternalHiddenFixEvaluatorProcessV1, "open")
      .mockRejectedValueOnce(stopped);

    await expect(
      runM6ExternalHiddenFixLocalGateV1({
        task: preparedTask(patchStore),
        store: {} as never,
        patchStore,
        evaluator: {
          bwrapPath: "/usr/bin/bwrap",
          nodePath: "/opt/node/bin/node",
          temporaryRoot: "/host/evaluator-runs",
          runtimeMounts: [
            { source: "/opt/godot/godot", target: "/runtime/assets/godot" },
          ],
        },
      }),
    ).rejects.toBe(stopped);
    expect(open).toHaveBeenCalledWith({
      bwrapPath: "/usr/bin/bwrap",
      nodePath: "/opt/node/bin/node",
      forbiddenRoots: [
        "/agent/task",
        "/host/pristine",
        "/host/mutant",
        "/host/assignment-workspace",
        "/host/protected-baseline",
      ],
      runtimeMounts: [
        { source: "/opt/godot/godot", target: "/runtime/assets/godot" },
      ],
    });
  });
});
