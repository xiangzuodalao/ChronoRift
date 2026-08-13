import { PassThrough } from "node:stream";

import {
  encodeWireFrame,
  makeGodotProjectEnvironmentWireMessageV2,
  PROJECT_ADAPTER_CAPABILITY_MODULES_V1,
} from "@chronorift/godot-protocol";
import { describe, expect, it } from "vitest";

import type { GodotByteTransport } from "./godot-wire-client.js";
import { connectGodotProjectEnvironmentRuntimeV2 } from "./project-environment-wire-client-v2.js";

const digest = (character: string) => character.repeat(64);
const identity = {
  taskId: "task.v2.timeout",
  sourceClosureId: "source.v2.timeout",
  environmentRevisionId: "environment.v2.timeout",
  adapterRevisionId: "adapter.v2.timeout",
  buildId: "build.v2.timeout",
  runtimeId: "runtime.v2.timeout",
  executionId: "execution.v2.timeout",
  instrumentationMode: "instrumented" as const,
  candidateSourceHash: digest("a"),
  adapterManifestSha256: digest("b"),
  sdkSha256: digest("c"),
  bridgeSha256: digest("d"),
  toolchainSha256: digest("e"),
  observationProtocolVersion: 2 as const,
  adapterSdkVersion: 2 as const,
};
const request = {
  schemaVersion: 2 as const,
  token: digest("f"),
  expectedIdentity: identity,
  expectedEngineVersion: "4.7.1-stable (official)",
  expectedPlatform: "Linux",
  expectedMainScene: "res://main.tscn",
  expectedAdapterManifestSha256: identity.adapterManifestSha256,
  handshakeTimeoutMs: 5,
};
const transport = (readable: PassThrough): GodotByteTransport => ({
  readable,
  write: async () => undefined,
  close: async () => {
    readable.end();
  },
});

describe("Godot Project Environment wire client V2 handshake stages", () => {
  it("distinguishes an absent bridge hello", async () => {
    const readable = new PassThrough();
    await expect(
      connectGodotProjectEnvironmentRuntimeV2(transport(readable), request),
    ).rejects.toMatchObject({
      code: "CONNECTION_TIMEOUT",
      message: expect.stringContaining("hello_timeout") as unknown,
    });
  });

  it("distinguishes an accepted hello that never becomes ready", async () => {
    const readable = new PassThrough();
    readable.write(
      encodeWireFrame(
        JSON.stringify(
          makeGodotProjectEnvironmentWireMessageV2({
            sequence: 0,
            kind: "hello",
            payload: {
              token: request.token,
              fingerprint: {
                schemaVersion: 2,
                protocolProfile:
                  "chronorift-godot-project-environment-v2" as const,
                protocolVersion: 2,
                engine: "godot",
                engineVersion: request.expectedEngineVersion,
                engineBuildHash: "build471",
                platform: request.expectedPlatform,
                renderer: "headless",
                displayServer: "headless",
                audioDriver: "Dummy",
                physicsTicksPerSecond: 60,
                configuredMainScene: request.expectedMainScene,
                modules: {
                  schemaVersion: 1,
                  modules: PROJECT_ADAPTER_CAPABILITY_MODULES_V1.map(
                    (module) => ({
                      schemaVersion: 1,
                      module,
                      status: "unsupported" as const,
                      protocolVersion: null,
                      limitations: ["timeout fixture"],
                    }),
                  ),
                },
                identity,
              },
            },
          }),
        ),
      ),
    );
    await expect(
      connectGodotProjectEnvironmentRuntimeV2(transport(readable), request),
    ).rejects.toMatchObject({
      code: "COMMAND_TIMEOUT",
      message: expect.stringContaining("ready_timeout") as unknown,
    });
  });
});
