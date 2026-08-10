#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const fail = (message) => {
  process.stderr.write(`invalid E2 semantic evidence: ${message}\n`);
  process.exitCode = 1;
};

const path = process.argv[2];
if (path === undefined || process.argv.length !== 3) {
  fail("expected exactly one evidence path");
} else {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength < 2 || bytes.byteLength > 65_536) {
      throw new Error("evidence byte length is out of bounds");
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("evidence must be an object");
    }
    const keys = Object.keys(value).sort();
    const expectedKeys = [
      "adapterProfileSha256",
      "allExecutionsSealed",
      "claimsExcluded",
      "evidenceKind",
      "executionCount",
      "fidelity",
      "protocolProfile",
      "schemaVersion",
      "sourceCommit",
      "sourceSelectedTreeSha256",
      "taskClassification",
      "toolNames",
    ].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error("evidence contains a missing or unknown field");
    }
    const exact = {
      schemaVersion: 1,
      evidenceKind: "chronorift-e2-public-exposed-semantic-conformance",
      sourceCommit: "3e793f53598a131c53fb82555191cc14b8db07ff",
      sourceSelectedTreeSha256:
        "3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8",
      adapterProfileSha256:
        "2600ae0d42a463d78a7c74b987799e74e7391c254f806ddbcc86b2256591f0e4",
      protocolProfile: "chronorift-godot-semantic-v1",
      executionCount: 2,
      allExecutionsSealed: true,
      fidelity: "descriptive_only",
      taskClassification: "public_exposed_plumbing_conformance",
    };
    for (const [key, expected] of Object.entries(exact)) {
      if (value[key] !== expected) throw new Error(`${key} is not frozen`);
    }
    const expectedTools = [
      "game_capabilities",
      "game_launch",
      "game_status",
      "game_stop",
      "game_query",
      "game_checkpoint_create",
      "game_checkpoint_restore",
      "game_fork",
      "game_trace_create",
      "game_trace_replay",
      "game_compare",
    ];
    if (JSON.stringify(value.toolNames) !== JSON.stringify(expectedTools)) {
      throw new Error("toolNames is not the exact E2 catalog");
    }
    const exclusions = [
      "intelligent_diagnosis",
      "independent_acceptance",
      "equivalent_checkpoint_restore",
      "causality",
      "generalization",
    ];
    if (JSON.stringify(value.claimsExcluded) !== JSON.stringify(exclusions)) {
      throw new Error("claimsExcluded is not the frozen boundary");
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
