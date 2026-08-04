import { realpath, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { PiHarnessError } from "./errors.js";
import type {
  RestrictedSourceAccess,
  RestrictedSourceAccessOptions,
  SourceReadRequest,
  SourceReadResult,
  SourceSearchMatch,
  SourceSearchRequest,
  SourceSearchResult,
} from "./types.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_READ_LINES = 500;
const DEFAULT_MAX_SEARCH_FILES = 2_000;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_RESULTS = 200;
const MAX_MATCH_TEXT_LENGTH = 500;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function assertPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new PiHarnessError(
      "INVALID_ARGUMENT",
      `${name} must be an integer from 1 to ${maximum}`,
    );
  }
  return resolved;
}

function normalizeRelativeInput(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new PiHarnessError("INVALID_ARGUMENT", `${name} must not be empty`);
  }
  if (isAbsolute(value)) {
    throw new PiHarnessError(
      "SOURCE_OUT_OF_BOUNDS",
      `${name} must be relative to the configured source root`,
    );
  }
  return value;
}

function assertText(content: Buffer, displayPath: string): string {
  if (content.includes(0)) {
    throw new PiHarnessError(
      "SOURCE_NOT_TEXT",
      `${displayPath} appears to be a binary file`,
    );
  }
  return content.toString("utf8");
}

class FileSystemSourceAccess implements RestrictedSourceAccess {
  readonly root: string;
  private readonly maxFileBytes: number;
  private readonly maxReadLines: number;
  private readonly maxSearchFiles: number;

