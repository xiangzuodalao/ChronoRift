import {
  checkGn1Preview,
  parseGn1PreviewCheckArguments,
} from "./gn1-preview-check.js";

const cancellation = new AbortController();
const onSigint = (): void =>
  cancellation.abort(new Error("Interrupted by SIGINT"));
const onSigterm = (): void =>
  cancellation.abort(new Error("Interrupted by SIGTERM"));
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

try {
  const result = await checkGn1Preview(
    parseGn1PreviewCheckArguments(process.argv.slice(2)),
    { signal: cancellation.signal },
  );
  console.log(`Saved candidate check (no model invoked): ${result.directory}`);
  console.log(
    `Exit ${result.exitCode}: ${result.exitCode === 0 ? "baseline fails the target check; candidate passes" : result.exitCode === 1 ? "candidate fails the target check" : "requires review: inputs or execution did not support a complete check"}`,
  );
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}
