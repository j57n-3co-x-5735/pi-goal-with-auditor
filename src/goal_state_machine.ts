import type { Theme } from "@earendil-works/pi-coding-agent";

import { continuationPrompt } from "./prompts";
import goal_widget from "./goal_widget";
import { GoalState } from "./goal_state";

/** The decision made at `agent_end` about how the goal loop should proceed. */
export type LoopStep =
  | { kind: "continue"; prompt: string }
  // `reason` lets the caller word the pause accurately: "errors" when the empty streak included
  // model errors (context overflow, etc.) -- a model/config problem, not a genuine work stall.
  | { kind: "stall"; reason: "no-progress" | "errors" }
  | { kind: "idle" };

export class GoalStateMachine {
  constructor(public state: GoalState) {}

  /** Get the current status of the goal manager, fit for widget display. */
  status(theme: Theme): string[] | undefined {
    if (this.state.phase === "idle") return undefined;
    return goal_widget(theme, this.state);
  }

  /** Start a new goal with the given objective. The manager must be idle; if this does not throw,
   * the returned string should be sent as a message to the agent. If the manager is paused, the
   * confirmIfPaused callback will be called, and the goal will only be started if it returns true.
   */
  async start(
    objective: string,
    confirmIfPaused: () => Promise<boolean> | boolean,
  ): Promise<string> {
    if (this.state.phase !== "idle") {
      if (this.state.phase === "paused" && (await confirmIfPaused())) {
      } else {
        throw new Error("Cannot set objective while not idle");
      }
    }
    this.state = { phase: "ready", objective, startedAt: Date.now() };
    return continuationPrompt(objective);
  }

  resume(): string {
    if (this.state.phase !== "paused") throw new Error("Cannot resume goal while not paused");
    this.state = { phase: "ready", objective: this.state.objective, startedAt: Date.now() };
    return continuationPrompt(this.state.objective);
  }

  /**
   * Decide how the goal loop proceeds at the end of an agent cycle (`agent_end`).
   *
   * If the just-finished cycle used any tool, that's progress: reset the empty-cycle streak
   * and continue normally. If it used no tool, that alone is NOT treated as a stall -- a weak
   * model routinely emits a text-only turn (a clarifying question, a plan, reasoning) that
   * would advance if simply told to act. So the loop continues with a nudge instead of dying,
   * up to `maxEmptyContinuations` consecutive empty cycles; only then does it pause for safety,
   * which is the genuine-stall case (e.g. tool-calling broke, or the model truly can't proceed).
   *
   * `maxEmptyContinuations` must be >= 1. At 1, the loop pauses on the very first empty cycle
   * (the original behavior before this was made tolerant of weak-model deliberation).
   *
   * `lastTurnErrored` is true when the just-finished cycle produced no tool call because the
   * model *errored* (stopReason "error" -- e.g. a context-window overflow), not because it
   * deliberated. An errored cycle is continued with a *plain* prompt, never the "you made no
   * tool calls, act instead of describing" nudge: that advice is wrong (the model produced
   * nothing to act-vs-describe) and it only makes an already-overflowing prompt larger. Errored
   * cycles are also tracked so the stall pause can name a model/config problem rather than
   * misreport a work stall.
   *
   * Mutates the empty-cycle streak; the caller is responsible for persisting the state.
   */
  nextLoopStep(maxEmptyContinuations: number, lastTurnErrored = false): LoopStep {
    if (this.state.phase !== "ready") return { kind: "idle" };
    if (this.state.toolsUsed) {
      this.state.emptyContinuations = 0;
      this.state.erroredContinuations = 0;
      return { kind: "continue", prompt: continuationPrompt(this.state.objective) };
    }
    const streak = (this.state.emptyContinuations ?? 0) + 1;
    this.state.emptyContinuations = streak;
    const erroredStreak = (this.state.erroredContinuations ?? 0) + (lastTurnErrored ? 1 : 0);
    this.state.erroredContinuations = erroredStreak;
    if (streak >= maxEmptyContinuations) {
      // If any cycle in the streak errored, the pause is about the model/config, not a work stall.
      return { kind: "stall", reason: erroredStreak > 0 ? "errors" : "no-progress" };
    }
    // Don't nudge an errored cycle (see doc comment) -- just re-send the plain continuation.
    return {
      kind: "continue",
      prompt: continuationPrompt(this.state.objective, lastTurnErrored ? undefined : { nudge: true }),
    };
  }

  /** Abort the current goal, if any, and pause it. Returns true if a goal was paused, false if
   * there was no goal to pause. */
  abort(): boolean {
    if (this.state.phase !== "ready") return false;
    this.pause();
    return true;
  }

  pause() {
    if (this.state.phase !== "ready") throw new Error("Cannot pause goal while not ready");
    this.state = { phase: "paused", objective: this.state.objective };
  }

  complete() {
    if (this.state.phase !== "ready") throw new Error("Cannot complete goal while not ready");
    this.clear();
  }

  clear() {
    this.state = { phase: "idle" };
  }

  resetToolCalls() {
    if (this.state.phase !== "ready") return;
    this.state.toolsUsed = 0;
  }

  registerToolCall(): boolean {
    if (this.state.phase !== "ready") return false;
    this.state.toolsUsed = (this.state.toolsUsed ?? 0) + 1;
    // A real tool call means the agent did new work this cycle. That resets the streaks: the
    // auditor-rejection streak (the retry-loop guard) and the empty-cycle streak plus its
    // errored-cycle subcount (the stall guard in nextLoopStep) -- none of those failure modes is
    // in play once a tool actually ran.
    this.state.auditRejections = 0;
    this.state.emptyContinuations = 0;
    this.state.erroredContinuations = 0;
    return true;
  }

  /** Record an auditor rejection and return the new consecutive-rejection count (0 if not
   * ready). Only counts rejections with no intervening tool call -- see registerToolCall(). */
  recordAuditRejection(): number {
    if (this.state.phase !== "ready") return 0;
    this.state.auditRejections = (this.state.auditRejections ?? 0) + 1;
    return this.state.auditRejections;
  }
}
