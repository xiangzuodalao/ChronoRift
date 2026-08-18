import { createHash } from "node:crypto";

import {
  JsonValueSchema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  asSha256DigestV1,
  type JsonValue,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  assertM7PreparedAssignmentMatchesSensorFreezeV1,
  classifyM7ActualVisibleExchangePrefixV1,
  deriveM7RuntimeTreatmentExclusiveTargetsV1,
  selectM7AgentVisibleExecutionExchangesV1,
  type M7FrozenPatrolClassifierRunnerV1,
} from "./m7-project-environment-paired-preparation.js";
import type { M7AgentGameToolExchangeV1 } from "./m7-project-environment-paired-agent.js";
import {
  M7_MODDABLE_PLATFORMER_REPOSITORY_V1,
  M7_MODDABLE_PLATFORMER_REVISION_V1,
  createM7SensorFreezeRecordV1,
} from "./m7-patrol-sensor.js";

const digest = (value: string) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));
const digestJson = (value: unknown) =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

const executionId = "execution:m7:query-shape";
const runtimeId = "runtime:m7:query-shape";

const exchange = (
  ordinal: number,
  toolName: M7AgentGameToolExchangeV1["toolName"],
  response: JsonValue,
  inputExecutionId = executionId,
): M7AgentGameToolExchangeV1 => ({
  schemaVersion: 1,
  ordinal,
  hostToolReturnOrdinal: ordinal,
  toolCallId: `call:m7:${ordinal}`,
  toolName,
  input: JsonValueSchema.parse({
    schemaVersion: 1,
    executionId: inputExecutionId,
  }),
  response,
  observedAt: `2026-08-15T00:00:0${String(ordinal)}.000Z`,
});

const classifier = (): {
  readonly runner: M7FrozenPatrolClassifierRunnerV1;
  readonly callInputs: readonly JsonValue[];
} => {
  const callInputs: JsonValue[] = [];
  const classify: M7FrozenPatrolClassifierRunnerV1["classify"] = async (
    input,
  ) => {
    callInputs.push(input);
    const hasVisibleRows = JSON.stringify(input).includes("state_sample");
    return {
      schemaVersion: 1 as const,
      stateDomainId: "patrol.motion" as const,
      classification: hasVisibleRows
        ? ("fell_without_reversing" as const)
        : ("insufficient_observation" as const),
      declaredSampleCount: hasVisibleRows ? 2 : 0,
      entityCount: hasVisibleRows ? 1 : 0,
      fallWitnessCount: hasVisibleRows ? 1 : 0,
      reversalWitnessCount: 0,
      witnesses: hasVisibleRows
        ? [
            {
              entityId: "enemy:patrol-1",
              name: "Patrol enemy",
              outcome: "fell_without_reversing" as const,
              fromFrame: 10,
              toFrame: 20,
              startDirection: 1 as const,
              endDirection: 1 as const,
              startY: 100,
              endY: 120,
            },
          ]
        : [],
    };
  };
  return {
    runner: {
      implementationSha256: digest("frozen classifier bytes"),
      classify,
    },
    callInputs,
  };
};

