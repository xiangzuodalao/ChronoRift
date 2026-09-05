import { describe, expect, it } from "vitest";
import { ProjectEnvironmentPreviewResultV2Schema } from "./project-environment-preview.js";

const result = (thinkingLevel: unknown) => ({
  schemaVersion: 2,
  status: "completed",
  taskId: "dc2f794d-ea59-46a4-8fbe-ed1380c6e015",
  sessionId: "08c71d8c-5d37-4dfc-8141-b8a6bd86c690",
  sessionFile: "/task/session.jsonl",
  projectRoot: "game",
  sourceSha256: "a".repeat(64),
  candidateSourceChanged: false,
  candidatePatch: null,
  executions: [],
  goalDelivered: true,
  failureCode: null,
  failureMessage: null,
  taskDirectory: "/task",
  workspaceDirectory: "/task/workspace",
  provider: "provider",
  model: "model",
  thinkingLevel,
  limitations: [],
});

describe("inspection Preview result V2", () => {
  it("accepts max thinking without changing the result schema version", () => {
    expect(
      ProjectEnvironmentPreviewResultV2Schema.parse(result("max")),
    ).toEqual(result("max"));
  });

  it.each(["ultra", "unknown", "", null, 7])(
    "rejects unsupported thinking level %j",
    (thinkingLevel) => {
      expect(
        ProjectEnvironmentPreviewResultV2Schema.safeParse(result(thinkingLevel))
          .success,
      ).toBe(false);
    },
  );
});
