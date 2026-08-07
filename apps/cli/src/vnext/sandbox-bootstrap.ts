import { z } from "zod";

import {
  NodeProcessDriver,
  type ProcessDriver,
  type ProcessExit,
  type SpawnedIpcProcess,
} from "./process-driver.js";

export interface BootstrapLaunchMessage {
  readonly kind: "launch";
  readonly executable: string;
  readonly args: readonly string[];
}

export type BootstrapToHostMessage =
  | { readonly kind: "ready"; readonly pid: number }
  | { readonly kind: "cgroup_membership"; readonly path: string }
  | { readonly kind: "child_started"; readonly pid: number }
  | { readonly kind: "sandbox_status"; readonly document: unknown }
  | { readonly kind: "authorized" }
  | {
      readonly kind: "child_exit";
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | { readonly kind: "bootstrap_error"; readonly message: string };

const BootstrapToHostMessageSchema: z.ZodType<BootstrapToHostMessage> =
  z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("ready"), pid: z.number().int().positive() })
      .strict(),
    z
      .object({
        kind: z.literal("cgroup_membership"),
        path: z.string().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("child_started"),
        pid: z.number().int().positive(),
      })
      .strict(),
    z
      .object({ kind: z.literal("sandbox_status"), document: z.unknown() })
      .strict(),
    z.object({ kind: z.literal("authorized") }).strict(),
    z
      .object({
        kind: z.literal("child_exit"),
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
      })
      .strict(),
    z
      .object({ kind: z.literal("bootstrap_error"), message: z.string() })
      .strict(),
  ]);

const SandboxStatusDocumentSchema = z
  .object({ "child-pid": z.number().int().positive() })
  .passthrough();

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const childExitedBeforeAuthorizationError = (exit: ProcessExit): Error =>
  new Error(
    `sandbox launcher exited before authorization acknowledgement (exitCode=${String(exit.exitCode)}, signal=${String(exit.signal)})`,
  );

// Self-contained bootstrap source works both under Vitest and from built JS.
// The bootstrap, not the Host caller, owns the block pipe's writer.
const SANDBOX_BOOTSTRAP_SOURCE = String.raw`
  "use strict";
  const { spawn } = require("node:child_process");
  const { readFileSync } = require("node:fs");

  const inheritedCount = Number(process.env.CHRONORIFT_BOOTSTRAP_FD_COUNT);
  let child;
  let guard;
  let launched = false;
  let cgroupInspected = false;
  let authorized = false;
  let terminating = false;

  const send = (message, callback) => {
    if (process.connected) {
      process.send(message, callback);
    } else if (callback) {
      callback(new Error("bootstrap IPC channel is disconnected"));
    }
  };
  const terminate = () => {
    terminating = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    } else if (!child && process.connected) {
      process.disconnect();
    }
  };
  const fail = (message) => {
    send({ kind: "bootstrap_error", message: String(message).slice(0, 4096) });
    terminate();
  };
  const emitJsonDocuments = (stream) => {
    let buffer = "";
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let cursor = 0;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 65536) {
        fail("bubblewrap status exceeded 65536 bytes");
        return;
      }
      for (let index = cursor; index < buffer.length; index += 1) {
        const character = buffer[index];
        if (start < 0) {
          if (/\s/u.test(character)) continue;
          if (character !== "{") {
            fail("bubblewrap status did not start with a JSON object");
            return;
          }
          start = index;
          depth = 1;
          continue;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === "{") depth += 1;
        else if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            const documentBytes = buffer.slice(start, index + 1);
            try {
              send({ kind: "sandbox_status", document: JSON.parse(documentBytes) });
            } catch (error) {
              fail(error instanceof Error ? error.message : String(error));
              return;
            }
            buffer = buffer.slice(index + 1);
            index = -1;
            cursor = 0;
            start = -1;
          }
        }
      }
      cursor = buffer.length;
    });
    stream.on("error", (error) => fail(error.message));
  };

  if (!Number.isInteger(inheritedCount) || inheritedCount < 0 || inheritedCount > 64) {
    fail("invalid inherited descriptor count");
  } else {
    process.on("message", (message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        fail("invalid bootstrap message");
        return;
      }
      const keys = Object.keys(message).sort().join(",");
      if (message.kind === "inspect_cgroup") {
        if (keys !== "kind" || launched || cgroupInspected || terminating) {
          fail("invalid or duplicate cgroup inspection");
          return;
        }
        cgroupInspected = true;
        const line = readFileSync("/proc/self/cgroup", "utf8")
          .split("\n")
          .find((entry) => entry.startsWith("0::"));
        if (!line || line.length <= 3) {
          fail("process cgroup membership is unavailable");
          return;
        }
        send({ kind: "cgroup_membership", path: line.slice(3) });
      } else if (message.kind === "launch") {
        if (launched || !cgroupInspected) {
          fail(
            launched
              ? "bootstrap target already launched"
              : "bootstrap target launched before cgroup inspection",
          );
          return;
        }
        if (
          keys !== "args,executable,kind" ||
          typeof message.executable !== "string" ||
          message.executable.length === 0 ||
          !Array.isArray(message.args) ||
          !message.args.every((argument) => typeof argument === "string")
        ) {
          fail("invalid launch message");
          return;
        }
        launched = true;
        const stdio = ["ignore", "inherit", "inherit", "pipe", "pipe"];
        for (let index = 0; index < inheritedCount; index += 1) stdio.push(4 + index);
        child = spawn(message.executable, [...message.args], {
          cwd: process.cwd(),
          detached: false,
          env: {},
          shell: false,
          stdio,
        });
        child.once("error", (error) => fail(error.message));
        if (child.pid === undefined || !child.stdio[3] || !child.stdio[4]) {
          fail("failed to establish bootstrap guard/status pipes");
          return;
        }
        guard = child.stdio[3];
        emitJsonDocuments(child.stdio[4]);
        send({ kind: "child_started", pid: child.pid });
        child.once("exit", (exitCode, signal) => {
          send({ kind: "child_exit", exitCode, signal });
          guard.destroy();
          if (process.connected) process.disconnect();
        });
      } else if (message.kind === "authorize") {
        if (keys !== "kind" || !launched || authorized || terminating || !guard) {
          fail("invalid or duplicate bootstrap authorization");
          return;
        }
        authorized = true;
        send({ kind: "authorized" }, (error) => {
          if (error) {
            fail(error.message);
            return;
          }
          guard.end(Buffer.from([1]));
        });
      } else if (message.kind === "terminate") {
        if (keys !== "kind") {
          fail("invalid terminate message");
          return;
        }
        terminate();
      } else {
        fail("unsupported bootstrap message");
      }
    });
    process.on("disconnect", terminate);
    send({ kind: "ready", pid: process.pid });
  }
`;

