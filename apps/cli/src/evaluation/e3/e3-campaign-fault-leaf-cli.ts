import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "@chronorift/json-artifacts";
import type { JsonValue } from "@chronorift/domain";

import {
  createLiveE3RegistrarPortV1,
  E3_CONFORMANCE_EVIDENCE_FILE_V1,
  preflightE3CampaignLiveV1,
  type E3CampaignConformanceFaultCaseV1,
  type E3CampaignConformancePreflightV1,
  type E3CampaignLivePreflightOptionsV1,
} from "./conformance-runner.js";
import {
  E3RegistrarError,
  type E3CampaignRegistrationV1,
} from "./registrar-port.js";

export const E3_CONFORMANCE_FAULT_LEAF_OBSERVATION_SCHEMA_ID_V1 =
  "chronorift.e3.campaign-conformance-fault-leaf-observation" as const;
export const E3_CONFORMANCE_FAULT_LEAF_EXIT_CODE_V1 = 75 as const;
export const E3_CONFORMANCE_FAULT_LEAF_LOGICAL_REGISTRATIONS_V1 = 1 as const;
export const E3_CONFORMANCE_FAULT_LEAF_MAX_IDENTICAL_WIRE_ATTEMPTS_V1 =
  2 as const;

export interface E3CampaignConformanceFaultLeafObservationV1 {
  readonly schemaId: typeof E3_CONFORMANCE_FAULT_LEAF_OBSERVATION_SCHEMA_ID_V1;
  readonly schemaVersion: 1;
  readonly faultCase: E3CampaignConformanceFaultCaseV1;
  readonly status: "dependency_failure_observed";
  readonly observedErrorCode: "live_dependency_unavailable";
  readonly logicalRegistrationOperations: 1;
  readonly maximumIdenticalWireAttempts: 2;
  readonly finalEvidencePresent: false;
  readonly successSummaryPresent: false;
}

interface E3FaultLeafRegistrarV1 {
  registerCampaign(input: {
    readonly manifest: E3CampaignConformancePreflightV1["manifest"];
    readonly actorCapability: string;
  }): Promise<E3CampaignRegistrationV1>;
}

export interface E3CampaignConformanceFaultLeafDependenciesV1 {
  readonly preflight: (
    options?: E3CampaignLivePreflightOptionsV1,
  ) => Promise<E3CampaignConformancePreflightV1>;
  readonly createRegistrar: (
    preflight: E3CampaignConformancePreflightV1,
    environment: NodeJS.ProcessEnv,
  ) => E3FaultLeafRegistrarV1;
}

const DEFAULT_DEPENDENCIES: E3CampaignConformanceFaultLeafDependenciesV1 = {
  preflight: preflightE3CampaignLiveV1,
  createRegistrar: createLiveE3RegistrarPortV1,
};

const parseFaultCase = (
  arguments_: readonly string[],
): E3CampaignConformanceFaultCaseV1 => {
  if (
    arguments_.length !== 1 ||
    (arguments_[0] !== "registrar_unreachable" &&
      arguments_[0] !== "transparency_log_unavailable")
  ) {
    throw new Error(
      "fault leaf requires exactly one frozen fault-case argument",
    );
  }
  return arguments_[0];
};

const assertFinalEvidenceAbsent = async (
  evidenceDirectory: string,
): Promise<void> => {
  try {
    await lstat(join(evidenceDirectory, E3_CONFORMANCE_EVIDENCE_FILE_V1));
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error("fault leaf found a final evidence file");
};

/**
 * Executes only the create-only registration leaf. It deliberately exposes no
 * append, closure, suite, evidence-persistence, or FD15 fault-control path.
 * The registrar client owns the one permitted byte-identical retry.
 */
export const runE3CampaignConformanceFaultLeafV1 = async (input: {
  readonly faultCase: E3CampaignConformanceFaultCaseV1;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly preflight?: E3CampaignLivePreflightOptionsV1 | undefined;
  readonly dependencies?:
    E3CampaignConformanceFaultLeafDependenciesV1 | undefined;
}): Promise<E3CampaignConformanceFaultLeafObservationV1> => {
  const dependencies = input.dependencies ?? DEFAULT_DEPENDENCIES;
  const environment = input.environment ?? process.env;
  const preflight = await dependencies.preflight({
    ...input.preflight,
    environment,
  });
  const registrar = dependencies.createRegistrar(preflight, environment);
  try {
    await registrar.registerCampaign({
      manifest: preflight.manifest,
      actorCapability: preflight.registrationCapability,
    });
  } catch (error) {
    if (!(error instanceof E3RegistrarError) || error.code !== "unavailable") {
      throw error;
    }
    await assertFinalEvidenceAbsent(preflight.evidenceDirectory);
    return {
      schemaId: E3_CONFORMANCE_FAULT_LEAF_OBSERVATION_SCHEMA_ID_V1,
      schemaVersion: 1,
      faultCase: input.faultCase,
      status: "dependency_failure_observed",
      observedErrorCode: "live_dependency_unavailable",
      logicalRegistrationOperations:
        E3_CONFORMANCE_FAULT_LEAF_LOGICAL_REGISTRATIONS_V1,
      maximumIdenticalWireAttempts:
        E3_CONFORMANCE_FAULT_LEAF_MAX_IDENTICAL_WIRE_ATTEMPTS_V1,
      finalEvidencePresent: false,
      successSummaryPresent: false,
    };
  }
  throw new Error("fault leaf registration unexpectedly succeeded");
};

const GENERIC_FAILURE_LINE = "E3.1 fault leaf failed closed\n";

export const runE3CampaignConformanceFaultLeafCliV1 = async (
  input: {
    readonly arguments?: readonly string[] | undefined;
    readonly environment?: NodeJS.ProcessEnv | undefined;
    readonly dependencies?:
      E3CampaignConformanceFaultLeafDependenciesV1 | undefined;
    readonly writeStderr?: ((value: string) => void) | undefined;
  } = {},
): Promise<number> => {
  const writeStderr =
    input.writeStderr ?? ((value) => process.stderr.write(value));
  try {
    const observation = await runE3CampaignConformanceFaultLeafV1({
      faultCase: parseFaultCase(input.arguments ?? process.argv.slice(2)),
      environment: input.environment,
      dependencies: input.dependencies,
    });
    writeStderr(`${canonicalJson(observation as unknown as JsonValue)}\n`);
    return E3_CONFORMANCE_FAULT_LEAF_EXIT_CODE_V1;
  } catch {
    writeStderr(GENERIC_FAILURE_LINE);
    return 1;
  }
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  process.exitCode = await runE3CampaignConformanceFaultLeafCliV1();
}
