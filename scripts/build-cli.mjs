import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const workspaces = new Map();
const dependencies = {};
for (const group of ["apps", "packages"]) {
  for (const entry of await readdir(resolve(root, group), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const directory = resolve(root, group, entry.name);
    const pkg = JSON.parse(
      await readFile(resolve(directory, "package.json"), "utf8"),
    );
    workspaces.set(pkg.name, resolve(directory, "src/index.ts"));
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith("@chronorift/")) continue;
      if (dependencies[name] !== undefined && dependencies[name] !== version)
        throw new Error(`Conflicting runtime dependency versions for ${name}`);
      dependencies[name] = version;
    }
  }
}

const output = await build({
  absWorkingDir: root,
  entryPoints: {
    chronorift: "apps/cli/src/chronorift.ts",
    "agent-worker": "apps/cli/src/vnext/agent-worker.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  packages: "external",
  metafile: true,
  plugins: [
    {
      name: "chronorift-workspaces",
      setup(builder) {
        builder.onResolve({ filter: /^@chronorift\// }, ({ path }) => {
          const entry = workspaces.get(path);
          if (entry === undefined)
            throw new Error(`Unknown workspace import: ${path}`);
          return { path: entry };
        });
      },
    },
  ],
});

// Include only dependencies actually imported by the executable and its worker.
const required = new Set();
for (const file of Object.values(output.metafile.outputs)) {
  for (const imported of file.imports) {
    if (!imported.external || imported.path.startsWith("node:")) continue;
    const name = imported.path.startsWith("@")
      ? imported.path.split("/").slice(0, 2).join("/")
      : imported.path.split("/")[0];
    if (dependencies[name] === undefined)
      throw new Error(`Undeclared runtime dependency: ${name}`);
    required.add(name);
  }
}

const stage = resolve(root, "dist/npm");
await mkdir(resolve(stage, "bin"), { recursive: true });
await mkdir(resolve(stage, "dist"), { recursive: true });
for (const filename of ["chronorift.js", "agent-worker.js"])
  await copyFile(
    resolve(root, "dist", filename),
    resolve(stage, "dist", filename),
  );
await copyFile(
  resolve(root, "bin/chronorift.mjs"),
  resolve(stage, "bin/chronorift.mjs"),
);
await chmod(resolve(stage, "bin/chronorift.mjs"), 0o755);
await copyFile(resolve(root, "LICENSE"), resolve(stage, "LICENSE"));
await copyFile(
  resolve(root, "docs/installation.md"),
  resolve(stage, "README.md"),
);
await writeFile(
  resolve(stage, "package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      license: manifest.license,
      repository: manifest.repository,
      type: "module",
      engines: manifest.engines,
      os: ["linux"],
      cpu: ["x64"],
      bin: manifest.bin,
      files: ["bin/", "dist/", "LICENSE", "README.md"],
      dependencies: Object.fromEntries(
        [...required].sort().map((name) => [name, dependencies[name]]),
      ),
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(`Installable package staged at ${stage}\n`);
