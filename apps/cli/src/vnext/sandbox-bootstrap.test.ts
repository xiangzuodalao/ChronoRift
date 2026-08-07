import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NodeProcessDriver } from "./process-driver.js";
import { startSandboxBootstrap } from "./sandbox-bootstrap.js";

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

describe("sandbox bootstrap", () => {
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
