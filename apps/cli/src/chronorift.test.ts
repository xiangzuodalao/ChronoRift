import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedGodotBinary } from "@chronorift/godot-adapter";
import type * as Harness from "@chronorift/pi-harness";
import type { projectPreviewCommand } from "./project-preview-command.js";
import type * as PreviewCommand from "./project-preview-command.js";

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn<typeof Harness.resolvePiHostModel>(),
  preview: vi.fn<typeof projectPreviewCommand>(),
}));
vi.mock("@chronorift/pi-harness", async (importOriginal) => ({
  ...(await importOriginal<typeof Harness>()),
  resolvePiHostModel: mocks.resolveModel,
}));
vi.mock("./project-preview-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PreviewCommand>()),
  projectPreviewCommand: mocks.preview,
}));
import { main } from "./chronorift.js";

const roots: string[] = [];
const ttyDescriptors = [process.stdin, process.stdout].map((stream) => ({
  stream,
  descriptor: Object.getOwnPropertyDescriptor(stream, "isTTY"),
}));
beforeEach(() => {
  mocks.resolveModel.mockResolvedValue({
    provider: "saved",
    model: "saved-model",
    thinkingLevel: "high",
  });
  mocks.preview.mockResolvedValue(undefined);
  vi.stubEnv("GODOT_BIN", "/host/godot");
  vi.stubEnv("CHRONORIFT_PI_PROVIDER", "environment-provider");
  vi.stubEnv("CHRONORIFT_PI_MODEL", "environment-model");
});
afterEach(async () => {
  for (const { stream, descriptor } of ttyDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
    else Object.defineProperty(stream, "isTTY", descriptor);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  process.exitCode = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("installed crf command", () => {
  it("opens the TUI without a goal, retaining the caller's project directory", async () => {
    for (const { stream } of ttyDescriptors)
      Object.defineProperty(stream, "isTTY", {
        value: true,
        configurable: true,
      });
    await main([]);
    expect(mocks.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true }),
    );
    expect(mocks.preview.mock.calls[0]![0].positionals).toEqual([]);
    expect(mocks.preview.mock.calls[0]![1]).toBe(process.cwd());
  });

  it("passes a direct task, resolved model and selected Host executable to Preview", async () => {
    await main([
      "Investigate collisions",
      "--provider",
      "explicit",
      "--model",
      "explicit-model",
      "--multi-agent",
    ]);
    expect(mocks.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "explicit",
        model: "explicit-model",
      }),
    );
    const [args, cwd] = mocks.preview.mock.calls[0]!;
    expect(cwd).toBe(process.cwd());
    expect(args).toMatchObject({ positionals: ["Investigate collisions"] });
    expect(args.flags.get("provider")).toBe("saved");
    expect(args.flags.get("thinking")).toBe("high");
    expect(args.flags.get("godot-bin")).toBe("/host/godot");
    expect(args.flags.get("multi-agent")).toBe(true);
  });

  it("uses Host environment defaults and preserves an explicit thinking override", async () => {
    await main(["Investigate", "--thinking", "low"]);
    expect(mocks.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "environment-provider",
        model: "environment-model",
      }),
    );
    expect(mocks.preview.mock.calls[0]![0].flags.get("thinking")).toBe("low");
  });

  it("finds the shared user toolchain without installing into the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-cli-cache-"));
    roots.push(root);
    vi.stubEnv("XDG_CACHE_HOME", root);
    delete process.env.GODOT_BIN;
    const binary = managedGodotBinary(join(root, "chronorift"));
    await mkdir(join(binary, ".."), { recursive: true });
    await writeFile(binary, "fixture");
    // The real project has a local toolchain; this synthetic caller does not.
    vi.spyOn(process, "cwd").mockReturnValue(root);
    await main(["Investigate"]);
    expect(mocks.preview.mock.calls[0]![0].flags.get("godot-bin")).toBe(binary);
  });

  it("rejects invalid flags before model lookup or toolchain preparation", async () => {
    await expect(main(["Investigate", "--max-agents", "2"])).rejects.toThrow(
      "requires --multi-agent",
    );
    await expect(main(["Investigate", "--typo", "value"])).rejects.toThrow(
      "Unsupported --typo",
    );
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("returns a structured missing-goal failure without initializing a model", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await main(["--json"]);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
      status: "failed",
      failureCode: "goal_required",
    });
    expect(process.exitCode).toBe(1);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });

  it("shows help without model authentication, a project or Godot", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await main(["--help"]);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Usage: crf"));
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
