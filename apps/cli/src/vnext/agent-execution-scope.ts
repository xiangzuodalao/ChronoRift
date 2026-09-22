import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createInspectionGameToolDefinitions,
  createVNextCodingToolDefinitions,
} from "@chronorift/pi-harness";

import { AgentWorkspaceGate } from "./agent-workspace-gate.js";
import { GodotInspectionRuntime } from "./godot-inspection-runtime.js";
import { ExecutionTelemetry } from "./execution-telemetry.js";
import { prepareGodotInspectionCandidate } from "./godot-inspection-source.js";
import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import { SrtGodotRunner } from "./srt-godot-runner.js";
import type { SrtSandboxController } from "./srt-sandbox-controller.js";

export { AgentWorkspaceGate } from "./agent-workspace-gate.js";

export type AgentBoundTool = ReturnType<
  typeof createVNextCodingToolDefinitions
>[number];

/** Host admission is shared by Root and every IPC worker. Cleanup never needs a token. */
export class AgentExecutionBudget {
  #used = 0;
  public constructor(public readonly limit = 256) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new TypeError("Invalid execution budget");
  }
  public get used(): number {
    return this.#used;
  }
  public admit(name: string): void {
    if (name === "game_stop") return;
    if (this.#used >= this.limit)
      throw Object.assign(
        new Error("Shared agent execution budget exhausted"),
        { code: "budget_exhausted" },
      );
    this.#used += 1;
  }
}

export interface AgentExecutionScopeOptions {
  readonly controller: SrtSandboxController;
  readonly taskRootDirectory: string;
  readonly workspaceDirectory: string;
  readonly temporaryDirectory: string;
  readonly artifactsDirectory: string;
  readonly recordsDirectory: string;
  readonly validationDirectory: string;
  readonly nodePath: string;
  readonly godotPath: string;
  readonly budget: AgentExecutionBudget;
  readonly candidateGate?: AgentWorkspaceGate;
  readonly assertUsable?: () => void;
}

/** Owns agent resources without owning Pi or resetting the shared SRT singleton. */
export class AgentExecutionScope {
  public readonly telemetry = new ExecutionTelemetry();
  readonly #scopeGate = new AgentWorkspaceGate();
  public readonly candidateGate: AgentWorkspaceGate;
  readonly #runtimes: GodotInspectionRuntime[] = [];
  #runtime: GodotInspectionRuntime | undefined;
  #abort = new AbortController();
  #closing: Promise<void> | undefined;
  #closed = false;
  #stopping = false;
  readonly #tools: readonly AgentBoundTool[];

