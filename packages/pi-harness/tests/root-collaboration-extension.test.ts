import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DefaultResourceLoader,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  assertRootCollaborationExtensions,
  createRootCollaborationExtension,
} from "../src/root-collaboration-extension.js";
import {
  rootPiSessionControl,
  type RootCollaborationPort,
} from "../src/root-collaboration.js";

const port = (): RootCollaborationPort => ({
  bindRoot: () => undefined,
  drain: async () => undefined,
  interrupt: vi.fn(),
  describeAgents: () => "worker-1: running",
  stopAgents: vi.fn(async () => undefined),
  onUserInput: vi.fn(),
});

describe("trusted Root collaboration UI", () => {
  it("retains results without waking an idle or preflighting Root", async () => {
    const sendCustomMessage = vi.fn(async () => undefined);
    let preparing = true;
    const control = rootPiSessionControl(
      {
        isIdle: true,
        sendCustomMessage,
        agent: { subscribe: () => () => undefined },
        subscribe: () => () => undefined,
      } as unknown as AgentSession,
      () => preparing,
    );
    expect(control.isIdle()).toBe(false);
    const envelope = {
      id: "first",
      kind: "completion" as const,
      from: "/root/worker",
      to: "/root",
      text: "Worker completed during user prompt preflight.",
      createdAt: new Date().toISOString(),
    };
    await control.deliver(envelope);
    expect(sendCustomMessage).not.toHaveBeenCalled();
    preparing = false;
    expect(control.isIdle()).toBe(true);
    await control.deliver({ ...envelope, id: "second" });
    expect(sendCustomMessage).not.toHaveBeenCalled();
    expect(control.hasPendingMessages()).toBe(true);
    control.dispose?.();
  });

  it("keeps /agents stop on the control path and closes automatic wake before stopping", async () => {
    const collaboration = port();
    const order: string[] = [];
    collaboration.interrupt = () => {
      order.push("interrupt");
    };
    collaboration.stopAgents = async () => {
      order.push("stop-workers");
    };
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    const extension = createRootCollaborationExtension(
      collaboration,
      async () => {
        order.push("stop-root");
      },
    );
    const factory =
      typeof extension === "function" ? extension : extension.factory;
    await factory({
      on: vi.fn(),
      registerCommand: (_name: string, value: NonNullable<typeof command>) => {
        command = value;
      },
    } as unknown as ExtensionAPI);
    const notify = vi.fn();
    await command!.handler("stop", {
      ui: { notify },
    } as Parameters<NonNullable<typeof command>["handler"]>[1]);
    expect(order).toEqual(["interrupt", "stop-workers", "stop-root"]);
    expect(notify).toHaveBeenCalledWith("Agent work stopped", "info");
  });

  it("loads only the Host factory while project executable extensions remain disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-root-extension-"));
    try {
      const workspace = join(root, "workspace");
      const agentDir = join(root, "agent");
      await Promise.all([
        mkdir(join(workspace, ".pi", "extensions"), { recursive: true }),
        mkdir(agentDir),
      ]);
      await writeFile(
        join(workspace, ".pi", "extensions", "forbidden.ts"),
        'throw new Error("PROJECT EXTENSION EXECUTED");',
      );
      const loader = new DefaultResourceLoader({
        cwd: workspace,
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        noExtensions: true,
        additionalExtensionPaths: [],
        extensionFactories: [
          createRootCollaborationExtension(port(), async () => undefined),
        ],
      });
      await loader.reload();
      expect(() =>
        assertRootCollaborationExtensions(loader.getExtensions(), true),
      ).not.toThrow();
      expect(
        loader.getExtensions().extensions.map((entry) => entry.path),
      ).toEqual(["<inline:chronorift-root-control>"]);
      expect(() =>
        assertRootCollaborationExtensions(loader.getExtensions(), false),
      ).toThrow("unexpected extension");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks an interrupt before forwarding the configured key to native Pi handling", async () => {
    const collaboration = port();
    const order: string[] = [];
    collaboration.interrupt = () => {
      order.push("host");
    };
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    const extension = createRootCollaborationExtension(
      collaboration,
      async () => undefined,
    );
    const factory =
      typeof extension === "function" ? extension : extension.factory;
    await factory({
      on: (
        name: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) => handlers.set(name, handler),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI);
    type EditorFactory = NonNullable<
      Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]
    >;
    let editorFactory: EditorFactory | undefined;
    handlers.get("session_start")!({}, {
      mode: "tui",
      ui: {
        setEditorComponent: (value: EditorFactory) => {
          editorFactory = value;
        },
      },
    } as unknown as ExtensionContext);
    const keybindings = {
      matches: (data: string, action: string) =>
        data === "configured-interrupt" && action === "app.interrupt",
    } as Parameters<EditorFactory>[2];
    const editor = editorFactory!(
      { requestRender: vi.fn() } as unknown as Parameters<EditorFactory>[0],
      {} as Parameters<EditorFactory>[1],
      keybindings,
    );
    // Pi performs this same dynamic forwarding when installing CustomEditor.
    Object.assign(editor, {
      onEscape: () => {
        order.push("pi");
      },
    });
    editor.handleInput!("configured-interrupt");
    expect(order).toEqual(["host", "pi"]);
  });
});
