import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  asSha256DigestV1,
  asTaskId,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import { buildSandboxProcessPlan } from "./bubblewrap-command.js";
import { BoundedOutputCapture } from "./bounded-output.js";
import {
  CgroupV2Controller,
  type ExecutionCgroupScope,
  type CgroupRootIdentity,
  waitForCgroupEmpty,
} from "./cgroup-v2.js";
import {
  SandboxHostCapabilityV1Schema,
  SandboxPreflightReceiptV1Schema,
  type SandboxHostCapabilityV1,
  type SandboxPreflightReceiptV1,
} from "./contracts.js";
import { M1Error, sanitizeM1Diagnostic } from "./errors.js";
import {
  startSandboxBootstrap,
  type SandboxBootstrapSession,
} from "./sandbox-bootstrap.js";
import { resolveResourceLimitsV1 } from "./sandbox-policy.js";

const REQUIRED_BWRAP_FEATURES = [
  "block-fd",
  "json-status-fd",
  "bind-fd",
  "ro-bind-fd",
] as const;
const REQUIRED_NAMESPACES = [
  "mnt",
  "pid",
  "ipc",
  "uts",
  "net",
  "user",
  "cgroup",
] as const;

export interface SandboxHostPreflightRequest {
  readonly delegatedCgroupRoot: string;
  readonly bwrapPath: string;
  readonly prlimitPath: string;
  readonly busyboxPath: string;
}

export interface SandboxHostBinding {
  readonly delegatedCgroupRoot: string;
  readonly bwrapPath: string;
  readonly prlimitPath: string;
  readonly busyboxPath: string;
}

export type SandboxHostPreflightResult =
  | {
      readonly kind: "supported";
      readonly capability: SandboxHostCapabilityV1;
      readonly binding: SandboxHostBinding;
      readonly receipt: Extract<
        SandboxPreflightReceiptV1,
        { readonly status: "supported" }
      >;
    }
  | {
      readonly kind: "unsupported";
      readonly receipt: Extract<
        SandboxPreflightReceiptV1,
        { readonly status: "unsupported" }
      >;
    };

export interface SandboxHostProbeEvidence {
  readonly binding: SandboxHostBinding;
  readonly bwrapIdentity: Sha256DigestV1;
  readonly bwrapVersion: string;
  readonly prlimitIdentity: Sha256DigestV1;
  readonly runtimeIdentity: Sha256DigestV1;
  readonly delegatedCgroupRootIdentity: Sha256DigestV1;
  readonly cgroupNamespaceUnshared: boolean;
  readonly activeProbeSha256: Sha256DigestV1;
}

export interface SandboxHostProbePort {
  now(): string;
  probe(
    request: SandboxHostPreflightRequest,
  ): Promise<SandboxHostProbeEvidence>;
}

interface InspectedExecutable {
  readonly canonicalPath: string;
  readonly identity: Sha256DigestV1;
  readonly bytes: Buffer;
}

interface SandboxHostPathTrustEntry {
  readonly kind: "directory" | "file" | "other" | "symbolic-link";
  readonly mode: number;
  readonly uid: number;
}

export interface SandboxHostPathTrustPort {
  currentUid(): number | undefined;
  canonicalize(path: string): Promise<string>;
  inspect(path: string): Promise<SandboxHostPathTrustEntry>;
  canWrite(path: string): Promise<boolean>;
}

const nodeHostPathTrustPort: SandboxHostPathTrustPort = {
  currentUid: () => process.getuid?.(),
  canonicalize: (path) => realpath(path),
  inspect: async (path) => {
    const statistics = await lstat(path);
    const kind = statistics.isSymbolicLink()
      ? "symbolic-link"
      : statistics.isFile()
        ? "file"
        : statistics.isDirectory()
          ? "directory"
          : "other";
    return { kind, mode: statistics.mode, uid: statistics.uid };
  },
  canWrite: async (path) => {
    try {
      await access(path, constants.W_OK);
      return true;
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
        return false;
      }
      throw error;
    }
  },
};

