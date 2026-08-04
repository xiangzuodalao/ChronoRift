export interface IdGeneratorPort {
  next(kind: "branch" | "event" | "evaluation" | "evidence"): string;
}

export interface ClockPort {
  nowIso(): string;
}
