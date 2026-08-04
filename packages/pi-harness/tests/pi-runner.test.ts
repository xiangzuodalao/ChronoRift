import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PiHarnessError } from "../src/errors.js";
import { runDeterministicPiDiagnosis } from "../src/harness.js";
import { runPiDiagnosisWithRuntime } from "../src/internal/pi-runner.js";
import {
  FIXTURE_CAPSULE_ID,
  createV01AgentFixtureApi,
  fixtureCandidateExecution,
  fixtureCapsule,
} from "./v01-fixture.js";

const fixtureRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chronorift-pi-v01-"));
  fixtureRoots.push(root);
  return root;
}

describe("real Pi Session with deterministic faux model", () => {
  it("runs the real Agent Loop offline and persists every v0.1 tool exchange", async () => {
    const root = await fixtureRoot();
    const fixture = createV01AgentFixtureApi();
    const network = vi.fn(() => {
      throw new Error("network access is forbidden in the faux test");
    });
    vi.stubGlobal("fetch", network);

    const result = await runDeterministicPiDiagnosis({
      cwd: root,
      runDir: join(root, "run"),
      initialCapsuleId: FIXTURE_CAPSULE_ID,
      game: fixture.api,
    });

    expect(result.proposal.claim.kind).toBe("mechanism");
    if (result.proposal.claim.kind !== "mechanism") {
      throw new Error("Expected a mechanism claim");
    }
    expect(result.proposal.claim).toMatchObject({
      mechanismCode: "signal_before_receiver_connection",
      assertion: {
        signal: {
          kind: "signal",
          source: "switch",
          name: "switch.activated",
        },
        receiver: "door",
        failedDeliveryReason: "receiver_not_connected",
        expectedEffect: {
          kind: "property_equals",
          path: "door.open",
          value: true,
        },
        intervention: { kind: "delay_input", deltaTicks: 1 },
      },
    });
    expect(
      result.proposal.observedFacts.flatMap((fact) => fact.references),
    ).toContainEqual({
      artifactKind: "event",
      eventId: fixtureCapsule.signalDeliveryEventId,
    });
    expect(result.proposal.confidence).toBe(0);
    expect(result.piSession.provider).toBe("chronorift-faux");
    expect(result.piSession.model).toBe("switch-door-v0.1");
    expect(result.piSession.thinkingLevel).toBe("off");
    expect(fixture.state.calls).toEqual([
      `capsule:${FIXTURE_CAPSULE_ID}`,
      "replay:execution-baseline",
      "intervention:execution-baseline:1",
      "compare:execution-baseline-replay:execution-candidate",
    ]);
    expect(network).not.toHaveBeenCalled();

    await expect(access(result.piSession.sessionFile)).resolves.toBeUndefined();
    const sessionJsonl = await readFile(result.piSession.sessionFile, "utf8");
    for (const toolName of [
      "game_get_evidence_capsule",
      "game_replay_execution",
      "game_run_intervention",
      "game_compare_executions",
      "submit_diagnosis_proposal",
    ]) {
      expect(sessionJsonl).toContain(toolName);
    }
  });

  it("uses an unknown proposal when replay quality is insufficient", async () => {
    const root = await fixtureRoot();
    const fixture = createV01AgentFixtureApi({ replayMatches: false });

    const result = await runDeterministicPiDiagnosis({
      cwd: root,
      runDir: join(root, "run"),
      initialCapsuleId: FIXTURE_CAPSULE_ID,
      game: fixture.api,
    });

    expect(result.proposal).toMatchObject({
      claim: { kind: "unknown" },
      confidence: 1,
    });
    expect(result.proposal.blockers).not.toHaveLength(0);
    expect(result.proposal.nextExperiment).toBeTypeOf("string");
  });

  it("abstains when the named receiver connection event is not for the failed receiver", async () => {
    const root = await fixtureRoot();
    const contradictoryCapsule = {
      ...fixtureCapsule,
      eventChain: fixtureCapsule.eventChain.map((event) =>
        event.eventId === fixtureCapsule.receiverConnectedEventId &&
        event.kind === "property_changed"
          ? { ...event, path: "other.receiver_connected" }
          : event,
      ),
    };
    const fixture = createV01AgentFixtureApi({
      capsule: contradictoryCapsule,
    });

    const result = await runDeterministicPiDiagnosis({
      cwd: root,
      runDir: join(root, "run"),
      initialCapsuleId: FIXTURE_CAPSULE_ID,
      game: fixture.api,
    });

    expect(result.proposal.claim.kind).toBe("unknown");
    expect(result.proposal.blockers).not.toHaveLength(0);
  });

  it("abstains when the intervention connects the receiver after Signal emission", async () => {
    const root = await fixtureRoot();
    const [connection, input, signal, delivery, effect] =
      fixtureCandidateExecution.events;
    if (
      connection?.kind !== "property_changed" ||
      input?.kind !== "input" ||
      signal?.kind !== "signal" ||
      delivery?.kind !== "signal_delivery" ||
      effect?.kind !== "property_changed"
    ) {
      throw new Error("Unexpected candidate fixture event order");
    }
    const candidateExecution = {
      ...fixtureCandidateExecution,
      events: [
        { ...input, seq: 0 },
        { ...signal, seq: 1 },
        {
          ...connection,
          seq: 2,
          tick: signal.tick,
          simTimeUs: signal.simTimeUs,
        },
        { ...delivery, seq: 3 },
        { ...effect, seq: 4 },
      ],
    };
    const fixture = createV01AgentFixtureApi({ candidateExecution });

    const result = await runDeterministicPiDiagnosis({
      cwd: root,
      runDir: join(root, "run"),
      initialCapsuleId: FIXTURE_CAPSULE_ID,
      game: fixture.api,
    });

    expect(result.proposal.claim.kind).toBe("unknown");
    expect(result.proposal.blockers).not.toHaveLength(0);
  });

  it("returns a diagnosable error when a real Pi loop never submits", async () => {
    const root = await fixtureRoot();
    const fixture = createV01AgentFixtureApi();
    const faux = fauxProvider({
      api: "chronorift-failure-api",
      provider: "chronorift-failure",
      models: [{ id: "no-submit", input: ["text"] }],
      tokenSize: { min: 4, max: 4 },
    });
    faux.setResponses([
      fauxAssistantMessage("I will not call a tool.", {
        timestamp: 1_735_689_600_000,
      }),
    ]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel("chronorift-failure", "no-submit");
    if (!model) throw new Error("failure model was not registered");

    const failure: unknown = await runPiDiagnosisWithRuntime(
      {
        cwd: root,
        runDir: join(root, "run"),
        initialCapsuleId: FIXTURE_CAPSULE_ID,
        game: fixture.api,
        thinkingLevel: "off",
      },
      { modelRuntime, model },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PiHarnessError);
    if (!(failure instanceof PiHarnessError)) {
      throw new Error("Expected PiHarnessError");
    }
    expect(failure.code).toBe("PROPOSAL_MISSING");
    expect(failure.message).toContain("submit_diagnosis_proposal");
    expect(faux.getPendingResponseCount()).toBe(0);
  });
});
