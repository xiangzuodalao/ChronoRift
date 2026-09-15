import { describe, expect, it } from "vitest";
import {
  assertInspectionSettingsSafe,
  godotSettingString,
  mergeGodotSettingsOverride,
  readGodotTextSettings,
} from "./godot-settings-overlay.js";

const bytes = (text: string) => Buffer.from(text, "utf8");

describe("Godot settings overlay boundary", () => {
  it("keeps multiline input-event variants opaque and decodes assignment names without evaluating objects", () => {
    const source = `; upstream comment\nconfig_version=5\n[input]\nui_accept={\n"deadzone": 0.5,\n"events": [Object(InputEventKey,"keycode":32), Object(InputEventJoypadButton,"button_index":0)]\n}\n[application]\n"config/na\\u006de"="A; [autoload]\\nvalue"\nconfig/disable_project_settings_override=false\n[custom]\nnames=PackedStringArray("one", "two")\n`;
    const settings = readGodotTextSettings(bytes(source));
    expect(settings.map((setting) => setting.name)).toEqual([
      "config_version",
      "input/ui_accept",
      "application/config/name",
      "application/config/disable_project_settings_override",
      "custom/names",
    ]);
    expect(settings[1]?.value).toContain('Object(InputEventKey,"keycode":32)');
    expect(godotSettingString(settings[2]!.value)).toBe("A; [autoload]\nvalue");
    expect(godotSettingString('""')).toBe("");
    expect(godotSettingString('"res://\\u006dain.tscn"')).toBe(
      "res://main.tscn",
    );
    expect(() => assertInspectionSettingsSafe(settings)).not.toThrow();
  });

  it("preserves upstream bytes and appends managed settings after every known feature variant", () => {
    const original = bytes(
      '[custom]\nvalue=3\n[editor_plugins]\nenabled=PackedStringArray("res://plugin.cfg")\nenabled.linux=PackedStringArray("res://other.cfg")\n',
    );
    const managed = bytes("[editor_plugins]\nenabled=PackedStringArray()\n");
    const merged = mergeGodotSettingsOverride(
      original,
      managed,
      readGodotTextSettings(
        bytes(
          '[editor_plugins]\nenabled.debug=PackedStringArray("res://debug.cfg")\n',
        ),
      ),
    );
    expect(Buffer.from(merged).subarray(0, original.length)).toEqual(original);
    const effective = new Map(
      readGodotTextSettings(merged).map((setting) => [
        setting.name,
        setting.value,
      ]),
    );
    expect(effective.get("custom/value")).toBe("3");
    for (const key of ["enabled", "enabled.linux", "enabled.debug"])
      expect(effective.get("editor_plugins/" + key)).toBe(
        "PackedStringArray()",
      );
    expect(mergeGodotSettingsOverride(undefined, managed)).toEqual(managed);
  });

  it.each([
    '[autoload]\nChronoRiftInspection="*res://spoof.gd"\n',
    '[autoload]\n"Chrono\\u0052iftInspection.linux"="*res://spoof.gd"\n',
    '"autoload/ChronoRiftInspection"="*res://spoof.gd"\n',
    '[autoload_prepend]\nChronoRiftInspection="*res://spoof.gd"\n',
    '[application]\nconfig/project_settings_override="res://late.cfg"\n',
    '[application/config]\nproject_settings_override.linux="res://late.cfg"\n',
    '[application]\nc o n f i g / p r o j e c t _ s e t t i n g s _ o v e r r i d e="res://late.cfg"\n',
    "[application]\nconfig/disable_project_settings_override=true\n",
    "[application]\nconfig/disable_project_settings_override.debug=true\n",
  ])("rejects settings that can bypass the managed autoload: %s", (source) => {
    expect(() =>
      assertInspectionSettingsSafe(readGodotTextSettings(bytes(source))),
    ).toThrow();
  });

  it.each([
    '[input]\na={"events": [Object(InputEventKey, "keycode": 32)]',
    '[application]\nconfig/name="unterminated',
    "[application\\]",
    '[application]\nconfig/name="bad\\u00QQ"',
    '[application]\nconfig/name="nul\0"',
    '[application]\n"config/project_settings_override\\u0000suffix"="res://late.cfg"',
    "[input]\na=[}",
  ])("refuses malformed source before appending Host text: %s", (source) => {
    expect(() =>
      mergeGodotSettingsOverride(
        bytes(source),
        bytes('[autoload]\nChronoRiftInspection="*res://observer.gd"\n'),
      ),
    ).toThrow();
  });
});
