import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import {
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import {
  FixtureManifestV1Schema,
  TaskFixtureCapabilityV1Schema,
  type FixtureManifestV1,
  type TaskFixtureCapabilityContentV1,
  type TaskFixtureCapabilityV1,
} from "./contracts.js";
import { M1Error } from "./errors.js";
import { readTrustedSelectedTree } from "./selected-tree.js";

const FIXTURE_MANIFEST_FILENAME = "chronorift.fixture.json";

export interface SupportedFixtureCatalogEntryV1 {
  readonly fixtureId: "frame-input-window";
  readonly manifest: FixtureManifestV1;
  readonly manifestSha256: Sha256DigestV1;
  readonly expectedSelectedTreeSha256: Sha256DigestV1;
}

const canonicalDigest = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(value as JsonValue));

const readManifestBytes = async (root: string): Promise<Buffer> => {
  const manifestPath = join(root, FIXTURE_MANIFEST_FILENAME);
  const handle = await open(
    manifestPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new TypeError("trusted fixture manifest must be a regular file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.size !== before.size ||
      bytes.byteLength !== before.size
    ) {
      throw new Error("trusted fixture manifest changed while being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

const parseManifestBytes = (bytes: Uint8Array): FixtureManifestV1 => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return FixtureManifestV1Schema.parse(JSON.parse(text) as unknown);
};

export async function loadTrustedFixtureCatalog(
  trustedProjectRoot: string,
): Promise<ReadonlyMap<string, SupportedFixtureCatalogEntryV1>> {
  try {
    const firstManifestBytes = await readManifestBytes(trustedProjectRoot);
    const manifest = parseManifestBytes(firstManifestBytes);
    const expectedSelectedTreeSha256 =
      await readTrustedSelectedTree(trustedProjectRoot);
    const secondManifestBytes = await readManifestBytes(trustedProjectRoot);
    if (!firstManifestBytes.equals(secondManifestBytes)) {
      throw new Error("trusted fixture manifest changed during catalog load");
    }

    const entry: SupportedFixtureCatalogEntryV1 = {
      fixtureId: manifest.fixtureId,
      manifest,
      manifestSha256: canonicalDigest(manifest),
      expectedSelectedTreeSha256,
    };
    return new Map([[entry.fixtureId, entry]]);
  } catch (error) {
    if (error instanceof M1Error) throw error;
    throw new M1Error(
      "source_feature_unsupported",
      "trusted supported fixture could not be loaded",
      error,
    );
  }
}

const unsupportedSource = (message: string, cause?: unknown): never => {
  throw new M1Error("source_feature_unsupported", message, cause);
};

export function resolveTaskFixtureCapability(
  source: {
    readonly manifest: FixtureManifestV1;
    readonly selectedTreeSha256: Sha256DigestV1;
  },
  catalog: ReadonlyMap<string, SupportedFixtureCatalogEntryV1>,
): TaskFixtureCapabilityV1 {
  const parsedManifest = FixtureManifestV1Schema.safeParse(source.manifest);
  if (!parsedManifest.success) {
    return unsupportedSource(
      "source fixture manifest is not a supported strict manifest",
      parsedManifest.error,
    );
  }

  const trusted = catalog.get(parsedManifest.data.fixtureId);
  if (trusted === undefined) {
    return unsupportedSource("source fixture id is not supported");
  }
  if (canonicalDigest(parsedManifest.data) !== trusted.manifestSha256) {
    return unsupportedSource(
      "source fixture manifest does not match the trusted manifest",
    );
  }
  if (source.selectedTreeSha256 !== trusted.expectedSelectedTreeSha256) {
    return unsupportedSource(
      "source selected tree does not match the trusted fixture bytes",
    );
  }

  const content: TaskFixtureCapabilityContentV1 = {
    schemaVersion: 1,
    fixtureId: trusted.fixtureId,
    trustedManifestSha256: trusted.manifestSha256,
    baselineSelectedTreeSha256: trusted.expectedSelectedTreeSha256,
    startupScene: trusted.manifest.startupScene,
    protocolVersion: trusted.manifest.protocolVersion,
    runtimeProfile: trusted.manifest.runtimeProfile,
    inputActions: trusted.manifest.inputActions,
    controls: trusted.manifest.controls,
    ignoredCachePaths: trusted.manifest.ignoredCachePaths,
  };
  return TaskFixtureCapabilityV1Schema.parse({
    ...content,
    capabilitySha256: canonicalDigest(content),
  });
}

export function assertCandidateFixtureCompatible(
  candidate: FixtureManifestV1,
  frozen: TaskFixtureCapabilityV1,
): void {
  const parsedFrozen = TaskFixtureCapabilityV1Schema.safeParse(frozen);
  if (!parsedFrozen.success) {
    throw new M1Error(
      "source_configuration_mismatch",
      "frozen task fixture capability is invalid",
      parsedFrozen.error,
    );
  }
  const parsedCandidate = FixtureManifestV1Schema.safeParse(candidate);
  if (!parsedCandidate.success) {
    throw new M1Error(
      "source_configuration_mismatch",
      "candidate fixture manifest does not match the frozen task capability",
      parsedCandidate.error,
    );
  }
  if (
    canonicalDigest(parsedCandidate.data) !==
    parsedFrozen.data.trustedManifestSha256
  ) {
    throw new M1Error(
      "source_configuration_mismatch",
      "candidate fixture manifest does not match the frozen task capability",
    );
  }
}