export async function assertTrustedHostExecutablePath(
  path: string,
  trust: SandboxHostPathTrustPort = nodeHostPathTrustPort,
): Promise<string> {
  const uid = trust.currentUid();
  if (uid === undefined || uid === 0) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox Host must run as a known non-root user",
    );
  }
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox executable path must be absolute and normalized",
    );
  }
  const canonicalPath = await trust.canonicalize(path);
  if (canonicalPath !== path) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox executable path must already be canonical",
    );
  }

  const chain: string[] = [canonicalPath];
  for (let parent = dirname(canonicalPath); ; parent = dirname(parent)) {
    chain.push(parent);
    if (parent === dirname(parent)) break;
  }
  for (const [index, component] of chain.entries()) {
    const entry = await trust.inspect(component);
    const expectedKind = index === 0 ? "file" : "directory";
    if (entry.kind === "symbolic-link") {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox executable path must not contain a symbolic link",
      );
    }
    if (entry.kind !== expectedKind) {
      throw new M1Error(
        "sandbox_preflight_failed",
        `sandbox executable ${index === 0 ? "must be a regular file" : "ancestor must be a directory"}`,
      );
    }
    if (entry.uid !== 0) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox executable and every ancestor must be root-owned",
      );
    }
    if ((entry.mode & 0o022) !== 0) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox executable and every ancestor must not be group or world writable",
      );
    }
    if (await trust.canWrite(component)) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox Host process must not have write access to the executable path",
      );
    }
    if (index === 0 && (entry.mode & 0o111) === 0) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox executable must have an executable mode bit",
      );
    }
  }
  return canonicalPath;
}

const sha256Bytes = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const jsonHash = (value: JsonValue): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(value));

const normalizeBwrapVersion = (rawVersion: string): string => {
  const version = rawVersion.trim();
  const printableAscii = [...version].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0x7e;
  });
  if (
    version.length === 0 ||
    version.length > 128 ||
    !printableAscii ||
    version.includes("/") ||
    version.includes("\\")
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "bubblewrap version must be a short printable single-line value without paths",
    );
  }
  return version;
};

const inspectExecutable = async (
  path: string,
): Promise<InspectedExecutable> => {
  const canonicalPath = await assertTrustedHostExecutablePath(path);
  const bytes = await readFile(canonicalPath);
  return { canonicalPath, identity: sha256Bytes(bytes), bytes };
};

const assertStaticX8664Elf = (bytes: Buffer): void => {
  if (
    bytes.byteLength < 64 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 62
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox runtime must be a little-endian x86-64 ELF executable",
    );
  }
  const programHeaderOffset = Number(bytes.readBigUInt64LE(32));
  const programHeaderSize = bytes.readUInt16LE(54);
  const programHeaderCount = bytes.readUInt16LE(56);
  if (
    !Number.isSafeInteger(programHeaderOffset) ||
    programHeaderSize < 56 ||
    programHeaderOffset + programHeaderSize * programHeaderCount >
      bytes.byteLength
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox runtime has an invalid ELF program header table",
    );
  }
  for (let index = 0; index < programHeaderCount; index += 1) {
    const offset = programHeaderOffset + index * programHeaderSize;
    if (bytes.readUInt32LE(offset) === 3) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox runtime must not require a dynamic ELF interpreter",
      );
    }
  }
};

const runHostExecutable = (
  executable: string,
  args: readonly string[],
): Promise<string> =>
  new Promise((resolveRun, rejectRun) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        env: {
          HOME: "/nonexistent",
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
        },
        maxBuffer: 1024 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectRun(
            new M1Error(
              "sandbox_preflight_failed",
              `sandbox executable probe failed: ${stderr.trim()}`,
              error,
            ),
          );
          return;
        }
        resolveRun(stdout);
      },
    );
  });

const cgroupRootDigest = (identity: CgroupRootIdentity): Sha256DigestV1 =>
  jsonHash({
    schemaVersion: 1,
    canonicalPath: identity.canonicalPath,
    device: identity.device.toString(),
    inode: identity.inode.toString(),
  });

const namespaceIdentities = async (
  pid: number | "self",
): Promise<Readonly<Record<(typeof REQUIRED_NAMESPACES)[number], string>>> => {
  const entries = await Promise.all(
    REQUIRED_NAMESPACES.map(
      async (namespace) =>
        [namespace, await readlink(`/proc/${pid}/ns/${namespace}`)] as const,
    ),
  );
  return Object.fromEntries(entries) as Readonly<
    Record<(typeof REQUIRED_NAMESPACES)[number], string>
  >;
};

const markerExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

const within = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> =>
  new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(() => {
      rejectValue(
        new M1Error(
          "sandbox_preflight_failed",
          `${description} timed out during active sandbox preflight`,
        ),
      );
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectValue(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

const cleanupActiveProbe = async (input: {
  readonly session: SandboxBootstrapSession | undefined;
  readonly scope: ExecutionCgroupScope | undefined;
  readonly controller: CgroupV2Controller | undefined;
}): Promise<void> => {
  await input.session?.terminate().catch(() => undefined);
  await input.scope?.kill().catch(() => false);
  if (input.scope !== undefined) {
    await waitForCgroupEmpty(input.scope).catch(() => undefined);
    await input.scope.remove().catch(() => undefined);
  }
  await input.controller?.cleanup().catch(() => undefined);
};

const runActiveSandboxProbe = async (input: {
  readonly binding: SandboxHostBinding;
  readonly cgroupRoot: CgroupRootIdentity;
}): Promise<Sha256DigestV1> => {
  const probeRoot = await mkdtemp(join(tmpdir(), "chronorift-sandbox-probe-"));
  const workspace = join(probeRoot, "workspace");
  const temporary = join(probeRoot, "tmp");
  const artifacts = join(probeRoot, "artifacts");
  const marker = join(workspace, "authorized-marker");
  const namespaceReceipt = join(workspace, "namespace-receipt");
  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(temporary, { mode: 0o700 }),
    mkdir(artifacts, { mode: 0o700 }),
  ]);

  let controller: CgroupV2Controller | undefined;
  let scope: ExecutionCgroupScope | undefined;
  let session: SandboxBootstrapSession | undefined;
  const stderrCapture = new BoundedOutputCapture(16 * 1024);
  const handles = [] as Awaited<ReturnType<typeof open>>[];
  try {
    controller = await CgroupV2Controller.create(
      input.cgroupRoot.canonicalPath,
      asTaskId(`sandbox-preflight:${randomUUID()}`),
    );
    const limits = resolveResourceLimitsV1("coding-default", 30_000);
    scope = await controller.createExecutionScope("active-probe", limits);
    handles.push(
      await open(
        workspace,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
      await open(
        temporary,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
      await open(
        artifacts,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      ),
      await open(
        input.binding.busyboxPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ),
    );
    session = await within(
      startSandboxBootstrap({
        cwd: probeRoot,
        inheritedFds: handles.map((handle) => handle.fd),
      }),
      5_000,
      "bootstrap readiness",
    );
    session.stdout.on("data", () => undefined);
    session.stderr.on("data", (chunk: Buffer | string) => {
      stderrCapture.add(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });
    await scope.attach(session.pid);
    await scope.verifyAttached(await session.inspectCgroupMembership());

    const plan = buildSandboxProcessPlan({
      request: {
        schemaVersion: 1,
        operationId: "active-probe",
        profile: "coding-default",
        argv: [
          "/bin/busybox",
          "sh",
          "-c",
          'set -eu; for namespace in mnt pid ipc uts net user cgroup; do printf \'%s=\' "$namespace"; readlink "/proc/self/ns/$namespace"; done > /workspace/namespace-receipt; printf authorized > /workspace/authorized-marker',
        ],
        cwd: "/workspace",
        environment: {},
        timeoutMs: 30_000,
      },
      limits,
      binaries: {
        prlimit: input.binding.prlimitPath,
        bwrap: input.binding.bwrapPath,
      },
      runtimeTargets: [{ fd: 8, target: "/bin/busybox" }],
      unshareCgroupNamespace: true,
    });
    await session.launch(plan);
    const [, status] = await within(
      Promise.all([
        session.waitForChildStarted(),
        session.waitForSandboxStatus(),
      ]),
      10_000,
      "bubblewrap status",
    );
    const sandboxPid = status["child-pid"];
    if (typeof sandboxPid !== "number" || !Number.isInteger(sandboxPid)) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "bubblewrap status did not provide a valid child pid",
      );
    }
    if (await markerExists(marker)) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox target ran before Host authorization",
      );
    }
    await session.authorize();
    const childExit = await within(
      session.waitForChildExit(),
      30_000,
      "sandbox target",
    );
    await within(session.waitForBootstrapExit(), 2_000, "bootstrap exit");
    if (childExit.exitCode !== 0 || childExit.signal !== null) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "active sandbox target did not exit successfully",
      );
    }
    if ((await readFile(marker, "utf8")) !== "authorized") {
      throw new M1Error(
        "sandbox_preflight_failed",
        "active sandbox target marker did not match",
      );
    }
    const namespaceLines = (await readFile(namespaceReceipt, "utf8"))
      .trim()
      .split("\n");
    const namespaceEntries = namespaceLines.map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0 || separator === line.length - 1) {
        throw new M1Error(
          "sandbox_preflight_failed",
          "sandbox namespace receipt is malformed",
        );
      }
      return [line.slice(0, separator), line.slice(separator + 1)];
    }) as readonly (readonly [string, string])[];
    const namespaceNames = namespaceEntries.map(([name]) => name);
    if (
      namespaceEntries.length !== REQUIRED_NAMESPACES.length ||
      new Set(namespaceNames).size !== REQUIRED_NAMESPACES.length ||
      [...namespaceNames].sort().join(",") !==
        [...REQUIRED_NAMESPACES].sort().join(",")
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        "sandbox namespace receipt has unexpected fields",
      );
    }
    const sandboxNamespaces = Object.fromEntries(namespaceEntries) as Readonly<
      Record<string, string>
    >;
    const hostNamespaces = await namespaceIdentities("self");
    for (const namespace of REQUIRED_NAMESPACES) {
      if (
        sandboxNamespaces[namespace] === undefined ||
        hostNamespaces[namespace] === sandboxNamespaces[namespace]
      ) {
        throw new M1Error(
          "sandbox_preflight_failed",
          `${namespace} namespace was not isolated`,
        );
      }
    }
    const usage = await scope.usage();
    await waitForCgroupEmpty(scope);
    await scope.remove();
    scope = undefined;
    await controller.cleanup();
    controller = undefined;
    const activeProbeRecord: JsonValue = {
      schemaVersion: 1,
      targetBlockedBeforeAuthorization: true,
      targetCompletedAfterAuthorization: true,
      childExitCode: childExit.exitCode,
      namespaces: Object.fromEntries(
        REQUIRED_NAMESPACES.map((namespace) => [namespace, "isolated"]),
      ),
      resourceUsage: {
        cpuUsageUsec: usage.cpuUsageUsec,
        memoryPeakBytes: usage.memoryPeakBytes,
        pidsPeak: usage.pidsPeak,
      },
    };
    return jsonHash(activeProbeRecord);
  } catch (error) {
    await cleanupActiveProbe({ session, scope, controller });
    const stderr = sanitizeM1Diagnostic(
      Buffer.from(stderrCapture.bytes()).toString("utf8").trim(),
      [probeRoot, workspace, temporary, artifacts],
    );
    if (stderr.length > 0) {
      const code =
        error instanceof M1Error ? error.code : "sandbox_preflight_failed";
      const message = error instanceof Error ? error.message : String(error);
      throw new M1Error(code, `${message}; launcher stderr: ${stderr}`, error);
    }
    throw error;
  } finally {
    await Promise.all(
      handles.map((handle) => handle.close().catch(() => undefined)),
    );
    await rm(probeRoot, { recursive: true, force: true });
  }
};

