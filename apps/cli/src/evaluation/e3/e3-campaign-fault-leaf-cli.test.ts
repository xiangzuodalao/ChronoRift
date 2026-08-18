import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@chronorift/json-artifacts";

import {
  E3_CONFORMANCE_EVIDENCE_FILE_V1,
  type E3CampaignConformancePreflightV1,
} from "./conformance-runner.js";
import {
  E3_CONFORMANCE_FAULT_LEAF_EXIT_CODE_V1,
  E3_CONFORMANCE_FAULT_LEAF_OBSERVATION_SCHEMA_ID_V1,
  runE3CampaignConformanceFaultLeafCliV1,
  runE3CampaignConformanceFaultLeafV1,
  type E3CampaignConformanceFaultLeafDependenciesV1,
} from "./e3-campaign-fault-leaf-cli.js";
import { E3RegistrarError } from "./registrar-port.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = async (registration: () => Promise<never>) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-e3-fault-leaf-"));
  temporaryRoots.push(root);
  const evidenceDirectory = join(root, "evidence");
  await mkdir(evidenceDirectory);
  const preflight = {
    evidenceDirectory,
    manifest: { schemaId: "test-manifest" },
    registrationCapability: "registration-capability",
  } as unknown as E3CampaignConformancePreflightV1;
  const calls: Array<Record<string, unknown>> = [];
  const dependencies: E3CampaignConformanceFaultLeafDependenciesV1 = {
    preflight: async () => preflight,
    createRegistrar: () => ({
      registerCampaign: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return await registration();
      },
    }),
  };
  return { calls, dependencies, evidenceDirectory };
};

describe("E3.1 fault-only registration leaf", () => {
  it("emits one strict observation and exit 75 only for registrar unavailability", async () => {
    const { calls, dependencies } = await fixture(async () => {
      throw new E3RegistrarError("unavailable", "fault proxy unreachable");
    });
    const lines: string[] = [];

    const exitCode = await runE3CampaignConformanceFaultLeafCliV1({
      arguments: ["registrar_unreachable"],
      environment: {},
      dependencies,
      writeStderr: (line) => lines.push(line),
    });

    expect(exitCode).toBe(E3_CONFORMANCE_FAULT_LEAF_EXIT_CODE_V1);
    expect(calls).toHaveLength(1);
    const observation = {
      schemaId: E3_CONFORMANCE_FAULT_LEAF_OBSERVATION_SCHEMA_ID_V1,
      schemaVersion: 1,
      faultCase: "registrar_unreachable",
      status: "dependency_failure_observed",
      observedErrorCode: "live_dependency_unavailable",
      logicalRegistrationOperations: 1,
      maximumIdenticalWireAttempts: 2,
      finalEvidencePresent: false,
      successSummaryPresent: false,
    };
    expect(lines).toEqual([`${canonicalJson(observation)}\n`]);
  });

  it.each(["invalid", "conflict", "closed"] as const)(
    "fails generically for a %s registrar response",
    async (code) => {
      const { dependencies } = await fixture(async () => {
        throw new E3RegistrarError(code, "not the injected dependency fault");
      });
      const lines: string[] = [];

      const exitCode = await runE3CampaignConformanceFaultLeafCliV1({
        arguments: ["transparency_log_unavailable"],
        environment: {},
        dependencies,
        writeStderr: (line) => lines.push(line),
      });

      expect(exitCode).toBe(1);
      expect(lines).toEqual(["E3.1 fault leaf failed closed\n"]);
    },
  );

  it("fails generically when registration succeeds or preflight fails", async () => {
    const successful = await fixture(async () => ({}) as never);
    const successLines: string[] = [];
    expect(
      await runE3CampaignConformanceFaultLeafCliV1({
        arguments: ["registrar_unreachable"],
        environment: {},
        dependencies: successful.dependencies,
        writeStderr: (line) => successLines.push(line),
      }),
    ).toBe(1);
    expect(successLines).toEqual(["E3.1 fault leaf failed closed\n"]);

    const preflightLines: string[] = [];
    expect(
      await runE3CampaignConformanceFaultLeafCliV1({
        arguments: ["registrar_unreachable"],
        environment: {},
        dependencies: {
          preflight: async () => {
            throw new Error("missing launch material");
          },
          createRegistrar: () => {
            throw new Error("must not be reached");
          },
        },
        writeStderr: (line) => preflightLines.push(line),
      }),
    ).toBe(1);
    expect(preflightLines).toEqual(["E3.1 fault leaf failed closed\n"]);
  });

  it("rejects missing or extra arguments without running the leaf", async () => {
    const { dependencies } = await fixture(async () => {
      throw new E3RegistrarError("unavailable", "unreachable");
    });
    for (const arguments_ of [
      [],
      ["unknown"],
      ["registrar_unreachable", "extra"],
    ]) {
      const lines: string[] = [];
      expect(
        await runE3CampaignConformanceFaultLeafCliV1({
          arguments: arguments_,
          environment: {},
          dependencies,
          writeStderr: (line) => lines.push(line),
        }),
      ).toBe(1);
      expect(lines).toEqual(["E3.1 fault leaf failed closed\n"]);
    }
  });

  it("does not emit a target observation when final evidence exists", async () => {
    const { dependencies, evidenceDirectory } = await fixture(async () => {
      throw new E3RegistrarError("unavailable", "unreachable");
    });
    await writeFile(
      join(evidenceDirectory, E3_CONFORMANCE_EVIDENCE_FILE_V1),
      "unexpected",
    );

    await expect(
      runE3CampaignConformanceFaultLeafV1({
        faultCase: "registrar_unreachable",
        environment: {},
        dependencies,
      }),
    ).rejects.toThrow("final evidence");
  });
});
