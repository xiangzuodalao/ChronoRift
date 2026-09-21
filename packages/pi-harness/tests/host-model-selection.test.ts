import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPiHostSettings,
  resolvePiHostModel,
} from "../src/host-model-selection.js";

const models = [
  { provider: "alpha", id: "alpha-model", name: "Alpha" },
  { provider: "beta", id: "beta-model", name: "Beta" },
] as Model<Api>[];
let agentDir: string;
let available: readonly Model<Api>[];
let createRuntime: ReturnType<typeof vi.spyOn<typeof ModelRuntime, "create">>;
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "chronorift-host-settings-"));
  available = models;
  createRuntime = vi.spyOn(ModelRuntime, "create").mockResolvedValue({
    getModels: (provider?: string) =>
      models.filter(
        (model) => provider === undefined || model.provider === provider,
      ),
    getModel: (provider: string, id: string) =>
      models.find((model) => model.provider === provider && model.id === id),
    getAvailable: async (provider?: string) =>
      available.filter(
        (model) => provider === undefined || model.provider === provider,
      ),
    getAvailableSnapshot: () => available,
    hasConfiguredAuth: (provider: string) =>
      available.some((model) => model.provider === provider),
  } as unknown as ModelRuntime);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(agentDir, { recursive: true, force: true });
});

describe("Host model defaults", () => {
  it("loads Host defaults while ignoring project settings, and preserves unrelated settings when saving", async () => {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "beta",
        defaultModel: "beta-model",
        defaultThinkingLevel: "low",
        theme: "dark",
      }),
    );
    await mkdir(join(agentDir, ".pi"));
    await writeFile(
      join(agentDir, ".pi/settings.json"),
      JSON.stringify({
        defaultProvider: "attacker",
        defaultModel: "attacker-model",
      }),
    );
    await expect(
      resolvePiHostModel({ agentDir, interactive: false }),
    ).resolves.toEqual({
      provider: "beta",
      model: "beta-model",
      thinkingLevel: "low",
    });
    const settings = createPiHostSettings(agentDir);
    settings.setDefaultModelAndProvider("alpha", "alpha-model");
    await settings.flush();
    expect(
      JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")),
    ).toMatchObject({
      defaultProvider: "alpha",
      defaultModel: "alpha-model",
      theme: "dark",
    });
    expect(settings.isProjectTrusted()).toBe(false);
    expect(createRuntime).toHaveBeenCalledWith({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
  });

  it("explicit selection overrides the saved model", async () => {
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "beta", defaultModel: "beta-model" }),
    );
    await expect(
      resolvePiHostModel({
        agentDir,
        interactive: false,
        provider: "alpha",
        model: "alpha-model",
      }),
    ).resolves.toMatchObject({ provider: "alpha", model: "alpha-model" });
  });

  it("rejects an explicit unknown provider rather than choosing an authenticated alternative", async () => {
    await expect(
      resolvePiHostModel({
        agentDir,
        interactive: true,
        provider: "unknown",
        model: "unknown-model",
      }),
    ).rejects.toThrow();
  });

  it("chooses an available model when only a provider is specified", async () => {
    await expect(
      resolvePiHostModel({ agentDir, interactive: false, provider: "beta" }),
    ).resolves.toMatchObject({ provider: "beta", model: "beta-model" });
  });

  it("allows the unauthenticated TUI to open for login, but requires a usable headless default", async () => {
    available = [];
    await expect(
      resolvePiHostModel({ agentDir, interactive: true }),
    ).resolves.toMatchObject({ provider: "alpha", model: "alpha-model" });
    await expect(
      resolvePiHostModel({ agentDir, interactive: false }),
    ).rejects.toThrow("No usable Pi model");
  });

  it("reports malformed Host settings instead of silently selecting a model", async () => {
    await writeFile(join(agentDir, "settings.json"), "{bad-json");
    await expect(
      resolvePiHostModel({ agentDir, interactive: true }),
    ).rejects.toThrow("Cannot read Pi Host settings");
    expect(createRuntime).not.toHaveBeenCalled();
  });
});
