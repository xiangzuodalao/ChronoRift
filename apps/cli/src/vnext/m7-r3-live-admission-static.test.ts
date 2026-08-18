import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const admissionPath = resolve(
  process.cwd(),
  ".chronorift/m7-r3-live/admission.mjs",
);
const liveComposerPath = resolve(
  process.cwd(),
  "apps/cli/src/vnext/moddable-platformer.m7-r3.live.test.ts",
);
const entrypointPath = resolve(
  process.cwd(),
  ".chronorift/m7-r3-live/container-entrypoint.sh",
);

const environmentNames = (source: string, declaration: string): string[] => {
  const match = new RegExp(
    `const ${declaration} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);`,
    "u",
  ).exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`missing ${declaration} declaration`);
  }
  return [...match[1].matchAll(/"(CHRONORIFT_TEST_M7_R3_[A-Z0-9_]+)"/gu)].map(
    (entry) => entry[1]!,
  );
};

describe("M7 R3 static admission path-kind classification", () => {
  it("classifies the operational config root as a directory, never a file", async () => {
    const source = await readFile(admissionPath, "utf8");
    const required = environmentNames(source, "REQUIRED_ENVIRONMENT");
    const directories = environmentNames(source, "DIRECTORY_ENVIRONMENT");
    const operationalRoot = "CHRONORIFT_TEST_M7_R3_OPERATIONAL_CONFIG_ROOT";

    expect(required).toContain(operationalRoot);
    expect(directories).toContain(operationalRoot);
    expect(new Set(directories).size).toBe(directories.length);
    expect(directories.every((name) => required.includes(name))).toBe(true);
    expect(source).toContain("for (const name of DIRECTORY_ENVIRONMENT)");
    expect(source).toContain("for (const name of FILE_ENVIRONMENT)");
    expect(source).not.toContain(
      "for (const name of REQUIRED_ENVIRONMENT.filter",
    );
  });

  it("keeps admission and operational-composer bytes in dynamic source binding", async () => {
    const [liveComposer, entrypoint] = await Promise.all([
      readFile(liveComposerPath, "utf8"),
      readFile(entrypointPath, "utf8"),
    ]);
    expect(liveComposer).toContain('sourceKind: "static-admission"');
    expect(liveComposer).toContain(
      'requiredEnvironment("CHRONORIFT_TEST_M7_R3_STATIC_ADMISSION")',
    );
    expect(liveComposer).toContain('sourceKind: "operational-config-composer"');
    expect(liveComposer).toContain(
      '"CHRONORIFT_TEST_M7_R3_OPERATIONAL_CONFIG_COMPOSER"',
    );
    expect(entrypoint).toContain(
      "CHRONORIFT_TEST_M7_R3_STATIC_ADMISSION=/workspace/.chronorift/m7-r3-live/admission.mjs",
    );
    expect(entrypoint).toContain(
      "CHRONORIFT_TEST_M7_R3_OPERATIONAL_CONFIG_COMPOSER=/workspace/apps/cli/src/vnext/m7-r3-live-operational-config.ts",
    );
  });
});