export interface SandboxBootstrapLaunchPlan {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface SandboxBootstrapSession {
  readonly pid: number;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  inspectCgroupMembership(): Promise<string>;
  launch(plan: SandboxBootstrapLaunchPlan): Promise<void>;
  waitForChildStarted(): Promise<number>;
  waitForSandboxStatus(): Promise<Readonly<Record<string, unknown>>>;
  authorize(): Promise<void>;
  terminate(): Promise<void>;
  waitForChildExit(): Promise<ProcessExit>;
  waitForBootstrapExit(): Promise<ProcessExit>;
}

class DirectSandboxBootstrapSession implements SandboxBootstrapSession {
  readonly #cgroupMembership = deferred<string>();
  readonly #childStarted = deferred<number>();
  readonly #status = deferred<Readonly<Record<string, unknown>>>();
  readonly #authorized = deferred<void>();
  readonly #childExit = deferred<ProcessExit>();
  #fatal: Error | undefined;
  #launched = false;
  #cgroupInspectionSent = false;
  #cgroupInspectionObserved = false;
  #statusObserved = false;
  #statusReceived = false;
  #authorizationSent = false;
  #authorizationAcknowledged = false;
  #terminationSent = false;
  #childExited = false;
  #lastChildExit: ProcessExit | undefined;
  readonly #bootstrapExit: Promise<ProcessExit>;

  public constructor(private readonly bootstrapProcess: SpawnedIpcProcess) {
    bootstrapProcess.onMessage((rawMessage) => this.handleMessage(rawMessage));
    this.#bootstrapExit = bootstrapProcess.wait();
    void this.#bootstrapExit.then(
      () => {
        if (!this.#childExited) {
          this.fail(
            new Error("sandbox bootstrap exited before its child receipt"),
          );
        }
      },
      (error: unknown) => this.fail(error),
    );
  }

  public get pid(): number {
    return this.bootstrapProcess.pid;
  }

  public get stdout(): NodeJS.ReadableStream {
    return this.bootstrapProcess.stdout;
  }

  public get stderr(): NodeJS.ReadableStream {
    return this.bootstrapProcess.stderr;
  }

  public async inspectCgroupMembership(): Promise<string> {
    this.throwIfFatal();
    if (this.#launched || this.#cgroupInspectionSent) {
      throw new Error("bootstrap cgroup inspection is no longer available");
    }
    this.#cgroupInspectionSent = true;
    await this.bootstrapProcess.send({ kind: "inspect_cgroup" });
    const path = await this.#cgroupMembership.promise;
    this.#cgroupInspectionObserved = true;
    return path;
  }

