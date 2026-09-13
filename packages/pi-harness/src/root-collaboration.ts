import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createPiCollaborationInbox,
  exportPiSessionForkContext,
  type PiCollaborationMessage,
  type PiCollaborationDisposition,
  type PiCollaborationPhase,
  type PiSessionForkContext,
} from "./collaboration-inbox.js";

/** The Host owns agent lifetimes; Pi owns what to do with their results. */
export interface RootPiSessionControl {
  isIdle(): boolean;
  readonly collaborationPhase: PiCollaborationPhase;
  deliver(message: PiCollaborationMessage): Promise<PiCollaborationDisposition>;
  exportForkContext(forkTurns: string): PiSessionForkContext;
  hasPendingMessages(): boolean;
  subscribeActivity(listener: () => void): () => void;
  subscribeConsumption(listener: (ids: readonly string[]) => void): () => void;
  subscribeCollaborationPhase(
    listener: (phase: PiCollaborationPhase) => void,
  ): () => void;
  onUserInput(): void;
  abort(): Promise<void>;
  dispose?(): void;
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
  const inbox = createPiCollaborationInbox(session);
  return {
    isIdle: () => session.isIdle && !isPreparingPrompt(),
    get collaborationPhase() {
      return inbox.phase;
    },
    deliver: (message) => inbox.deliver(message),
    exportForkContext: (forkTurns) =>
      exportPiSessionForkContext(session, forkTurns),
    hasPendingMessages: () => inbox.hasPendingMessages(),
    subscribeActivity: (listener) => inbox.subscribeActivity(listener),
    subscribeConsumption: (listener) => inbox.subscribeConsumption(listener),
    subscribeCollaborationPhase: (listener) => inbox.subscribePhase(listener),
    onUserInput: () => inbox.onUserInput(),
    abort: () => abortPiSession(session),
    dispose: () => inbox.dispose(),
  };
}