class RealSandboxHostProbe implements SandboxHostProbePort {
  public now(): string {
    return new Date().toISOString();
  }

  public async probe(
    request: SandboxHostPreflightRequest,
  ): Promise<SandboxHostProbeEvidence> {
    if (process.platform !== "linux" || process.arch !== "x64") {
      throw new M1Error(
        "unsupported_platform",
        "M1 sandbox requires Linux x86-64",
      );
    }
    const [bwrap, prlimit, busybox] = await Promise.all([
      inspectExecutable(request.bwrapPath),
      inspectExecutable(request.prlimitPath),
      inspectExecutable(request.busyboxPath),
    ]);
    assertStaticX8664Elf(busybox.bytes);
    const [bwrapHelp, bwrapVersion] = await Promise.all([
      runHostExecutable(bwrap.canonicalPath, ["--help"]),
      runHostExecutable(bwrap.canonicalPath, ["--version"]),
      runHostExecutable(prlimit.canonicalPath, ["--version"]),
    ]);
    for (const feature of REQUIRED_BWRAP_FEATURES) {
      if (!bwrapHelp.includes(`--${feature}`)) {
        throw new M1Error(
          "sandbox_preflight_failed",
          `bubblewrap lacks required feature ${feature}`,
        );
      }
    }
    const cgroupRoot = await CgroupV2Controller.preflight(
      request.delegatedCgroupRoot,
    );
    const binding = Object.freeze({
      delegatedCgroupRoot: cgroupRoot.canonicalPath,
      bwrapPath: bwrap.canonicalPath,
      prlimitPath: prlimit.canonicalPath,
      busyboxPath: busybox.canonicalPath,
    });
    const activeProbeSha256 = await runActiveSandboxProbe({
      binding,
      cgroupRoot,
    });
    return {
      binding,
      bwrapIdentity: bwrap.identity,
      bwrapVersion,
      prlimitIdentity: prlimit.identity,
      runtimeIdentity: busybox.identity,
      delegatedCgroupRootIdentity: cgroupRootDigest(cgroupRoot),
      cgroupNamespaceUnshared: true,
      activeProbeSha256,
    };
  }
}

