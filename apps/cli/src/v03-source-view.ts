import type { RestrictedSourceAccess } from "@chronorift/pi-harness";
import {
  createRestrictedSourceAccess,
  createVirtualSourceAccess,
} from "@chronorift/pi-harness";

import type { V03RunContext } from "./v03-runtime.js";

/** Build the benchmark-safe one-file source view without exposing host paths. */
export async function createV03NeutralSourceAccess(
  context: V03RunContext,
): Promise<RestrictedSourceAccess> {
  const source = await createRestrictedSourceAccess({
    root: context.preparedFixture.sourceDirectory,
    maxReadLines: 5_000,
  });
  const original = await source.read({
    path: context.preparedFixture.oracle.sourcePath,
    limit: 5_000,
  });
  if (original.truncated) {
    throw new Error("Fixture source exceeds the neutral source-view limit");
  }
  return createVirtualSourceAccess({
    files: [{ path: "case/main.gd", content: original.content }],
    maxReadLines: 5_000,
  });
}
