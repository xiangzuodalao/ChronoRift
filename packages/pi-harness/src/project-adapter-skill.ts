import { fileURLToPath } from "node:url";

export const PROJECT_ADAPTER_SKILL_V1_NAME = "project-adapter-v1";
export const PROJECT_ADAPTER_SKILL_V1_DIRECTORY = fileURLToPath(
  new URL("../skills/project-adapter-v1", import.meta.url),
);
export const PROJECT_ADAPTER_SKILL_V2_NAME = "project-adapter-v2";
export const PROJECT_ADAPTER_SKILL_V2_DIRECTORY = fileURLToPath(
  new URL("../skills/project-adapter-v2", import.meta.url),
);

export interface ProjectAdapterSkillResourceOptionsV1 {
  readonly additionalSkillPaths: readonly string[];
}

/** Add the pinned authoring skill without disabling Pi's normal skill sources. */
export const projectAdapterSkillResourceOptionsV1 =
  (): ProjectAdapterSkillResourceOptionsV1 =>
    Object.freeze({
      additionalSkillPaths: Object.freeze([PROJECT_ADAPTER_SKILL_V1_DIRECTORY]),
    });

export const projectAdapterSkillResourceOptionsV2 =
  (): ProjectAdapterSkillResourceOptionsV1 =>
    Object.freeze({
      additionalSkillPaths: Object.freeze([PROJECT_ADAPTER_SKILL_V2_DIRECTORY]),
    });
