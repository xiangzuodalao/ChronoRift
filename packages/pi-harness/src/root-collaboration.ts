import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** The Host owns agent lifetimes; Pi owns what to do with their results. */
export interface RootPiSessionControl {
  isIdle(): boolean;
  deliver(message: string): Promise<void>;
  abort(): Promise<void>;
}

export interface RootCollaborationPort {
  bindRoot(control: RootPiSessionControl): void | (() => void);
  drain(signal?: AbortSignal): Promise<void>;
  /** Synchronously disable automatic continuation before asynchronous cleanup. */
  interrupt(): void;
  describeAgents(): string | Promise<string>;
  stopAgents(): Promise<void>;
  onUserInput?(): void;
}

export async function abortPiSession(session: AgentSession): Promise<void> {
  session.clearQueue();
  session.abortCompaction();
  session.abortBranchSummary();
  await session.abort();
}

export function rootPiSessionControl(
  session: AgentSession,
  isPreparingPrompt: () => boolean = () => false,
): RootPiSessionControl {
  return {
    isIdle: () => session.isIdle && !isPreparingPrompt(),
    deliver: (message) =>
      session.sendCustomMessage(
        {
          customType: "chronorift.collaboration",
          content: message,
          display: true,
          details: { source: "agent-supervisor" },
        },
        isPreparingPrompt()
          ? { triggerTurn: false, deliverAs: "nextTurn" }
          : { triggerTurn: true, deliverAs: "followUp" },
      ),
    abort: () => abortPiSession(session),
  };
}
