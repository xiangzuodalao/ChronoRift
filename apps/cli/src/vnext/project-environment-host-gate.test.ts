import { describe, expect, it, vi } from "vitest";

import { closeProjectEnvironmentHostGateV1 } from "./project-environment-host-gate.js";
import type { ProjectEnvironmentHostGateCleanupError } from "./project-environment-host-gate.js";

describe("Project Environment Host Gate cleanup", () => {
  it("fails closed when injected cleanup evidence is incomplete", async () => {
    const cleanup = vi.fn().mockResolvedValue({
      processGroupTerminated: false,
      cgroupPopulated: true,
      termSent: true,
      killSent: true,
      scopeRemoved: false,
      storageReconciled: false,
    });

    const attempt = closeProjectEnvironmentHostGateV1(cleanup);

    await expect(attempt).rejects.toMatchObject({
      name: "ProjectEnvironmentHostGateCleanupError",
      receipt: {
        processGroupTerminated: false,
        cgroupPopulated: true,
        termSent: true,
        killSent: true,
        scopeRemoved: false,
        storageReconciled: false,
      },
    } satisfies Partial<ProjectEnvironmentHostGateCleanupError>);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("returns only complete cleanup evidence", async () => {
    await expect(
      closeProjectEnvironmentHostGateV1(async () => ({
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: true,
        killSent: false,
        scopeRemoved: true,
        storageReconciled: true,
      })),
    ).resolves.toMatchObject({
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
      storageReconciled: true,
    });
  });
});
