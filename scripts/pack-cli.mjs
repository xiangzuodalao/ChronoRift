import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const stage = fileURLToPath(new URL("../dist/npm/", import.meta.url));
const result = spawnSync(
  "npm",
  ["pack", "--ignore-scripts", "--pack-destination", ".."],
  {
    cwd: stage,
    stdio: "inherit",
    shell: false,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
