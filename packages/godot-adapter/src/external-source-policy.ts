export const EXTERNAL_GODOT_MAX_FILES_V1 = 4_096;
export const EXTERNAL_GODOT_MAX_BYTES_V1 = 256 * 1024 * 1024;

export const EXTERNAL_GODOT_UNSUPPORTED_SUFFIXES_V1 = Object.freeze([
  ".cs",
  ".csproj",
  ".dll",
  ".dylib",
  ".gdextension",
  ".gdnlib",
  ".sln",
  ".so",
] as const);

const normalizedExternalPath = (relativePath: string): string =>
  relativePath.toLocaleLowerCase("en-US");

export const isExternalGodotReservedSourcePathV1 = (
  relativePath: string,
): boolean => {
  const normalized = normalizedExternalPath(relativePath);
  return (
    normalized === ".chronorift" ||
    normalized.startsWith(".chronorift/") ||
    normalized === "addons" ||
    normalized.startsWith("addons/") ||
    normalized === "override.cfg"
  );
};

export const isExternalGodotNativeSourcePathV1 = (
  relativePath: string,
): boolean => {
  const normalized = normalizedExternalPath(relativePath);
  return EXTERNAL_GODOT_UNSUPPORTED_SUFFIXES_V1.some((suffix) =>
    normalized.endsWith(suffix),
  );
};