  public constructor(private readonly options: AgentExecutionScopeOptions) {
    this.candidateGate = options.candidateGate ?? new AgentWorkspaceGate();
    const coding = createVNextCodingToolDefinitions(
      new SandboxPiCodingToolPort(
        {
          runCoding: (request) =>
            options.controller.runCoding({
              ...request,
              isolationReadRoots: [options.taskRootDirectory],
            }),
        },
        {
          workspacePath: options.workspaceDirectory,
          homePath: join(options.temporaryDirectory, "home"),
          tempPath: join(options.temporaryDirectory, "tmp"),
          artifactsPath: options.artifactsDirectory,
        },
      ),
    );
    const game = createInspectionGameToolDefinitions({
      invoke: (request, signal) => this.runtime().invoke(request, signal),
    });
    this.#tools = [...coding, ...game].map((tool): AgentBoundTool => ({
      ...tool,
      execute: (id, input, signal, onUpdate, context) => {
        const epoch = this.#abort;
        return this.telemetry.measure(tool.name, id, (lock) =>
          this.#scopeGate.run(async () => {
            if (
              this.#closed ||
              this.#stopping ||
              epoch.signal.aborted ||
              signal?.aborted
            ) {
              throw Object.assign(new Error("Agent execution was cancelled"), {
                code: "cancelled",
              });
            }
            if (tool.name !== "game_stop") options.assertUsable?.();
            if (!tool.name.startsWith("game_")) {
              const operationSignal = AbortSignal.any([
                epoch.signal,
                ...(signal === undefined ? [] : [signal]),
              ]);
              lock.requested();
              return this.candidateGate.run(() => {
                lock.acquired();
                options.budget.admit(tool.name);
                return tool.execute(
                  id,
                  input,
                  operationSignal,
                  onUpdate,
                  context,
                );
              }, operationSignal);
            }
            options.budget.admit(tool.name);
            // A launch RPC finishes before its game does. Do not leave that live
            // process attached to a completed Pi tool/turn's cancellation signal.
            const operation = new AbortController();
            const abort = () => operation.abort(signal?.reason);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            try {
              return await tool.execute(
                id,
                input,
                operation.signal,
                onUpdate,
                context,
              );
            } finally {
              signal?.removeEventListener("abort", abort);
            }
          }),
        );
      },
    }));
  }

  public async initialize(): Promise<void> {
    await Promise.all(
      [
        join(this.options.temporaryDirectory, "home"),
        join(this.options.temporaryDirectory, "tmp"),
        this.options.artifactsDirectory,
        this.options.recordsDirectory,
      ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
    );
  }

  /** Track Host workspace operations too, so cancel/close drains every writer. */
  public runWorkspaceOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const operationSignal = AbortSignal.any([
      this.#abort.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    return this.#scopeGate.run(() => {
      if (this.#closed || this.#stopping || operationSignal.aborted)
        throw Object.assign(new Error("Agent execution was cancelled"), {
          code: "cancelled",
        });
      this.options.assertUsable?.();
      return this.candidateGate.run(
        () => operation(operationSignal),
        operationSignal,
      );
    }, operationSignal);
  }

  public tools(): readonly AgentBoundTool[] {
    return this.#tools;
  }

  private runtime(): GodotInspectionRuntime {
    if (this.#runtime !== undefined) return this.#runtime;
    const options = this.options;
    const isolationReadRoots = [options.taskRootDirectory];
    this.#runtime = new GodotInspectionRuntime({
      runner: new SrtGodotRunner({
        controller: {
          openGodot: (request) =>
            options.controller.openGodot({ ...request, isolationReadRoots }),
          openGodotImport: (request) =>
            options.controller.openGodotImport({
              ...request,
              isolationReadRoots,
            }),
        },
        candidateWorkspace: options.workspaceDirectory,
        validationRoot: options.validationDirectory,
      }),
      candidateWorkspace: options.workspaceDirectory,
      captureCandidate: (signal) =>
        this.telemetry.measure(
          "capture_candidate",
          "capture-" + this.telemetry.records.length,
          (lock) => {
            lock.requested();
            return this.candidateGate.run(() => {
              lock.acquired();
              return prepareGodotInspectionCandidate(
                options.workspaceDirectory,
              );
            }, signal);
          },
        ),
      artifactsDirectory: options.recordsDirectory,
      nodePath: options.nodePath,
      godotPath: options.godotPath,
    });
    this.#runtimes.push(this.#runtime);
    return this.#runtime;
  }

  public recordPaths(): readonly string[] {
    return this.#runtimes.flatMap((runtime) => runtime.recordPaths());
  }
  public records(): ReturnType<GodotInspectionRuntime["records"]> {
    return this.#runtimes.flatMap((runtime) => runtime.records());
  }

  /** Stops resources of the current turn, then allows a fresh turn in the same workspace. */
  public cancel(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#stopping = true;
    this.#abort.abort();
    this.#closing = (async () => {
      try {
        const cleanup = await Promise.allSettled([
          this.#runtime?.close(),
          this.#scopeGate.idle(),
        ]);
        const errors = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (errors.length > 0) {
          this.#closed = true;
          throw new AggregateError(errors, "Agent execution cleanup failed");
        }
        this.#runtime = undefined;
      } finally {
        this.#abort = new AbortController();
        this.#stopping = false;
        this.#closing = undefined;
      }
    })();
    return this.#closing;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    try {
      await this.cancel();
    } finally {
      await this.telemetry.save(
        join(this.options.recordsDirectory, "performance.v1.json"),
      );
    }
  }
}
