import { afterEach, describe, expect, it, vi } from "vitest";

const runPreview = vi.hoisted(() => vi.fn());

vi.mock("./project-environment-preview.js", () => ({
  runProjectEnvironmentPreviewV1: runPreview,
}));

import { main } from "../main.js";

afterEach(() => {
  vi.restoreAllMocks();
  runPreview.mockReset();
  process.exitCode = undefined;
});

describe("Project Environment Preview CLI", () => {
  it("keeps the Preview explicit and forwards one queued goal", async () => {
    runPreview.mockResolvedValue({
      schemaVersion: 1,
      status: "ready",
      taskId: "task",
      sessionId: "session",
      sessionFile: "/task/session.jsonl",
      environmentId: "environment",
      environmentRevisionId: "environment-revision",
      adapterRevisionId: "adapter-revision",
      buildId: "build",
      candidateSourceChanged: false,
      runtimeObservationReceiptId:
        "runtime-observation-receipt.v1.preview-test",
      reused: false,
      goalDelivered: true,
      failureCode: null,
      failureMessage: null,
      taskDirectory: "/task",
      projectNamespace: "/project/.chronorift/project-environment-v1",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "high",
      limitations: [],
    });
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([
      "project",
      "preview",
      "add a pause menu",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6-luna",
      "--thinking",
      "high",
      "--host-config",
      "/etc/chronorift/pe.json",
      "--project-root",
      "game",
      "--include-untracked",
      "local-input.json",
      "--include-untracked=local-addon.gd",
      "--launch-target",
      "secondary",
      "--json",
    ]);

    expect(runPreview).toHaveBeenCalledWith({
      projectPath: process.cwd(),
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "high",
      goal: "add a pause menu",
      projectRoot: "game",
      includeUntrackedPaths: ["local-input.json", "local-addon.gd"],
      launchTargetId: "secondary",
      interactive: false,
      hostConfigPath: "/etc/chronorift/pe.json",
    });
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('"status": "ready"'),
    );
  });

  it("rejects multiple goals before touching Host state", async () => {
    await expect(
      main([
        "project",
        "preview",
        "first",
        "second",
        "--provider",
        "p",
        "--model",
        "m",
      ]),
    ).rejects.toThrow(/at most one goal/u);
    expect(runPreview).not.toHaveBeenCalled();
  });

  it("rejects duplicate singleton flags instead of silently overwriting them", async () => {
    await expect(
      main([
        "project",
        "preview",
        "goal",
        "--provider",
        "first",
        "--provider",
        "second",
        "--model",
        "model",
      ]),
    ).rejects.toThrow(/Duplicate --provider/u);
    expect(runPreview).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", true],
    ["ready", false],
  ] as const)(
    "sets a failing exit status for Preview status=%s goalDelivered=%s",
    async (status, goalDelivered) => {
      runPreview.mockResolvedValue({
        schemaVersion: 1,
        status,
        taskId: "task",
        sessionId: "session",
        sessionFile: null,
        environmentId: "environment",
        environmentRevisionId:
          status === "ready" ? "environment-revision" : null,
        adapterRevisionId: status === "ready" ? "adapter-revision" : null,
        buildId: status === "ready" ? "build" : null,
        candidateSourceChanged: false,
        runtimeObservationReceiptId: null,
        reused: false,
        goalDelivered,
        failureCode:
          status === "ready" && !goalDelivered ? "pi_turn_failed" : null,
        failureMessage:
          status === "ready" && !goalDelivered ? "Pi turn failed" : null,
        taskDirectory: "/task",
        projectNamespace: "/project/.chronorift/project-environment-v1",
        provider: "provider",
        model: "model",
        thinkingLevel: "high",
        limitations: [],
      });
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await main([
        "project",
        "preview",
        "queued goal",
        "--provider",
        "provider",
        "--model",
        "model",
        "--json",
      ]);

      expect(process.exitCode).toBe(1);
    },
  );

  it("prints a structured JSON failure when Preview rejects before returning a result", async () => {
    runPreview.mockRejectedValueOnce(
      new Error("Pi model provider/missing is not registered"),
    );
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([
      "project",
      "preview",
      "queued goal",
      "--provider",
      "provider",
      "--model",
      "missing",
      "--json",
    ]);

    expect(process.exitCode).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      schemaVersion: 1,
      status: "failed",
      goalDelivered: false,
      failureCode: "project_preview_failed",
      failureMessage: "Pi model provider/missing is not registered",
    });
  });

  it("preserves a structured review-required failure code", async () => {
    runPreview.mockRejectedValueOnce(
      Object.assign(new Error("source closure changed"), {
        code: "review_required",
      }),
    );
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await main([
      "project",
      "preview",
      "queued goal",
      "--provider",
      "provider",
      "--model",
      "model",
      "--json",
    ]);

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      failureCode: "review_required",
      failureMessage: "source closure changed",
    });
  });
});
