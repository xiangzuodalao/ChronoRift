/** Serializes operations; cancellation skips queued work and drains started work. */
export class AgentWorkspaceGate {
  #tail: Promise<unknown> = Promise.resolve();
  public run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let started = false;
    const cancelled = () =>
      Object.assign(new Error("Agent execution was cancelled"), {
        code: "cancelled",
      });
    const result = this.#tail.then(async () => {
      if (signal?.aborted) throw cancelled();
      started = true;
      return operation();
    });
    this.#tail = result.catch(() => undefined);
    if (signal === undefined) return result;
    // A cancelled waiter must not keep its owning scope alive behind another
    // agent's command. The queued slot still drains in order and skips execution.
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (!started) reject(cancelled());
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void result.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort);
      });
    });
  }
  public async idle(): Promise<void> {
    await this.#tail;
  }
}
