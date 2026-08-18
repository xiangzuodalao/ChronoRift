/**
 * R6 is a fresh operator attempt over the frozen R4 protocol-v1 composition.
 * Translate only the operator environment and formal mode; the imported R4
 * composer continues to own the established no-Agent and campaign DTOs.
 */
const R4_PROTOCOL_ENVIRONMENT_SUFFIXES = Object.freeze([
  "PUBLIC_ROOT",
  "STATIC_HOST_ONLY_ROOT",
  "CONSTRUCTION_ROOT",
  "SENSOR_ROOT",
  "PRIVATE_ROOT",
  "RUNS_ROOT",
  "MANIFEST",
  "CASE_01_PRISTINE",
  "CASE_01_MUTANT",
  "CASE_02_PRISTINE",
  "CASE_02_MUTANT",
  "ADAPTER_PACKAGE",
  "ADAPTER_REVISION",
  "ADAPTER_CONFORMANCE",
  "SENSOR_FREEZE",
  "CLASSIFIER_IMPLEMENTATION",
  "PAIRED_AGENT_IMPLEMENTATION",
  "PREPARATION_IMPLEMENTATION",
  "CASE_PREFLIGHT_RUNNER",
  "PREFLIGHT_IMPLEMENTATION",
  "PREFLIGHT_ATTEMPT_RETENTION_IMPLEMENTATION",
  "FORMAL_DRIVER_IMPLEMENTATION",
  "LIVE_MATERIALS_IMPLEMENTATION",
  "NO_AGENT_LIVE_IMPLEMENTATION",
  "GAME_RUNTIME_IMPLEMENTATION",
  "WIRE_CLIENT_IMPLEMENTATION",
  "PREFLIGHT_IMPLEMENTATION_MANIFEST",
  "HOST_CONFIG",
  "OPERATIONAL_CONFIG_ROOT",
  "PREFLIGHT_CONTROL_ROOT",
  "CONTAINER_ENTRYPOINT",
  "RUN_WRAPPER",
  "STATIC_ADMISSION",
  "RUN_CONTROL",
  "LIVE_TEST_CONFIG",
  "LIVE_COMPOSER",
  "OPERATIONAL_CONFIG_COMPOSER",
  "CASE_01_NO_AGENT_HOST_CONFIG",
  "CASE_02_NO_AGENT_HOST_CONFIG",
]);

const installM7R6ProtocolCompatibilityV1 = (): void => {
  const mode = process.env.CHRONORIFT_M7_R6_LIVE_MODE;
  if (
    mode !== "pre-agent-dry-run" &&
    mode !== "no-agent-preflight" &&
    mode !== "r6-live"
  ) {
    throw new Error("M7 R6 composer received an invalid operator mode");
  }
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CHRONORIFT_TEST_M7_R4_")) {
      delete process.env[name];
    }
  }
  if (R4_PROTOCOL_ENVIRONMENT_SUFFIXES.length !== 39) {
    throw new Error("M7 R6 protocol environment whitelist changed");
  }
  for (const suffix of R4_PROTOCOL_ENVIRONMENT_SUFFIXES) {
    const value = process.env[`CHRONORIFT_TEST_M7_R6_${suffix}`];
    if (value === undefined || value.length === 0) {
      throw new Error(`M7 R6 composer is missing protocol input ${suffix}`);
    }
    process.env[`CHRONORIFT_TEST_M7_R4_${suffix}`] = value;
  }
  process.env.CHRONORIFT_M7_R4_LIVE_MODE =
    mode === "r6-live" ? "r4-live" : mode;
};

installM7R6ProtocolCompatibilityV1();
await import("./moddable-platformer.m7-r4.live.test.js");
