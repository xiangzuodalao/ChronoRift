import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import type { SrtDuplexHandle } from "./srt-sandbox-controller.js";

const MAX_FRAME = 2 * 1024 * 1024;
const diagnosticSchema = z
  .object({
    operation: z.string().max(128),
    step: z.string().max(1024),
    elapsedMs: z.number().int().nonnegative(),
    timeoutMs: z.number().int().positive(),
    leaves: z
      .array(
        z
          .object({ type: z.string().max(128), message: z.string().max(512) })
          .strict(),
      )
      .max(16),
    truncated: z.boolean(),
    lastReadiness: z
      .enum(["ready", "no_scene", "importing", "playing"])
      .optional(),
    pollErrors: z.number().int().nonnegative().optional(),
    lastPollError: z.string().max(512).optional(),
    stderr: z
      .object({
        log: z.string().regex(/^process-\d+\.stderr\.log$/u),
        truncated: z.boolean(),
        incomplete: z.boolean(),
        tail: z.string().max(4096),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024);

export type GodotMcpDiagnostic = z.infer<typeof diagnosticSchema>;

export class GodotMcpControlError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: GodotMcpDiagnostic,
  ) {
    super(message);
    this.name = "GodotMcpControlError";
  }
}

/** Opaque byte relay only. MCP negotiation, schemas and content belong to Pi's adapter. */
export class GodotMcpTransport {
  private server: Server | undefined;
  private process: SrtDuplexHandle | undefined;
  private readonly sockets = new Map<string, Socket>();
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  constructor(private readonly path: string) {}

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      if (!this.process) {
        socket.destroy();
        return;
      }
      const channel = randomUUID();
      this.sockets.set(channel, socket);
      this.send({ op: "open", channel });
      socket.on("data", (chunk: Buffer) => {
        // Pipe backpressure also pauses this client; never accumulate unlimited writes.
        if (
          !this.send({ op: "data", channel, data: chunk.toString("base64") })
        ) {
          socket.pause();
          this.process?.stdin.once("drain", () => socket.resume());
        }
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        this.sockets.delete(channel);
        this.send({ op: "close", channel });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, resolve);
    });
  }

  bind(process: SrtDuplexHandle): Promise<void> {
    this.disconnect();
    this.process = process;
    process.stdin.on("error", () => this.disconnect());
    return new Promise<void>((resolve, reject) => {
      let buffer = "";
      const fail = (error: Error) => {
        reject(error);
        this.disconnect(error);
        void process.stop();
      };
      process.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n")) {
          const offset = buffer.indexOf("\n");
          const line = buffer.slice(0, offset);
          buffer = buffer.slice(offset + 1);
          if (line.length > MAX_FRAME) {
            fail(new Error("MCP transport frame exceeds limit"));
            return;
          }
          try {
            const message = JSON.parse(line) as {
              ready?: boolean;
              channel?: string;
              data?: string;
              closed?: boolean;
              id?: string;
              ok?: boolean;
              value?: unknown;
              error?: string;
              diagnostic?: unknown;
            };
            if (message.ready === true) resolve();
            else if (typeof message.channel === "string") {
              const socket = this.sockets.get(message.channel);
              if (message.closed) socket?.destroy();
              else if (typeof message.data === "string" && socket) {
                if (!socket.write(Buffer.from(message.data, "base64"))) {
                  process.stdout.pause();
                  socket.once("drain", () => process.stdout.resume());
                  socket.once("close", () => process.stdout.resume());
                }
              }
            } else if (typeof message.id === "string") {
              const pending = this.pending.get(message.id);
              if (pending) {
                const diagnostic =
                  message.diagnostic === undefined
                    ? undefined
                    : diagnosticSchema.parse(message.diagnostic);
                this.pending.delete(message.id);
                if (message.ok === true) pending.resolve(message.value);
                else
                  pending.reject(
                    new GodotMcpControlError(
                      typeof message.error === "string"
                        ? message.error.slice(0, 4096)
                        : "Editor control failed",
                      diagnostic,
                    ),
                  );
              }
            }
          } catch {
            fail(new Error("Invalid MCP transport frame"));
            return;
          }
        }
        if (buffer.length > MAX_FRAME)
          fail(new Error("MCP transport frame exceeds limit"));
      });
      void process.wait().then((result) => {
        reject(
          new Error(
            `Godot MCP exited before readiness: ${result.stderr.slice(0, 4096)}`,
          ),
        );
        if (this.process === process) this.disconnect();
      });
    });
  }

  private send(value: object): boolean {
    return this.process?.stdin.write(JSON.stringify(value) + "\n") ?? false;
  }

  async control(command: object, timeoutMs = 50_000): Promise<unknown> {
    if (!this.process) throw new Error("Godot MCP is not running");
    const id = randomUUID();
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new GodotMcpControlError("Editor control timed out", {
            operation:
              "op" in command && typeof command.op === "string"
                ? command.op.slice(0, 128)
                : "unknown",
            step: "waiting for supervisor response",
            elapsedMs: Math.floor(performance.now() - started),
            timeoutMs,
            leaves: [
              {
                type: "TimeoutError",
                message: "Host control deadline elapsed",
              },
            ],
            truncated: false,
          }),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ op: "control", id, command });
    });
  }

  private disconnect(
    error = new Error("Godot MCP process disconnected"),
  ): void {
    this.process = undefined;
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.disconnect();
    if (this.server)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
