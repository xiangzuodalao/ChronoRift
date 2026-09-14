import { describe, expect, it } from "vitest";
import { isExternalGodotNativeSourcePathV1 } from "./external-godot-source-policy.js";
import {
  isProjectEnvironmentNativeSourcePathV1,
  projectEnvironmentCSharpRequirementV1,
} from "./project-environment-source-policy.js";

const requirement = (path: string, text: string) =>
  projectEnvironmentCSharpRequirementV1(path, Buffer.from(text));

describe("optional C# source in GDScript Project Environment", () => {
  it("admits inert C# bytes only for PE and retains native/build-manifest exclusions", () => {
    for (const path of ["Optional.cs", "addons/vendor/Optional.CS"]) {
      expect(isProjectEnvironmentNativeSourcePathV1(path)).toBe(false);
      expect(isExternalGodotNativeSourcePathV1(path)).toBe(true);
    }
    for (const suffix of [
      ".csproj",
      ".sln",
      ".dll",
      ".so",
      ".dylib",
      ".gdextension",
      ".gdnlib",
    ]) {
      expect(isProjectEnvironmentNativeSourcePathV1("module" + suffix)).toBe(
        true,
      );
      expect(
        isProjectEnvironmentNativeSourcePathV1("module" + suffix.toUpperCase()),
      ).toBe(true);
    }
  });

  it("does not mistake assembly metadata or guarded dynamic loading for a required C# runtime", () => {
    expect(
      requirement(
        "project.godot",
        '[application]\nconfig/features=PackedStringArray("4.2")\n[dotnet]\nproject/assembly_name="Game"\n',
      ),
    ).toBeUndefined();
    expect(
      requirement(
        "addons/vendor/loader.gd",
        `extends RefCounted
static func optional_api():
  if not ClassDB.class_exists("CSharpScript"):
    return null
  return load("res://addons/vendor/Optional.cs").new()
`,
      ),
    ).toBeUndefined();
    expect(
      requirement("addons/vendor/Optional.cs", "// optional C# source\n"),
    ).toBeUndefined();
  });

  it.each([
    [
      "project.godot",
      '[application]\n"config/features"=PackedStringArray("4.2", "C#")',
    ],
    [
      "project.godot",
      '[application]\n"config/fea\\u0074ures"=PackedStringArray("C#")',
    ],
    ["override.cfg", '[autoload]\n"Game.linux"="*res://Game.cs"'],
    [
      "project.godot",
      '[application]\nconfig/features=PackedStringArray("4.2", "C#")',
    ],
    [
      "project.godot",
      '[application]\nconfig/features=PackedStringArray(\n "4.2",\n "C#"\n)',
    ],
    ["override.cfg", '[application]\nconfig/features=PackedStringArray("C#")'],
    ["project.godot", '[autoload]\nGame="*res://Game.cs"'],
    ["project.godot", '[application]\nrun/main_scene="res://Game.cs"'],
    ["addons/local/plugin.cfg", '[plugin]\nscript="Plugin.cs"'],
    ["main.tscn", '[ext_resource type="Script" path="res://Game.CS" id="1"]'],
    ["data.tres", '[ext_resource path="res://Data.cs" type="Script" id="1"]'],
    ["data.tres", '[gd_resource type="CSharpScript" format=3]'],
    ["main.gd", 'extends "res://Base.cs"'],
    ["main.gd", 'const API = preload("res://Api.cs")'],
    ["main.gd", 'const API = preload(\n "res://Api.cs"\n)'],
    ["main.gd", 'const API = preload("res://Api.\\u0063s")'],
  ])("rejects an explicit .NET declaration in %s", (path, text) => {
    expect(requirement(path, text)).toMatch(/explicit C#\/\.NET/u);
  });

  it("ignores comments and quoted documentation without hiding live declarations", () => {
    expect(
      requirement(
        "main.gd",
        `# const API = preload("res://Api.cs")
var example = 'preload("res://Api.cs")'
var multiline_example = """extends 'res://Base.cs'"""
`,
      ),
    ).toBeUndefined();
    expect(
      requirement(
        "project.godot",
        '; config/features=PackedStringArray("C#")\n[application]\nconfig/name="C# tutorial"',
      ),
    ).toBeUndefined();
    expect(
      requirement(
        "main.gd",
        'var note = "# documentation"; const API = preload("Api.cs")',
      ),
    ).toMatch(/explicit C#\/\.NET/u);
    expect(
      requirement(
        "main.tscn",
        '[node name="Example" type="Node"]\ntext="See optional.cs"',
      ),
    ).toBeUndefined();
  });

  it("rejects invalid text in files whose script declarations need inspection", () => {
    expect(
      projectEnvironmentCSharpRequirementV1("main.tscn", new Uint8Array([255])),
    ).toMatch(/UTF-8/u);
  });
});