export async function preflightSandboxHost(
  request: SandboxHostPreflightRequest,
  dependencies: SandboxHostProbePort = new RealSandboxHostProbe(),
): Promise<SandboxHostPreflightResult> {
  const checkedAt = dependencies.now();
  try {
    const evidence = await dependencies.probe(request);
    const bwrapVersion = normalizeBwrapVersion(evidence.bwrapVersion);
    const capability = SandboxHostCapabilityV1Schema.parse({
      schemaVersion: 1,
      platform: "linux",
      architecture: "x64",
      bwrap: {
        identity: evidence.bwrapIdentity,
        version: bwrapVersion,
        features: REQUIRED_BWRAP_FEATURES,
      },
      prlimitIdentity: evidence.prlimitIdentity,
      runtimeIdentity: evidence.runtimeIdentity,
      delegatedCgroupRootIdentity: evidence.delegatedCgroupRootIdentity,
      controllers: ["cpu", "memory", "pids"],
      cgroupNamespaceUnshared: evidence.cgroupNamespaceUnshared,
      activeProbeSha256: evidence.activeProbeSha256,
    });
    const capabilitySha256 = jsonHash(capability as unknown as JsonValue);
    const receipt = SandboxPreflightReceiptV1Schema.parse({
      schemaVersion: 1,
      status: "supported",
      checkedAt,
      capabilitySha256,
      blockers: [],
    });
    if (receipt.status !== "supported")
      throw new Error("invalid receipt branch");
    return {
      kind: "supported",
      capability: Object.freeze(capability),
      binding: Object.freeze(evidence.binding),
      receipt,
    };
  } catch (error) {
    const code =
      error instanceof M1Error ? error.code : "sandbox_preflight_failed";
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message =
      sanitizeM1Diagnostic(rawMessage, [
        request.delegatedCgroupRoot,
        request.bwrapPath,
        request.prlimitPath,
        request.busyboxPath,
      ]) || "sandbox preflight failed";
    const receipt = SandboxPreflightReceiptV1Schema.parse({
      schemaVersion: 1,
      status: "unsupported",
      checkedAt,
      capabilitySha256: null,
      blockers: [{ code, message }],
    });
    if (receipt.status !== "unsupported")
      throw new Error("invalid receipt branch");
    return { kind: "unsupported", receipt };
  }
}

export async function assertSandboxHostBindingMatches(
  capability: SandboxHostCapabilityV1,
  binding: SandboxHostBinding,
): Promise<void> {
  const [bwrap, prlimit, busybox, cgroupRoot] = await Promise.all([
    inspectExecutable(binding.bwrapPath),
    inspectExecutable(binding.prlimitPath),
    inspectExecutable(binding.busyboxPath),
    CgroupV2Controller.preflight(binding.delegatedCgroupRoot),
  ]);
  if (
    bwrap.identity !== capability.bwrap.identity ||
    prlimit.identity !== capability.prlimitIdentity ||
    busybox.identity !== capability.runtimeIdentity ||
    cgroupRootDigest(cgroupRoot) !== capability.delegatedCgroupRootIdentity
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "sandbox Host binding no longer matches the preflight capability",
    );
  }
}
