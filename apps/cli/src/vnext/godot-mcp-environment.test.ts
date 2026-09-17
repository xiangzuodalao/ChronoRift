import { describe, expect, it } from "vitest";
import {
  addGodotMcpConfiguration,
  removeGodotMcpConfiguration,
} from "./godot-mcp-environment.js";

describe("managed Godot AI configuration", () => {
  it("preserves user plugins, autoloads and editor changes in the handoff", () => {
    const original =
      '[application]\nconfig/name="Original"\n[editor_plugins]\nenabled=PackedStringArray("res://addons/user/plugin.cfg")\n[autoload]\nGame="*res://game.gd"\n';
    const injected = addGodotMcpConfiguration(original);
    expect(addGodotMcpConfiguration(injected)).toBe(injected);
    const result = removeGodotMcpConfiguration(
      injected.replace('config/name="Original"', 'config/name="Edited"'),
      original,
    );
    expect(result).toBe(
      original.replace('config/name="Original"', 'config/name="Edited"'),
    );
  });
  it("does not remove an existing Godot AI configuration", () => {
    const original = addGodotMcpConfiguration(
      '[application]\nconfig/name="Game"\n',
    );
    expect(removeGodotMcpConfiguration(original, original)).toBe(original);
  });
  it("rejects a conflicting autoload without replacing its meaning", () => {
    expect(() =>
      addGodotMcpConfiguration(
        '[autoload]\n_mcp_game_helper="*res://user.gd"\n',
      ),
    ).toThrow("conflicting");
  });
});

it("removes temporary sections without leaving a configuration-only patch", () => {
  const original = '[application]\nconfig/name="Game"\n';
  expect(
    removeGodotMcpConfiguration(addGodotMcpConfiguration(original), original),
  ).toBe(original);
});