  constructor(
    root: string,
    options: Omit<RestrictedSourceAccessOptions, "root">,
  ) {
    this.root = root;
    this.maxFileBytes = assertPositiveInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      16 * 1024 * 1024,
      "maxFileBytes",
    );
    this.maxReadLines = assertPositiveInteger(
      options.maxReadLines,
      DEFAULT_MAX_READ_LINES,
      5_000,
      "maxReadLines",
    );
    this.maxSearchFiles = assertPositiveInteger(
      options.maxSearchFiles,
      DEFAULT_MAX_SEARCH_FILES,
      20_000,
      "maxSearchFiles",
    );
  }

  private toDisplayPath(absolutePath: string): string {
    return relative(this.root, absolutePath).split(sep).join("/") || ".";
  }

  private async resolveExistingPath(
    input: string,
    name = "path",
  ): Promise<string> {
    const relativeInput = normalizeRelativeInput(input, name);
    const lexicalPath = resolve(this.root, relativeInput);
    if (!isContained(this.root, lexicalPath)) {
      throw new PiHarnessError(
        "SOURCE_OUT_OF_BOUNDS",
        `${name} escapes the configured source root`,
      );
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch (error) {
      throw new PiHarnessError(
        "SOURCE_NOT_FOUND",
        `${name} does not exist: ${relativeInput}`,
        { cause: error },
      );
    }
    if (!isContained(this.root, canonicalPath)) {
      throw new PiHarnessError(
        "SOURCE_OUT_OF_BOUNDS",
        `${name} resolves outside the configured source root`,
      );
    }
    return canonicalPath;
  }

  private async readTextFile(absolutePath: string): Promise<string> {
    const displayPath = this.toDisplayPath(absolutePath);
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        `${displayPath} is not a file`,
      );
    }
    if (info.size > this.maxFileBytes) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        `${displayPath} exceeds the ${this.maxFileBytes} byte source limit`,
      );
    }
    const content = await readFile(absolutePath);
    if (content.byteLength > this.maxFileBytes) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        `${displayPath} grew beyond the ${this.maxFileBytes} byte source limit`,
      );
    }
    return assertText(content, displayPath);
  }

  async read(request: SourceReadRequest): Promise<SourceReadResult> {
    const absolutePath = await this.resolveExistingPath(request.path);
    const content = await this.readTextFile(absolutePath);
    const lines = content
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .split("\n");
    const offset = assertPositiveInteger(
      request.offset,
      1,
      Number.MAX_SAFE_INTEGER,
      "offset",
    );
    const limit = assertPositiveInteger(
      request.limit,
      Math.min(200, this.maxReadLines),
      this.maxReadLines,
      "limit",
    );
    if (offset > lines.length) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        `offset ${offset} exceeds ${lines.length} lines in ${this.toDisplayPath(absolutePath)}`,
      );
    }
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    return {
      path: this.toDisplayPath(absolutePath),
      content: selected.join("\n"),
      startLine: offset,
      endLine: offset + selected.length - 1,
      totalLines: lines.length,
      truncated: offset - 1 + selected.length < lines.length,
    };
  }

  private validateSuffixes(
    includeSuffixes: readonly string[] | undefined,
  ): readonly string[] | undefined {
    if (includeSuffixes === undefined) return undefined;
    if (includeSuffixes.length === 0) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        "includeSuffixes must contain at least one suffix when provided",
      );
    }
    for (const suffix of includeSuffixes) {
      if (
        !suffix.startsWith(".") ||
        suffix.includes("/") ||
        suffix.includes("\\") ||
        suffix.length > 32
      ) {
        throw new PiHarnessError(
          "INVALID_ARGUMENT",
          `Invalid source suffix: ${suffix}`,
        );
      }
    }
    return [...new Set(includeSuffixes)];
  }

  private async collectFiles(
    startPath: string,
    includeSuffixes: readonly string[] | undefined,
  ): Promise<{ files: string[]; hitFileLimit: boolean }> {
    const startInfo = await stat(startPath);
    if (startInfo.isFile()) {
      return {
        files:
          includeSuffixes &&
          !includeSuffixes.some((suffix) => startPath.endsWith(suffix))
            ? []
            : [startPath],
        hitFileLimit: false,
      };
    }
    if (!startInfo.isDirectory()) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        `${this.toDisplayPath(startPath)} is not a file or directory`,
      );
    }

    const files: string[] = [];
    const pending = [startPath];
    const visitedDirectories = new Set<string>();
    let hitFileLimit = false;

    while (pending.length > 0 && !hitFileLimit) {
      const directory = pending.pop();
      if (directory === undefined || visitedDirectories.has(directory))
        continue;
      visitedDirectories.add(directory);

      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isDirectory() && SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
          continue;
        }
        const lexicalPath = join(directory, entry.name);
        let canonicalPath: string;
        try {
          canonicalPath = await realpath(lexicalPath);
        } catch {
          continue;
        }
        // Directory traversal never follows a symlink outside the source root.
        if (!isContained(this.root, canonicalPath)) continue;

        let info;
        try {
          info = await stat(canonicalPath);
        } catch {
          continue;
        }
        if (info.isDirectory()) {
          if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
            pending.push(canonicalPath);
          }
          continue;
        }
        if (!info.isFile()) continue;
        if (
          includeSuffixes &&
          !includeSuffixes.some((suffix) => canonicalPath.endsWith(suffix))
        ) {
          continue;
        }
        files.push(canonicalPath);
        if (files.length >= this.maxSearchFiles) {
          hitFileLimit = true;
          break;
        }
      }
    }
    return { files, hitFileLimit };
  }

  async search(request: SourceSearchRequest): Promise<SourceSearchResult> {
    if (request.query.trim().length === 0) {
      throw new PiHarnessError("INVALID_ARGUMENT", "query must not be empty");
    }
    if (request.query.length > 500) {
      throw new PiHarnessError(
        "INVALID_ARGUMENT",
        "query must not exceed 500 characters",
      );
    }
    const maxResults = assertPositiveInteger(
      request.maxResults,
      DEFAULT_MAX_SEARCH_RESULTS,
      MAX_SEARCH_RESULTS,
      "maxResults",
    );
    const suffixes = this.validateSuffixes(request.includeSuffixes);
    const startPath = await this.resolveExistingPath(request.path ?? ".");
    const { files, hitFileLimit } = await this.collectFiles(
      startPath,
      suffixes,
    );
    const needle = request.caseSensitive
      ? request.query
      : request.query.toLocaleLowerCase("en-US");
    const matches: SourceSearchMatch[] = [];
    let scannedFiles = 0;
    let hitResultLimit = false;

    for (const filePath of files) {
      let info;
      try {
        info = await stat(filePath);
      } catch {
        continue;
      }
      if (info.size > this.maxFileBytes) continue;

      let text: string;
      try {
        text = await this.readTextFile(filePath);
      } catch (error) {
        if (
          error instanceof PiHarnessError &&
          (error.code === "SOURCE_NOT_TEXT" ||
            error.code === "INVALID_ARGUMENT")
        ) {
          continue;
        }
        throw error;
      }
      scannedFiles += 1;
      const lines = text
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .split("\n");
      for (const [index, line] of lines.entries()) {
        const haystack = request.caseSensitive
          ? line
          : line.toLocaleLowerCase("en-US");
        const column = haystack.indexOf(needle);
        if (column === -1) continue;
        matches.push({
          path: this.toDisplayPath(filePath),
          line: index + 1,
          column: column + 1,
          text:
            line.length <= MAX_MATCH_TEXT_LENGTH
              ? line
              : `${line.slice(0, MAX_MATCH_TEXT_LENGTH)}…`,
        });
        if (matches.length >= maxResults) {
          hitResultLimit = true;
          break;
        }
      }
      if (hitResultLimit) break;
    }

    return {
      query: request.query,
      matches,
      scannedFiles,
      truncated: hitFileLimit || hitResultLimit,
    };
  }
}

export async function createRestrictedSourceAccess(
  options: RestrictedSourceAccessOptions,
): Promise<RestrictedSourceAccess> {
  let root: string;
  try {
    root = await realpath(options.root);
  } catch (error) {
    throw new PiHarnessError(
      "SOURCE_NOT_FOUND",
      `Source root does not exist: ${options.root}`,
      { cause: error },
    );
  }
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new PiHarnessError(
      "INVALID_ARGUMENT",
      `Source root is not a directory: ${options.root}`,
    );
  }
  return new FileSystemSourceAccess(root, options);
}
