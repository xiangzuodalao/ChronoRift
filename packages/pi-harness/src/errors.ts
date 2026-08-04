export type PiHarnessErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_GAME_RESULT"
  | "INVALID_TOOL_FLOW"
  | "INVALID_DIAGNOSIS"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_NOT_TEXT"
  | "SOURCE_OUT_OF_BOUNDS"
  | "MODEL_NOT_FOUND"
  | "MODEL_UNAVAILABLE"
  | "AUTH_FAILED"
  | "AGENT_FAILED"
  | "PROPOSAL_MISSING";

export class PiHarnessError extends Error {
  readonly code: PiHarnessErrorCode;

  constructor(
    code: PiHarnessErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PiHarnessError";
    this.code = code;
  }
}
