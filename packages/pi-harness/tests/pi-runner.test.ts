import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import type { AgentGameApi } from "../src/types.js";
import { PI_TOOL_NAMES } from "../src/internal/pi-tools.js";
import {
  persistPiApiKeyWithSdk,
  runPiDiagnosisWithSdk,
} from "../src/internal/pi-runner.js";

const sdkState = vi.hoisted(() => ({
  disposed: false,
  activeTools: [] as string[],
  excludedTools: [] as string[],
  noTools: undefined as unknown,
  persistedCredential: undefined as
    { provider: string; type: "api_key"; key: string } | undefined,
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  const model = {
    provider: "mock-provider",
    id: "mock-model",
    name: "Mock model",
    reasoning: false,
    input: ["text"],
  };

  return {
    defineTool: <T>(definition: T): T => definition,
    getAgentDir: (): string => "/mock/pi-agent",
    ModelRuntime: class MockModelRuntime {
      static async create(): Promise<MockModelRuntime> {
        return new MockModelRuntime();
      }

      getModel(provider: string, modelId: string) {
        return provider === model.provider && modelId === model.id
          ? model
          : undefined;
      }

      getModels(provider?: string) {
        return provider === undefined || provider === model.provider
          ? [model]
          : [];
      }

      async getAvailable(provider?: string) {
        return this.getModels(provider);
      }

      getProvider(provider: string) {
        return provider === model.provider ? { id: provider } : undefined;
      }

      async login(
        provider: string,
        type: "api_key" | "oauth",
        interaction: {
          prompt(prompt: { type: "secret"; message: string }): Promise<string>;
        },
      ) {
        if (type !== "api_key") throw new Error("Unexpected auth type");
        const key = await interaction.prompt({
          type: "secret",
          message: "Enter API key",
        });
        sdkState.persistedCredential = { provider, type, key };
        return { type, key };
      }

      async listCredentials() {
        const credential = sdkState.persistedCredential;
        return credential === undefined
          ? []
          : [{ providerId: credential.provider, type: credential.type }];
      }
    },
    SettingsManager: {
      inMemory: (): object => ({}),
    },
    DefaultResourceLoader: class MockResourceLoader {
      async reload(): Promise<void> {}
    },
    SessionManager: {
      create: (): object => ({}),
    },
    createAgentSession: async (options: {
      tools?: string[];
      excludeTools?: string[];
      noTools?: unknown;
    }) => {
      sdkState.activeTools = options.tools ?? [];
      sdkState.excludedTools = options.excludeTools ?? [];
      sdkState.noTools = options.noTools;
      return {
        extensionsResult: { extensions: [], errors: [] },
        session: {
          sessionId: "session-offline",
          sessionFile: "/mock/session.jsonl",
          thinkingLevel: "medium",
          agent: { state: { errorMessage: "mock agent stopped" } },
          getActiveToolNames: (): string[] => [...sdkState.activeTools],
          prompt: async (): Promise<void> => {},
          dispose: (): void => {
            sdkState.disposed = true;
          },
        },
      };
    },
  };
});

const unusedGameApi: AgentGameApi = {
  async getEvidence() {
    throw new Error("The mock agent must not invoke game tools");
  },
  async forkTimeline() {
    throw new Error("The mock agent must not invoke game tools");
  },
  async replayTimeline() {
    throw new Error("The mock agent must not invoke game tools");
  },
  async compareTimelines() {
    throw new Error("The mock agent must not invoke game tools");
  },
};

let fixtureRoot: string | undefined;

afterEach(async () => {
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  }
  sdkState.disposed = false;
  sdkState.persistedCredential = undefined;
});

test("persists an API key through Pi's credential store", async () => {
  await expect(
    persistPiApiKeyWithSdk({
      provider: "mock-provider",
      apiKey: "test-secret",
    }),
  ).resolves.toEqual({
    provider: "mock-provider",
    credentialType: "api_key",
  });
  expect(sdkState.persistedCredential).toEqual({
    provider: "mock-provider",
    type: "api_key",
    key: "test-secret",
  });
});

test("isolates tools and rejects an agent run without a submitted report", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "chronorift-pi-runner-"));

  await expect(
    runPiDiagnosisWithSdk({
      cwd: fixtureRoot,
      runDir: join(fixtureRoot, "run"),
      provider: "mock-provider",
      model: "mock-model",
      initialEvidenceId: "evidence-initial",
      game: unusedGameApi,
    }),
  ).rejects.toMatchObject({
    code: "REPORT_MISSING",
    message: "Pi ended without a diagnosis: mock agent stopped",
  });

  expect(sdkState.activeTools).toEqual(PI_TOOL_NAMES);
  expect(sdkState.excludedTools).toEqual(
    expect.arrayContaining(["bash", "edit", "write"]),
  );
  expect(sdkState.noTools).toBe("all");
  expect(sdkState.disposed).toBe(true);
});