describe("M7 actual Agent-visible classifier preparation", () => {
  it("does not mistake an ordinary coding tool for a runtime-treatment leak", () => {
    const targets = deriveM7RuntimeTreatmentExclusiveTargetsV1(
      {
        managedRuntime: {
          capability: {
            toolchain: {
              files: [
                { target: "/bin/bash" },
                { target: "/lib/x86_64-linux-gnu/libc.so.6" },
                { target: "/usr/bin/godot" },
              ],
            },
            fontconfigTarget: "/run/chronorift/fontconfig/fonts.conf",
            addonParentTarget: "/run/chronorift/overlay/project/addons",
            addonTarget:
              "/run/chronorift/overlay/project/addons/chronorift_project_environment",
            overlayTarget: "/run/chronorift/overlay/project/override.cfg",
            adapterParentTarget: "/run/chronorift/overlay/project/.chronorift",
            adapterTarget:
              "/run/chronorift/overlay/project/.chronorift/project-adapter",
          },
        },
      } as never,
      ["/bin/bash", "/lib/x86_64-linux-gnu/libc.so.6"],
    );

    expect(targets).not.toContain("/bin/bash");
    expect(targets).not.toContain("/lib/x86_64-linux-gnu/libc.so.6");
    expect(targets).toContain("/usr/bin/godot");
    expect(targets).toContain(
      "/run/chronorift/overlay/project/.chronorift/project-adapter",
    );
  });

  it("associates a real game_query shape without requiring buildId and classifies its first sufficient prefix", async () => {
    const launch = exchange(
      1,
      "game_launch",
      JsonValueSchema.parse({
        schemaVersion: 1,
        outcome: "success",
        output: { taskId: "task:m7:runtime", runtimeId, executionId },
      }),
    );
    const query = exchange(
      2,
      "game_query",
      JsonValueSchema.parse({
        schemaVersion: 1,
        outcome: "success",
        output: {
          taskId: "task:m7:runtime",
          executionId,
          rows: [
            {
              kind: "state_sample",
              clock: { processFrame: 10 },
              recordSequence: 1,
              payload: {
                stateDomainId: "patrol.motion",
                semanticCoverage: "declared",
                value: { agents: [] },
              },
            },
          ],
        },
      }),
    );
    const unrelated = exchange(
      3,
      "game_query",
      JsonValueSchema.parse({
        schemaVersion: 1,
        outcome: "success",
        output: {
          executionId: "execution:m7:other",
          rows: [{ kind: "state_sample" }],
        },
      }),
      "execution:m7:other",
    );
    const selected = selectM7AgentVisibleExecutionExchangesV1({
      exchanges: [unrelated, query, launch],
      executionId,
      runtimeId,
    });
    expect(selected).toEqual([launch, query]);

    const frozen = classifier();
    const result = await classifyM7ActualVisibleExchangePrefixV1({
      exchanges: selected,
      classifier: frozen.runner,
    });

    expect(result.classification).toBe("fell_without_reversing");
    expect(result.classificationHostToolReturnOrdinal).toBe(2);
    expect(frozen.callInputs).toHaveLength(3);
    const finalInput = frozen.callInputs.at(-1);
    expect(finalInput).toMatchObject({
      gameToolExchanges: [
        { hostToolReturnOrdinal: 1 },
        { hostToolReturnOrdinal: 2 },
      ],
      pinnedCaptures: [],
    });
    expect(JSON.stringify(finalInput)).not.toContain("execution:m7:other");
  });

  it("rejects substituting another Adapter or pristine subject after the sensor freeze", () => {
    // The sensor freeze hashes the exact path/byte stream, while the Adapter
    // revision uses the loader's canonical file-manifest identity. They are
    // intentionally different digest domains.
    const adapterPackageBytes =
      "path/to/file.gd\0generic patrol adapter package bytes\0";
    const conformanceBytes = "generic adapter conformance receipt";
    const pristineSelectedTreeSha256 = digest("pristine selected tree");
    const projectSourceIdentity = digest("pristine project source identity");
    const pristineSourceId = `source:v1:${projectSourceIdentity}`;
    const adapterPackageIdentity = digest("canonical adapter file manifest");
    const subjectProjectSha256 = digestJson({
      schemaVersion: 1,
      repository: M7_MODDABLE_PLATFORMER_REPOSITORY_V1,
      revision: M7_MODDABLE_PLATFORMER_REVISION_V1,
      projectSourceIdentity,
      selectedTreeSha256: pristineSelectedTreeSha256,
    });
    const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
      schemaVersion: 1,
      adapterRevisionId: `adapter-revision:v1:${adapterPackageIdentity}`,
      adapterId: "adapter:m7:generic-patrol",
      sourceId: pristineSourceId,
      packageDigest: adapterPackageIdentity,
      manifestDigest: digest("generic manifest"),
      implementationDigest: digest("generic implementation"),
      payloadSchemaDigest: digest("generic payload schemas"),
      sdkDigest: digest("adapter sdk"),
      bridgeDigest: digest("adapter bridge"),
      capabilitySet: {
        schemaVersion: 1,
        modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
          schemaVersion: 1,
          module,
          status: "implemented" as const,
          protocolVersion: "project-environment-v1",
          limitations: [],
        })),
      },
      conformanceReceiptId: "conformance:m7:generic-patrol-v1",
      contentByteLength: adapterPackageBytes.length,
      contentFileCount: 4,
    });
    const sensorFreeze = createM7SensorFreezeRecordV1({
      schemaVersion: 1,
      pristineSubject: {
        repository: M7_MODDABLE_PLATFORMER_REPOSITORY_V1,
        revision: M7_MODDABLE_PLATFORMER_REVISION_V1,
        sourceId: pristineSourceId,
        subjectProjectSha256,
        selectedTreeSha256: pristineSelectedTreeSha256,
      },
      adapterRevisionId: adapterRevision.adapterRevisionId,
      pristineConformanceReceiptId: adapterRevision.conformanceReceiptId,
      materials: {
        adapterPackageBytes,
        observationSchemaBytes: "generic patrol motion state schema",
        classifierImplementationBytes: "generic patrol sequence classifier",
        pristineConformanceReceiptBytes: conformanceBytes,
      },
      frozenAt: "2026-08-15T00:00:00.000Z",
    });
    const assignment = {
      adapterRevision,
      adapterPackage: { candidateSha256: adapterRevision.packageDigest },
      adapterConformanceReceipt: {
        receiptId: adapterRevision.conformanceReceiptId,
      },
      agentProjection: {
        adapter: {
          adapterRevisionId: adapterRevision.adapterRevisionId,
          packageSha256: adapterRevision.packageDigest,
          conformanceReceiptSha256:
            sensorFreeze.sensor.pristineConformanceReceiptSha256,
        },
      },
      assignment: { pristineSelectedTreeSha256 },
      pristineSource: {
        selectedTreeSha256: pristineSelectedTreeSha256,
        projectSourceIdentity,
        headCommit: M7_MODDABLE_PLATFORMER_REVISION_V1,
      },
    };

    expect(sensorFreeze.sensor.adapterPackageSha256).not.toBe(
      adapterRevision.packageDigest,
    );
    expect(sensorFreeze.pristineSubject.subjectProjectSha256).not.toBe(
      projectSourceIdentity,
    );

    expect(() =>
      assertM7PreparedAssignmentMatchesSensorFreezeV1(
        assignment as never,
        sensorFreeze,
      ),
    ).not.toThrow();
    const replacementPackageIdentity = digest(
      "post-mutation bug-specific Adapter",
    );
    expect(() =>
      assertM7PreparedAssignmentMatchesSensorFreezeV1(
        {
          ...assignment,
          adapterRevision: {
            ...adapterRevision,
            adapterRevisionId: `adapter-revision:v1:${replacementPackageIdentity}`,
            packageDigest: replacementPackageIdentity,
          },
          adapterPackage: {
            candidateSha256: replacementPackageIdentity,
          },
          agentProjection: {
            adapter: {
              ...assignment.agentProjection.adapter,
              adapterRevisionId: `adapter-revision:v1:${replacementPackageIdentity}`,
              packageSha256: replacementPackageIdentity,
            },
          },
        } as never,
        sensorFreeze,
      ),
    ).toThrow(/substituted/iu);
    expect(() =>
      assertM7PreparedAssignmentMatchesSensorFreezeV1(
        {
          ...assignment,
          pristineSource: {
            ...assignment.pristineSource,
            selectedTreeSha256: digest("different pristine tree"),
          },
        } as never,
        sensorFreeze,
      ),
    ).toThrow(/substituted/iu);
  });
});
