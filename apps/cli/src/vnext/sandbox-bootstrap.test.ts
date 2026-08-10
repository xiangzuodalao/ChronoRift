import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  NodeProcessDriver,
  type ProcessDriver,
  type ProcessExit,
  type SpawnedIpcProcess,
  type SpawnedProcess,
} from "./process-driver.js";
import {
  SandboxBootstrapReadinessCleanupError,
  startSandboxBootstrap,
} from "./sandbox-bootstrap.js";

class NeverReadyProcessDriver implements ProcessDriver {
  readonly signals: NodeJS.Signals[] = [];
  readonly #exit: Promise<ProcessExit>;
  readonly #resolveExit: (exit: ProcessExit) => void;

  public constructor() {
    let resolveExit!: (exit: ProcessExit) => void;
    this.#exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    this.#resolveExit = resolveExit;
  }

  public start(): SpawnedProcess {
    throw new Error("unexpected non-IPC process start");
  }

  public startIpc(): SpawnedIpcProcess {
    return {
      pid: 12345,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      wait: () => this.#exit,
      signal: (signal) => {
        this.signals.push(signal);
      },
      send: () => Promise.resolve(),
      onMessage: () => () => undefined,
    };
  }

  public completeExit(): void {
    this.#resolveExit({ exitCode: null, signal: "SIGKILL" });
  }
}

const blockedChildSource = String.raw`
  const fs = require("node:fs");
  const marker = process.argv[1];
  fs.writeSync(4, JSON.stringify({"child-pid": process.pid}));
  const byte = Buffer.alloc(1);
  fs.readSync(3, byte, 0, 1, null);
  fs.writeFileSync(marker, "executed\n");
`;

const fragmentedStatusChildSource = String.raw`
  const fs = require("node:fs");
  const marker = process.argv[1];
  const status = JSON.stringify({"child-pid": process.pid});
  let offset = 0;
  const writeNext = () => {
    if (offset < status.length) {
      fs.writeSync(4, status[offset]);
      offset += 1;
      setTimeout(writeNext, 1);
      return;
    }
    const byte = Buffer.alloc(1);
    fs.readSync(3, byte, 0, 1, null);
    fs.writeFileSync(marker, "executed\n");
  };
  writeNext();
`;

const exitedAfterStatusChildSource = String.raw`
  const fs = require("node:fs");
  fs.writeSync(4, JSON.stringify({"child-pid": process.pid}));
  process.exit(23);
`;

const stdinChildSource = String.raw`
  const fs = require("node:fs");
  const marker = process.argv[1];
  fs.writeSync(4, JSON.stringify({"child-pid": process.pid}));
  const byte = Buffer.alloc(1);
  fs.readSync(3, byte, 0, 1, null);
  fs.writeFileSync(marker, fs.readFileSync(0));
`;

