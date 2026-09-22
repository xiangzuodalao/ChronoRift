# Install and run ChronoRift

ChronoRift provides a `crf` terminal command. Run it inside a Git-managed Godot project to open the Pi
interactive interface. Changes are made in a private candidate; the original project is not automatically modified.

## Install

Requires Node.js >=22.19 and Linux x86_64. Install an explicitly built package:

```bash
npm install -g ./chronorift-0.4.0.tgz
```

The repository can produce this package; these instructions do not imply it has been published to npm:

```bash
nvm use
corepack pnpm install --frozen-lockfile
corepack pnpm pack:cli
npm install -g ./dist/chronorift-0.4.0.tgz
```

For local development, `corepack pnpm build:cli` followed by `npm link` makes the same command available.

The Host also needs Git, Bubblewrap, socat, ripgrep, fontconfig and xdg-user-dirs, with unprivileged user namespaces
enabled. On Ubuntu/Debian, install the packages with:

```bash
sudo apt-get install git bubblewrap socat ripgrep fontconfig xdg-user-dirs curl unzip
```

ChronoRift fails if its sandbox cannot start. It does not change system security settings automatically.

## Open a project

```bash
cd /path/to/my-godot-project
crf
```

On first interactive startup, ChronoRift offers to download its checksum-verified Godot build into
`$XDG_CACHE_HOME/chronorift` (default `~/.cache/chronorift`). For unattended preparation, use `crf setup`.
An explicit `--godot-bin` or `GODOT_BIN` takes precedence; an existing project-local managed `.tools/godot` installation
is also recognized. The npm install itself does not download Godot or change the system sandbox configuration.

Use `/login` to authenticate with a supported Pi provider and `/model` to select a model. ChronoRift reuses Pi's
Host configuration and saves interactive model choices there. Project `.pi/settings.json` cannot select Host model
defaults. `--agent-dir` selects an alternative Host configuration directory.

Run a task directly once authentication is configured:

```bash
crf "Investigate the platform collision problem, make a minimal fix, and validate it."
crf "Investigate the problem" --multi-agent
```

Provider/model precedence is explicit flags, `CHRONORIFT_PI_PROVIDER` / `CHRONORIFT_PI_MODEL`, saved Pi defaults,
then an available authenticated model. Explicit invalid model selections fail instead of silently selecting a different
model. On a fresh unauthenticated interactive startup, a registered model allows the UI to open for `/login` and `/model`.

Use `--project-root game` when the Godot project is in a `game/` subdirectory of the Git repository. Tracked files
include current working-tree changes. Include new untracked files explicitly with repeated
`--include-untracked relative/file.gd` flags. Each invocation creates a fresh candidate and Session.

Use `--json` with a task for structured output, or `crf --help` for all options. The result includes a candidate
patch path and runtime records. Review the patch and apply it yourself, then run your project's acceptance checks;
`completed` means the Agent Loop finished, not that the fix passed acceptance.

Preview uses headless Godot and currently queries live objects and properties. It does not provide visual control,
pause/step, input replay, C#/.NET support or native extension support.
