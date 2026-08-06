export const M1_ERROR_CODES = [
  "unsupported_platform",
  "sandbox_preflight_failed",
  "source_not_clean",
  "source_feature_unsupported",
  "source_configuration_mismatch",
  "path_denied",
  "capability_denied",
  "sandbox_launch_failed",
  "resource_limit_unavailable",
  "command_failed",
  "command_timed_out",
  "command_cancelled",
  "artifact_write_failed",
  "patch_export_failed",
] as const;

export type M1ErrorCode = (typeof M1_ERROR_CODES)[number];

export class M1Error extends Error {
  public constructor(
    readonly code: M1ErrorCode,
    message: string,
    readonly storedCause?: unknown,
  ) {
    super(
      message,
      storedCause === undefined ? undefined : { cause: storedCause },
    );
    this.name = "M1Error";
  }
}

export class M1PatchExportError extends M1Error {
  public constructor(
    code: "patch_export_failed" | "artifact_write_failed",
    message: string,
    readonly outputPath: string,
    readonly targetPublished: boolean,
    cause?: unknown,
  ) {
    super(code, message, cause);
    this.name = "M1PatchExportError";
  }
}

const SENSITIVE_ENVIRONMENT_KEY =
  /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|SSH/iu;

const replaceAllLiteral = (value: string, sensitiveValue: string): string =>
  value.split(sensitiveValue).join("[REDACTED]");

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;

  let byteLength = 0;
  let truncated = "";
  for (const codePoint of value) {
    const codePointLength = Buffer.byteLength(codePoint, "utf8");
    if (byteLength + codePointLength > maximumBytes) break;
    truncated += codePoint;
    byteLength += codePointLength;
  }
  return truncated;
};

export function sanitizeM1Diagnostic(
  message: string,
  sensitiveValues: readonly string[],
): string {
  let sanitized = message;
  const orderedSensitiveValues = [...new Set(sensitiveValues)]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const sensitiveValue of orderedSensitiveValues) {
    sanitized = replaceAllLiteral(sanitized, sensitiveValue);
  }

  sanitized = sanitized.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+(?::[^\s/@]*)?)@/giu,
    "$1[REDACTED]@",
  );
  sanitized = sanitized.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s]*)/gu,
    (assignment, key: string) =>
      SENSITIVE_ENVIRONMENT_KEY.test(key) ? `${key}=[REDACTED]` : assignment,
  );
  sanitized = sanitized.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu,
    "",
  );
  return truncateUtf8(sanitized, 4096);
}
