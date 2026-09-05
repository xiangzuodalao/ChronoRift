import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";

/** Admit and pin source bytes once; staging must use this exact snapshot. */
export async function prepareGodotInspectionCandidate(
  workspaceDirectory: string,
): Promise<{
  readonly mainScene: string;
  readonly sourceFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
    readonly executable: boolean;
  }[];
}> {
  const files = await collectCandidateGodotSourceV1(
    workspaceDirectory,
    "project-environment",
  );
  if (
    files.some(({ relativePath }) => {
      const path = relativePath.toLowerCase();
      return (
        path === "addons/chronorift_inspection" ||
        path.startsWith("addons/chronorift_inspection/")
      );
    })
  )
    throw new Error(
      "candidate occupies the reserved inspection observer directory",
    );
  const project = files.find(
    ({ relativePath }) => relativePath === "project.godot",
  );
  if (project === undefined)
    throw new Error("candidate is missing project.godot");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    project.content,
  );
  if (text.includes("\0") || /^\s*ChronoRiftInspection\s*=/mu.test(text))
    throw new Error(
      "project.godot contains invalid text or a reserved inspection autoload",
    );
  const matches = [
    ...text.matchAll(/^\s*run\/main_scene\s*=\s*"([^"\r\n]+)"\s*$/gmu),
  ];
  const mainScene = matches[0]?.[1];
  if (
    matches.length !== 1 ||
    mainScene === undefined ||
    mainScene.length > 2048
  )
    throw new Error(
      "project.godot must declare exactly one bounded main scene",
    );
  if (mainScene.startsWith("res://")) {
    const path = mainScene.slice(6);
    if (
      path.includes("\\") ||
      path.includes(":") ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      !files.some(({ relativePath }) => relativePath === path)
    )
      throw new Error(
        "main scene must resolve to an ordinary project-relative source file",
      );
  } else if (!/^uid:\/\/[a-z0-9]+$/u.test(mainScene)) {
    throw new Error("main scene must be a project res:// path or Godot UID");
  }
  return {
    mainScene,
    sourceFiles: files.map((file) => ({
      relativePath: file.relativePath,
      bytes: file.content,
      executable: file.mode === "100755",
    })),
  };
}
