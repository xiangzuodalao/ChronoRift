export interface ProjectEnvironmentToolCallAdmissionV1 {
  readonly limit: number;
  readonly admitted: number;
  readonly rejected: number;
  readonly attempted: number;
  readonly exhausted: boolean;
  tryAdmit(toolName: string): boolean;
}

export class ProjectEnvironmentToolCallBudgetExhaustedErrorV1 extends Error {
  public readonly code = "budget_exhausted" as const;
  public readonly limit: number;

  public constructor(limit: number) {
    super(
      `Project Environment turn tool-call budget exhausted after ${limit} admitted call(s)`,
    );
    this.name = "ProjectEnvironmentToolCallBudgetExhaustedErrorV1";
    this.limit = limit;
  }
}

/**
 * A synchronous, turn-scoped admission gate shared by every Pi tool family.
 * The check occurs inside ToolDefinition.execute and before any broker/runtime
 * port is called, so parallel scheduling cannot admit more than `limit` calls.
 */
export const createProjectEnvironmentToolCallAdmissionV1 = (
  limit: number,
): ProjectEnvironmentToolCallAdmissionV1 => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Project Environment tool-call limit must be positive");
  }
  let admitted = 0;
  let rejected = 0;
  return {
    limit,
    get admitted() {
      return admitted;
    },
    get rejected() {
      return rejected;
    },
    get attempted() {
      return admitted + rejected;
    },
    get exhausted() {
      return rejected > 0;
    },
    tryAdmit(toolName: string) {
      if (toolName.length === 0 || toolName.includes("\0")) {
        throw new TypeError("Project Environment tool name must be non-empty");
      }
      if (admitted >= limit) {
        rejected += 1;
        return false;
      }
      admitted += 1;
      return true;
    },
  };
};
