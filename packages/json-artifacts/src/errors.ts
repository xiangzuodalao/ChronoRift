export class ArtifactNotFoundError extends Error {
  constructor(readonly artifactPath: string) {
    super(`Artifact not found: ${artifactPath}`);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactCorruptionError extends Error {
  constructor(
    readonly artifactPath: string,
    cause: unknown,
  ) {
    super(`Artifact is invalid: ${artifactPath}`, { cause });
    this.name = "ArtifactCorruptionError";
  }
}
