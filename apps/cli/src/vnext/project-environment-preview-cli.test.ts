import { afterEach, describe, expect, it, vi } from "vitest";
import type * as PreviewModule from "./project-environment-preview.js";

const runPreview = vi.hoisted(() => vi.fn());
vi.mock("./project-environment-preview.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PreviewModule>()),
  runProjectEnvironmentPreviewV2: runPreview,
}));
import { main } from "../main.js";

const result = () => ({
  schemaVersion: 2,
  status: "completed",
  taskId: "task",
  sessionId: "session",
  sessionFile: "/task/session.jsonl",
  projectRoot: "game",
  sourceSha256: "a".repeat(64),
  candidateSourceChanged: false,
  candidatePatch: null,
  executions: [],
  goalDelivered: true,
  failureCode: null,
  failureMessage: null,
  taskDirectory: "/task",
  workspaceDirectory: "/task/workspace",
  provider: "provider",
  model: "model",
  thinkingLevel: "high",
  limitations: [],
});
const args = [
  "project",
  "preview",
  "inspect the scene",
  "--provider",
  "provider",
  "--model",
  "model",
  "--json",
];

afterEach(() => {
  vi.restoreAllMocks();
  runPreview.mockReset();
  process.exitCode = undefined;
});

describe("inspection Preview CLI", () => {
  it("forwards the goal and source selection without project registration", async () => {
    runPreview.mockResolvedValue(result());
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await main([
      ...args,
      "--thinking",
      "high",
      "--project-root",
      "game",
      "--include-untracked",
      "local-input.json",
      "--include-untracked=local-addon.gd",
      "--state-root",
      "/tmp/chronorift-state",
      "--godot-bin",
      "/opt/godot",
    ]);
    expect(runPreview).toHaveBeenCalledWith({
      projectPath: process.cwd(),
      provider: "provider",
      model: "model",
      thinkingLevel: "high",
      goal: "inspect the scene",
      projectRoot: "game",
      includeUntrackedPaths: ["local-input.json", "local-addon.gd"],
      interactive: false,
      stateRoot: "/tmp/chronorift-state",
      godotBin: "/opt/godot",
    });
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual(result());
    expect(process.exitCode).toBeUndefined();
  });

  it("accepts coding-only completion without a runtime execution", async () => {
    runPreview.mockResolvedValue(result());
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await main(args);
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects obsolete launch-target selection before touching state", async () => {
    await expect(
      main([...args, "--launch-target", "secondary"]),
    ).rejects.toThrow(/launch-target/u);
    expect(runPreview).not.toHaveBeenCalled();
  });

  it("rejects multiple goals before touching state", async () => {
    await expect(main([...args, "second"])).rejects.toThrow(
      /at most one goal/u,
    );
    expect(runPreview).not.toHaveBeenCalled();
  });

  it("rejects duplicate singleton flags", async () => {
    await expect(main([...args, "--provider", "second"])).rejects.toThrow(
      /Duplicate --provider/u,
    );
    expect(runPreview).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled", "timed_out"])(
    "sets a failing exit status for %s",
    async (status) => {
      runPreview.mockResolvedValue({ ...result(), status });
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await main(args);
      expect(process.exitCode).toBe(1);
    },
  );

  it("prints versioned, bounded startup failures", async () => {
    runPreview.mockRejectedValueOnce(
      new Error("Pi model provider/missing is not registered"),
    );
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await main(args);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      schemaVersion: 2,
      status: "failed",
      goalDelivered: false,
      failureCode: "project_preview_failed",
      failureMessage: "Pi model provider/missing is not registered",
    });
  });

  it("preserves source review failures", async () => {
    runPreview.mockRejectedValueOnce(
      Object.assign(new Error("source closure changed"), {
        code: "review_required",
      }),
    );
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await main(args);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      failureCode: "review_required",
    });
  });
});
