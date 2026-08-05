import { PiHarnessError } from "../errors.js";
import { V03_AGENT_BUDGETS, type V03AgentBudgets } from "../v03-types.js";

export interface V03SessionGuardOptions {
  readonly semanticRevision: () => number;
  readonly terminalToolViolation: () => PiHarnessError | undefined;
  readonly requestAbort: () => void;
  readonly budgets?: V03AgentBudgets | undefined;
}

/** Owns one Agent Loop's first terminal cause and monotonic budget counters. */
export class V03SessionGuard {
  private readonly budgets: V03AgentBudgets;
  private terminal: Error | undefined;
  private calls = 0;
  private completed = 0;
  private errors = 0;
  private consecutiveNonProgress = 0;
  private lastSemanticRevision: number;

  public constructor(private readonly options: V03SessionGuardOptions) {
    this.budgets = options.budgets ?? V03_AGENT_BUDGETS;
    this.lastSemanticRevision = options.semanticRevision();
  }

  public get terminalError(): Error | undefined {
    return this.terminal;
  }

  public get toolCalls(): number {
    return this.calls;
  }

  public get toolErrors(): number {
    return this.errors;
  }

  public get completedToolCalls(): number {
    return this.completed;
  }

  public get consecutiveNonProgressToolResults(): number {
    return this.consecutiveNonProgress;
  }

  public fail(error: Error): void {
    if (this.terminal !== undefined) return;
    this.terminal = error;
    this.options.requestAbort();
  }

  public onToolExecutionStart(toolName: string): void {
    if (this.terminal !== undefined) return;
    this.calls += 1;
    if (this.calls > this.budgets.maxToolCalls) {
      this.fail(
        new PiHarnessError(
          "AGENT_BUDGET_EXHAUSTED",
          `Diagnostic tool-call budget exhausted before ${toolName}`,
          {
            details: {
              budget: "tool_calls",
              limit: this.budgets.maxToolCalls,
              observed: this.calls,
            },
          },
        ),
      );
    }
  }

  public onToolExecutionEnd(toolName: string, isError: boolean): void {
    if (this.terminal !== undefined) return;
    this.completed += 1;
    if (isError) {
      this.errors += 1;
      if (this.errors > this.budgets.maxToolErrors) {
        this.fail(
          this.options.terminalToolViolation() ??
            new PiHarnessError(
              "INVALID_TOOL_FLOW",
              `Diagnostic tool ${toolName} failed`,
              {
                details: {
                  budget: "tool_errors",
                  limit: this.budgets.maxToolErrors,
                  observed: this.errors,
                },
              },
            ),
        );
      }
      return;
    }

    const revision = this.options.semanticRevision();
    if (revision < this.lastSemanticRevision) {
      this.fail(
        new PiHarnessError(
          "AGENT_FAILED",
          "Diagnostic semantic progress regressed",
        ),
      );
      return;
    }
    if (revision > this.lastSemanticRevision) {
      this.lastSemanticRevision = revision;
      this.consecutiveNonProgress = 0;
      return;
    }

    this.consecutiveNonProgress += 1;
    if (
      this.consecutiveNonProgress >
      this.budgets.maxConsecutiveNonProgressToolResults
    ) {
      this.fail(
        new PiHarnessError(
          "AGENT_BUDGET_EXHAUSTED",
          `Diagnostic tool ${toolName} produced no semantic progress`,
          {
            details: {
              budget: "semantic_progress",
              limit: this.budgets.maxConsecutiveNonProgressToolResults,
              observed: this.consecutiveNonProgress,
            },
          },
        ),
      );
    }
  }
}
