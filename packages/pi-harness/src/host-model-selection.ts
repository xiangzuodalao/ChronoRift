import { join } from "node:path";

import {
  ModelRuntime,
  resolveCliModel,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { resolvePiHostAgentDirectory } from "./vnext-session.js";
import type { PiThinkingLevel } from "./types.js";

/** Only Host settings may select the initial provider; project settings are untrusted. */
export function createPiHostSettings(agentDirectory?: string): SettingsManager {
  const agentDir = resolvePiHostAgentDirectory(agentDirectory);
  return SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
}

export async function resolvePiHostModel(options: {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly interactive: boolean;
}): Promise<{
  provider: string;
  model: string;
  thinkingLevel: PiThinkingLevel;
}> {
  const agentDir = resolvePiHostAgentDirectory(options.agentDir);
  const settings = createPiHostSettings(agentDir);
  const errors = settings.drainErrors();
  if (errors.length > 0)
    throw new Error(
      "Cannot read Pi Host settings; check settings.json in the Pi agent directory",
    );
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const explicit =
    options.provider !== undefined || options.model !== undefined;
  const provider =
    options.provider ??
    (options.model === undefined ? settings.getDefaultProvider() : undefined);
  const modelId =
    options.model ??
    (options.provider === undefined ||
    options.provider === settings.getDefaultProvider()
      ? settings.getDefaultModel()
      : undefined);
  let model;
  if (modelId !== undefined) {
    const resolved = resolveCliModel({
      ...(provider === undefined ? {} : { cliProvider: provider }),
      ...(modelId === undefined ? {} : { cliModel: modelId }),
      modelRuntime: runtime,
    });
    if (resolved.error !== undefined && explicit)
      throw new Error(resolved.error);
    model =
      resolved.model === undefined
        ? undefined
        : runtime.getModel(resolved.model.provider, resolved.model.id);
    if (model === undefined && explicit)
      throw new Error(
        "The selected Pi model is not registered; use a model from your Pi catalog",
      );
  }
  model ??= (await runtime.getAvailable(options.provider))[0];
  // Opening the TUI must remain possible before /login has configured credentials.
  if (options.interactive) model ??= runtime.getModels(options.provider)[0];
  if (model === undefined)
    throw new Error(
      "No usable Pi model. Run crf in a terminal and use /login and /model, or pass --provider and --model.",
    );
  return {
    provider: model.provider,
    model: model.id,
    thinkingLevel: settings.getDefaultThinkingLevel() ?? "max",
  };
}
