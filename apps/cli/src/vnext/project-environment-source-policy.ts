/**
 * Pure PE-A source-admission rules shared by the immutable Git source closure
 * and every later Task-workspace Build snapshot. Keeping these rules in one
 * place prevents a post-initialization edit from bypassing the entry check.
 */
export const isProjectEnvironmentSensitivePathV1 = (
  relativePath: string,
): boolean => {
  const normalized = relativePath.toLocaleLowerCase("en-US");
  const segments = normalized.split("/");
  const name = segments.at(-1) ?? "";
  return (
    name.startsWith(".env") ||
    [".aws", ".gnupg", ".ssh"].some((segment) => segments.includes(segment)) ||
    [
      "auth.json",
      "credentials",
      "credentials.json",
      "id_dsa",
      "id_ed25519",
      "id_rsa",
    ].includes(name) ||
    name.endsWith(".key") ||
    name.endsWith(".pem")
  );
};

export type ProjectEnvironmentGdscriptPolicyV1 = "tracked-tool-scripts-v1";

export const hasProjectEnvironmentToolAnnotationV1 = (
  source: string,
): boolean => /^\s*@tool\b/mu.test(source);

export const hasProjectEnvironmentEditorPluginV1 = (source: string): boolean =>
  /^\s*extends\s+EditorPlugin\b/mu.test(source);

export const hasProjectEnvironmentDeferredGdscriptFeatureV1 = (
  source: string,
  gdscriptPolicy?: ProjectEnvironmentGdscriptPolicyV1,
): boolean =>
  hasProjectEnvironmentEditorPluginV1(source) ||
  (gdscriptPolicy !== "tracked-tool-scripts-v1" &&
    hasProjectEnvironmentToolAnnotationV1(source));
