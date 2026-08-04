export interface IdGeneratorPort {
  next(kind: "branch" | "event" | "evaluation" | "evidence"): string;
}

export interface ClockPort {
  nowIso(): string;
}

export interface V01IdGeneratorPort {
  next(
    kind: "branch" | "execution" | "comparison" | "capsule" | "verdict",
  ): string;
}
