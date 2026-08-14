import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
} from "./project-environment-runtime-assets.js";

const treeDigest = (
  files: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[],
): string => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(file.relativePath).update("\0").update(file.bytes).update("\0");
  }
  return hash.digest("hex");
};

describe("the PE-A V1 runtime freeze", () => {
  it("keeps the exact SDK and bridge byte identities while PE-B adds V2", () => {
    expect(treeDigest(PROJECT_ADAPTER_SDK_FILES_V1)).toBe(
      "bc76f2a97b9705b364c429f85ff09c1c937746c3e119c6f16e19102a9f26dce3",
    );
    expect(treeDigest(PROJECT_ENVIRONMENT_BRIDGE_FILES_V1)).toBe(
      "89f7702ac61acec0119b07f2071975f29c1ead9e79b492ea72a026620b00d818",
    );
  });
});
