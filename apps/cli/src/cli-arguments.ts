import type { PiThinkingLevel } from "@chronorift/pi-harness";

export interface Arguments {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true | readonly string[]>;
  readonly positionals: readonly string[];
}

const booleanFlags = new Set(["json", "multi-agent"]);
const repeatableFlags = new Set(["include-untracked"]);

export function parseArguments(argv: readonly string[]): Arguments {
  const [rootCommand = "help", ...rootRest] = argv;
  const projectSubcommand = rootCommand === "project" ? rootRest[0] : undefined;
  const command =
    rootCommand === "project" && projectSubcommand !== undefined
      ? `project-${projectSubcommand}`
      : rootCommand;
  const rest = rootCommand === "project" ? rootRest.slice(1) : rootRest;
  const flags = new Map<string, string | true | readonly string[]>();
  const positionals: string[] = [];
  const putFlag = (name: string, value: string | true): void => {
    const existing = flags.get(name);
    if (repeatableFlags.has(name)) {
      if (value === true) {
        throw new Error(`Repeatable flag --${name} requires a value`);
      }
      const existingValues =
        existing !== undefined && typeof existing === "object" ? existing : [];
      flags.set(name, Object.freeze([...existingValues, value]));
      return;
    }
    if (
      existing !== undefined &&
      (command === "project-preview" ||
        command === "demo-platform-alias-ablation" ||
        command === "demo-mob-orientation-ablation")
    ) {
      throw new Error(`Duplicate --${name}`);
    }
    flags.set(name, value);
  };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--") continue;
    if (token === undefined || !token.startsWith("--")) {
      positionals.push(String(token));
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      const name = token.slice(2, equals);
      if (booleanFlags.has(name)) {
        throw new Error(`Boolean flag --${name} does not accept a value`);
      }
      putFlag(name, token.slice(equals + 1));
      continue;
    }
    const name = token.slice(2);
    if (booleanFlags.has(name)) {
      putFlag(name, true);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    putFlag(name, value);
    index += 1;
  }
  if (positionals.length > 0 && command !== "project-preview") {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }
  if (positionals.length > 1) {
    throw new Error("Project Environment preview accepts at most one goal");
  }
  return { command, flags, positionals: Object.freeze(positionals) };
}

export function flag(
  args: Arguments,
  name: string,
  environmentName?: string,
): string | undefined {
  const value = args.flags.get(name);
  return (
    (typeof value === "string" ? value : undefined) ??
    (environmentName === undefined ? undefined : process.env[environmentName])
  );
}

export function hasFlag(args: Arguments, name: string): boolean {
  return args.flags.get(name) === true;
}

export function repeatableFlag(
  args: Arguments,
  name: string,
): readonly string[] {
  const value = args.flags.get(name);
  return value !== undefined && typeof value === "object" ? value : [];
}

export function assertOnlyFlags(
  args: Arguments,
  allowed: readonly string[],
): void {
  const permitted = new Set(allowed);
  for (const name of args.flags.keys()) {
    if (!permitted.has(name)) {
      throw new Error(`Unsupported --${name} for ${args.command}`);
    }
  }
}

export function requiredFlag(
  args: Arguments,
  name: string,
  environmentName?: string,
): string {
  const value = flag(args, name, environmentName);
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing --${name}${environmentName === undefined ? "" : ` or ${environmentName}`}`,
    );
  }
  return value;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function positiveIntegerFlag(
  args: Arguments,
  name: string,
  fallback: number,
): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

export function thinkingLevelFlag(
  args: Arguments,
  fallback: PiThinkingLevel,
  name = "thinking",
): PiThinkingLevel {
  const value = flag(args, name) ?? fallback;
  if (
    value !== "off" &&
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max"
  ) {
    throw new Error(`Unsupported --${name} ${value}`);
  }
  return value;
}
