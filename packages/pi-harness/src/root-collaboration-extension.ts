import {
  CustomEditor,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

import type { RootCollaborationPort } from "./root-collaboration.js";

export const ROOT_COLLABORATION_EXTENSION_NAME = "chronorift-root-control";
const extensionPath = `<inline:${ROOT_COLLABORATION_EXTENSION_NAME}>`;

/** Only a Host-authored inline factory is allowed alongside the fixed tools. */
export function assertRootCollaborationExtensions(
  result: LoadExtensionsResult,
  enabled: boolean,
): void {
  if (
    result.errors.length !== 0 ||
    result.extensions.length !== (enabled ? 1 : 0) ||
    result.extensions.some((extension) => extension.path !== extensionPath)
  ) {
    throw new Error("Project Environment TUI loaded an unexpected extension");
  }
}

export function createRootCollaborationExtension(
  collaboration: RootCollaborationPort | undefined,
  abortRoot: () => Promise<void>,
  onPreparingPrompt: (preparing: boolean) => void = () => undefined,
  onShutdown: () => Promise<void> = () => Promise.resolve(),
): InlineExtension {
  return {
    name: ROOT_COLLABORATION_EXTENSION_NAME,
    factory: (pi) => {
      if (collaboration !== undefined)
        pi.registerCommand("agents", {
          description:
            "Show agents, or stop current agent work with /agents stop",
          handler: async (args, ctx) => {
            if (args.trim() === "stop") {
              collaboration.interrupt();
              await Promise.all([collaboration.stopAgents(), abortRoot()]);
              ctx.ui.notify("Agent work stopped", "info");
            } else if (args.trim() === "") {
              ctx.ui.notify(await collaboration.describeAgents(), "info");
            } else {
              ctx.ui.notify("Usage: /agents or /agents stop", "warning");
            }
          },
        });
      pi.on("input", (_event, ctx) => {
        if (ctx.mode === "tui") {
          onPreparingPrompt(ctx.isIdle());
          collaboration?.onUserInput?.();
        }
        return { action: "continue" };
      });
      pi.on("agent_start", () => {
        onPreparingPrompt(false);
      });
      pi.on("session_shutdown", async (event) => {
        onPreparingPrompt(false);
        if (event.reason === "quit") await onShutdown();
      });
      pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui" || collaboration === undefined) return;
        const rootCollaboration = collaboration;
        // Pi wires submit/change and app actions back to this editor. The
        // dynamic onEscape forwarding also retains retry/compaction handling.
        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
          class CollaborationEditor extends CustomEditor {
            override handleInput(data: string): void {
              if (
                keybindings.matches(data, "app.interrupt") &&
                !this.isShowingAutocomplete()
              ) {
                rootCollaboration.interrupt();
              }
              super.handleInput(data);
            }
          }
          return new CollaborationEditor(tui, theme, keybindings);
        });
      });
    },
  };
}