describe("sandbox bootstrap", () => {
  it("kills and reaps a detached bootstrap that never becomes ready", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chronorift-bootstrap-never-ready-"),
    );
    const processDriver = new NeverReadyProcessDriver();

    const startup = startSandboxBootstrap({
      processDriver,
      cwd: directory,
      inheritedFds: [],
      readinessTimeoutMs: 5,
      terminationTimeoutMs: 1_000,
    });
    const rejected = expect(startup).rejects.toThrow(/readiness timed out/u);
    let settled = false;
    void startup.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => expect(processDriver.signals).toEqual(["SIGKILL"]));
    expect(settled).toBe(false);
    processDriver.completeExit();
    await rejected;
    expect(settled).toBe(true);
  });

  it("retains retry ownership when detached bootstrap exit cannot be proven", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chronorift-bootstrap-unproven-exit-"),
    );
    const processDriver = new NeverReadyProcessDriver();

    const error = await startSandboxBootstrap({
      processDriver,
      cwd: directory,
      inheritedFds: [],
      readinessTimeoutMs: 5,
      terminationTimeoutMs: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxBootstrapReadinessCleanupError);
    expect(processDriver.signals).toEqual(["SIGKILL"]);
    if (!(error instanceof SandboxBootstrapReadinessCleanupError)) {
      throw new Error("expected retained bootstrap process ownership");
    }

    await expect(error.retryCleanup()).rejects.toThrow(
      /termination timed out/u,
    );
    expect(processDriver.signals).toEqual(["SIGKILL", "SIGKILL"]);

    processDriver.completeExit();
    await expect(error.retryCleanup()).resolves.toBeUndefined();
    const signalsAfterProof = [...processDriver.signals];
    await expect(error.retryCleanup()).resolves.toBeUndefined();
    expect(processDriver.signals).toEqual(signalsAfterProof);
  });

  it("does not execute the target before status validation and authorization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chronorift-bootstrap-"));
    const marker = join(directory, "marker");
    const session = await startSandboxBootstrap({
      processDriver: new NodeProcessDriver(),
      cwd: directory,
      inheritedFds: [],
    });
    await expect(session.inspectCgroupMembership()).resolves.toMatch(/^\//u);

    await session.launch({
      executable: process.execPath,
      args: ["-e", blockedChildSource, marker],
    });
    const status = await session.waitForSandboxStatus();
    expect(typeof status["child-pid"]).toBe("number");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await session.authorize();
    await expect(session.waitForChildExit()).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
    });
    await expect(readFile(marker, "utf8")).resolves.toBe("executed\n");
  });

  it("kills a blocked child without releasing it when authorization is denied", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chronorift-bootstrap-deny-"),
    );
    const marker = join(directory, "marker");
    const session = await startSandboxBootstrap({
      processDriver: new NodeProcessDriver(),
      cwd: directory,
      inheritedFds: [],
    });
    await session.inspectCgroupMembership();

    await session.launch({
      executable: process.execPath,
      args: ["-e", blockedChildSource, marker],
    });
    await session.waitForSandboxStatus();
    await session.terminate();
    await session.waitForChildExit();
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("parses a status object fragmented across pipe data events", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chronorift-bootstrap-fragmented-"),
    );
    const marker = join(directory, "marker");
    const session = await startSandboxBootstrap({
      processDriver: new NodeProcessDriver(),
      cwd: directory,
      inheritedFds: [],
    });
    await session.inspectCgroupMembership();

    await session.launch({
      executable: process.execPath,
      args: ["-e", fragmentedStatusChildSource, marker],
    });
    const status = await session.waitForSandboxStatus();
    expect(typeof status["child-pid"]).toBe("number");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await session.authorize();
    await expect(session.waitForChildExit()).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(readFile(marker, "utf8")).resolves.toBe("executed\n");
  });

  it("reports the launcher exit when it dies before authorization", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chronorift-bootstrap-early-exit-"),
    );
    const session = await startSandboxBootstrap({
      processDriver: new NodeProcessDriver(),
      cwd: directory,
      inheritedFds: [],
    });
    await session.inspectCgroupMembership();

    await session.launch({
      executable: process.execPath,
      args: ["-e", exitedAfterStatusChildSource],
    });
    await session.waitForSandboxStatus();
    await session.waitForChildExit();

    await expect(session.authorize()).rejects.toThrow(
      /exitCode=23, signal=null/u,
    );
  });

  it("delivers opaque stdin bytes without releasing the target early", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chronorift-bootstrap-stdin-"),
    );
    const marker = join(directory, "stdin-marker");
    const session = await startSandboxBootstrap({
      processDriver: new NodeProcessDriver(),
      cwd: directory,
      inheritedFds: [],
    });
    await session.inspectCgroupMembership();
    await session.launch({
      executable: process.execPath,
      args: ["-e", stdinChildSource, marker],
    });
    await session.waitForSandboxStatus();

    const delivery = session.provideStdin(Buffer.from([0, 1, 2, 255]));
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await session.authorize();
    await delivery;
    await session.waitForChildExit();

    await expect(readFile(marker)).resolves.toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
  });

  it("keeps stdin open for a bounded duplex runtime until explicitly ended", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chronorift-bootstrap-duplex-"),
    );
    const marker = join(directory, "duplex-marker");
    const session = await startSandboxBootstrap({
      processDriver: new NodeProcessDriver(),
      cwd: directory,
      inheritedFds: [],
    });
    await session.inspectCgroupMembership();
    await session.launch({
      executable: process.execPath,
      args: ["-e", stdinChildSource, marker],
    });
    await session.waitForSandboxStatus();
    await session.authorize();

    await session.writeStdin(Buffer.from([0, 1]));
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await session.writeStdin(Buffer.from([2, 255]));
    await session.endStdin();
    await session.waitForChildExit();

    await expect(readFile(marker)).resolves.toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    await expect(session.writeStdin(Buffer.from([3]))).rejects.toThrow(
      /stdin.*ended/iu,
    );
  });

  it("rejects a second launch", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chronorift-bootstrap-twice-"),
    );
    const session = await startSandboxBootstrap({
      processDriver: new NodeProcessDriver(),
      cwd: directory,
      inheritedFds: [],
    });
    await session.inspectCgroupMembership();
    const launch = {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
    } as const;
    await session.launch(launch);
    await expect(session.launch(launch)).rejects.toThrow(/already launched/u);
    await session.terminate();
    await session.waitForChildExit();
  });
});
