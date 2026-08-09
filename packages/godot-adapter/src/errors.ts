export class GodotAdapterError extends Error {
  public override readonly name = "GodotAdapterError";

  public constructor(
    public readonly code:
      | "PROCESS_FAILED"
      | "CONNECTION_TIMEOUT"
      | "PROTOCOL_ERROR"
      | "CAPABILITY_UNSUPPORTED"
      | "COMMAND_TIMEOUT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
