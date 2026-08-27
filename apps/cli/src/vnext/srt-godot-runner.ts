import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  stageGodotValidation,
  type GodotValidationOverlayFile,
  type GodotValidationStage,
} from "./godot-validation-stage.js";
import type {
  SrtCommandResult,
  SrtDuplexHandle,
  SrtSandboxController,
} from "./srt-sandbox-controller.js";

export interface SrtGodotProcessResult {
  readonly process: SrtCommandResult;
  readonly sourceSha256: string;
  readonly observedSourceSha256: string;
  readonly sourceUnchanged: boolean;
}

export interface SrtGodotRunHandle {
  readonly process: SrtDuplexHandle;
  readonly completion: Promise<SrtGodotProcessResult>;
  terminate(): Promise<void>;
}

export interface SrtGodotRunnerOptions {
  readonly controller: Pick<SrtSandboxController, "openGodot">;
  readonly candidateWorkspace: string;
  readonly validationRoot: string;
}

export interface OpenSrtGodotOptions {
  readonly overlayFiles?: readonly GodotValidationOverlayFile[] | undefined;
  readonly argv: (stage: GodotValidationStage) => readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly readOnlyPaths?: readonly string[] | undefined;
}

/**
 * Host-side staging plus one SRT process. It deliberately owns no policy
 * registry, backend selection, cgroup bookkeeping, or persisted receipt.
 */
export class SrtGodotRunner {
  public constructor(private readonly options: SrtGodotRunnerOptions) {}

  public async open(input: OpenSrtGodotOptions): Promise<SrtGodotRunHandle> {
    const candidateWorkspace = await realpath(this.options.candidateWorkspace);
    await mkdir(this.options.validationRoot, { recursive: true, mode: 0o700 });
    const stage = await stageGodotValidation({
      candidateWorkspace,
      stageRoot: join(this.options.validationRoot, randomUUID()),
      ...(input.overlayFiles === undefined
        ? {}
        : { overlayFiles: input.overlayFiles }),
    });

    let process: SrtDuplexHandle;
    try {
      process = await this.options.controller.openGodot({
        argv: input.argv(stage),
        cwd: stage.projectStagePath,
        projectStagePath: stage.projectStagePath,
        mutableWorkspacePath: candidateWorkspace,
        homePath: stage.homePath,
        tempPath: stage.tempPath,
        artifactsPath: stage.artifactsPath,
        ...(input.readOnlyPaths === undefined
          ? {}
          : { readOnlyPaths: input.readOnlyPaths }),
        timeoutMs: input.timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.environment === undefined
          ? {}
          : { environment: input.environment }),
      });
    } catch (error) {
      await stage.cleanup();
      throw error;
    }

    const completion = process
      .wait()
      .then(async (result): Promise<SrtGodotProcessResult> => {
        const source = await stage.verifySourceUnchanged();
        return {
          process: result,
          sourceSha256: stage.sourceSha256,
          observedSourceSha256: source.observedSourceSha256,
          sourceUnchanged: source.sourceUnchanged,
        };
      })
      .finally(async () => stage.cleanup());

    return {
      process,
      completion,
      terminate: async () => {
        await process.stop();
        await completion;
      },
    };
  }
}