  public async launch(plan: SandboxBootstrapLaunchPlan): Promise<void> {
    this.throwIfFatal();
    if (this.#launched) throw new Error("bootstrap target is already launched");
    if (!this.#cgroupInspectionObserved) {
      throw new Error("bootstrap cgroup must be verified before launch");
    }
    this.#launched = true;
    await this.bootstrapProcess.send({
      kind: "launch",
      executable: plan.executable,
      args: [...plan.args],
    });
  }

  public waitForChildStarted(): Promise<number> {
    return this.#childStarted.promise;
  }

  public async waitForSandboxStatus(): Promise<
    Readonly<Record<string, unknown>>
  > {
    const status = await this.#status.promise;
    this.#statusObserved = true;
    return status;
  }

  public async authorize(): Promise<void> {
    this.throwIfFatal();
    if (!this.#statusObserved) {
      throw new Error("sandbox status must be observed before authorization");
    }
    if (this.#authorizationSent) {
      throw new Error("bootstrap authorization was already sent");
    }
    if (this.#lastChildExit !== undefined) {
      throw childExitedBeforeAuthorizationError(this.#lastChildExit);
    }
    this.#authorizationSent = true;
    await this.bootstrapProcess.send({ kind: "authorize" });
    await this.#authorized.promise;
  }

  public async terminate(): Promise<void> {
    if (this.#terminationSent) return;
    this.#terminationSent = true;
    try {
      await this.bootstrapProcess.send({ kind: "terminate" });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  public waitForChildExit(): Promise<ProcessExit> {
    return this.#childExit.promise;
  }

  public waitForBootstrapExit(): Promise<ProcessExit> {
    return this.#bootstrapExit;
  }

  private handleMessage(rawMessage: unknown): void {
    let message: BootstrapToHostMessage;
    try {
      message = BootstrapToHostMessageSchema.parse(rawMessage);
    } catch (error) {
      this.bootstrapProcess.signal("SIGKILL");
      this.fail(error);
      return;
    }
    switch (message.kind) {
      case "ready":
        break;
      case "cgroup_membership":
        this.#cgroupMembership.resolve(message.path);
        break;
      case "child_started":
        this.#childStarted.resolve(message.pid);
        break;
      case "sandbox_status": {
        const status = SandboxStatusDocumentSchema.safeParse(message.document);
        if (status.success) {
          this.#statusReceived = true;
          this.#status.resolve(status.data);
        }
        break;
      }
      case "authorized":
        this.#authorizationAcknowledged = true;
        this.#authorized.resolve();
        break;
      case "child_exit": {
        this.#childExited = true;
        const childExit = {
          exitCode: message.exitCode,
          signal: message.signal as NodeJS.Signals | null,
        };
        this.#lastChildExit = childExit;
        if (!this.#statusReceived) {
          this.#status.reject(
            new Error("sandbox child exited before bubblewrap status"),
          );
        }
        if (this.#authorizationSent && !this.#authorizationAcknowledged) {
          this.#authorized.reject(
            childExitedBeforeAuthorizationError(childExit),
          );
        }
        this.#childExit.resolve(childExit);
        break;
      }
      case "bootstrap_error":
        this.fail(new Error(message.message));
        break;
    }
  }

  private fail(error: unknown): void {
    if (this.#fatal !== undefined) return;
    this.#fatal = error instanceof Error ? error : new Error(String(error));
    this.#childStarted.reject(this.#fatal);
    this.#cgroupMembership.reject(this.#fatal);
    this.#status.reject(this.#fatal);
    this.#authorized.reject(this.#fatal);
    this.#childExit.reject(this.#fatal);
  }

  private throwIfFatal(): void {
    if (this.#fatal !== undefined) throw this.#fatal;
  }
}

const BootstrapReadyMessageSchema = z
  .object({ kind: z.literal("ready"), pid: z.number().int().positive() })
  .strict();

export async function startSandboxBootstrap(input: {
  readonly processDriver?: ProcessDriver;
  readonly cwd: string;
  readonly inheritedFds: readonly number[];
}): Promise<SandboxBootstrapSession> {
  const driver = input.processDriver ?? new NodeProcessDriver();
  const bootstrapProcess = driver.startIpc({
    executable: process.execPath,
    args: ["--input-type=commonjs", "--eval", SANDBOX_BOOTSTRAP_SOURCE],
    cwd: input.cwd,
    env: {
      CHRONORIFT_BOOTSTRAP_FD_COUNT: String(input.inheritedFds.length),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc", ...input.inheritedFds],
  });
  const ready = deferred<void>();
  const unsubscribe = bootstrapProcess.onMessage((message) => {
    const parsed = BootstrapReadyMessageSchema.safeParse(message);
    if (parsed.success && parsed.data.pid === bootstrapProcess.pid)
      ready.resolve();
  });
  void bootstrapProcess.wait().then(
    () => ready.reject(new Error("sandbox bootstrap exited before ready")),
    (error: unknown) => ready.reject(error),
  );
  await ready.promise;
  unsubscribe();
  return new DirectSandboxBootstrapSession(bootstrapProcess);
}
