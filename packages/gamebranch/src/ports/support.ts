export interface ClockPort {
  nowIso(): string;
}

export interface V01IdGeneratorPort {
  next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string;
}
