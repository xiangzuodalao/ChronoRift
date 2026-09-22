#!/usr/bin/env node

try {
  const { main } = await import("../dist/chronorift.js");
  await main();
} catch (error) {
  process.stderr.write(
    `ChronoRift: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
