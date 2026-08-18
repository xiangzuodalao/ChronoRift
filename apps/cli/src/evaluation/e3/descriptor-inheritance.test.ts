import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { afterEach, expect, test } from "vitest";

const openedDescriptors: number[] = [];
const openedSockets: Socket[] = [];
const openedServers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const socket of openedSockets.splice(0)) socket.destroy();
  for (const server of openedServers.splice(0)) {
    if (server.listening) {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    }
  }
  for (const fd of openedDescriptors.splice(0)) closeSync(fd);
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

test("the direct live runtime receives descriptors 3 through 15", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chronorift-e3-fd-"));
  temporaryDirectories.push(directory);
  const expected: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const value = `sealed-descriptor-${String(index + 3)}`;
    const path = join(directory, `descriptor-${String(index + 3)}`);
    await writeFile(path, value, { mode: 0o600 });
    openedDescriptors.push(openSync(path, "r"));
    expected.push(value);
  }

  const socketPath = join(directory, "fault-control.sock");
  const server = createServer();
  openedServers.push(server);
  server.listen(socketPath);
  await once(server, "listening");
  const acceptedPromise = once(server, "connection") as Promise<[Socket]>;
  const controller = createConnection(socketPath);
  openedSockets.push(controller);
  await once(controller, "connect");
  const [accepted] = await acceptedPromise;
  openedSockets.push(accepted);
  accepted.pause();

  const runnerUrl = new URL("./conformance-runner.ts", import.meta.url).href;
  const source = `
    import {
      createInheritedE3CampaignConformanceFaultControlPortV1,
      readInheritedE3DescriptorV1,
    } from ${JSON.stringify(runnerUrl)};
    const values = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        readInheritedE3DescriptorV1(index + 3, 1024),
      ),
    );
    createInheritedE3CampaignConformanceFaultControlPortV1(15);
    process.stdout.write(JSON.stringify(values.map((value) =>
      Buffer.from(value).toString("utf8"),
    )));
    process.exit(0);
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
      },
      stdio: ["ignore", "pipe", "pipe", ...openedDescriptors, accepted],
    },
  );
  accepted.destroy();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  if (child.stdout === null || child.stderr === null) {
    throw new Error("descriptor probe did not create output pipes");
  }
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [exitCode, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];

  expect({
    exitCode,
    signal,
    stderr: Buffer.concat(stderr).toString("utf8"),
  }).toEqual({
    exitCode: 0,
    signal: null,
    stderr: "",
  });
  expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toEqual(expected);
});
