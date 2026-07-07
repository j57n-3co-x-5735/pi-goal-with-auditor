import { Type, type Static } from "typebox";

export const GoalStateSchema = Type.Union([
  Type.Object({ phase: Type.Literal("idle") }),
  Type.Object({
    phase: Type.Literal("ready"),
    objective: Type.String(),
    toolsUsed: Type.Optional(Type.Number()),
    startedAt: Type.Optional(Type.Number()),
    // Consecutive update_goal rejections with no intervening tool call -- reset by
    // registerToolCall(), capped by extension.ts to bound unbounded auditor-rejection retries.
    auditRejections: Type.Optional(Type.Number()),
    // Consecutive agent cycles that ended with no tool call -- reset by registerToolCall(),
    // capped by extension.ts. Distinguishes a weak model deliberating (a text-only turn, which
    // should be nudged and continued) from a genuinely stalled agent (many empty cycles in a
    // row, which should pause). See GoalStateMachine.nextLoopStep().
    emptyContinuations: Type.Optional(Type.Number()),
    // How many of the current empty-continuation streak ended because the model *errored*
    // (stopReason "error" -- e.g. a context-window overflow) rather than deliberated. Lets the
    // stall pause diagnose a model/config problem instead of blaming a work stall.
    erroredContinuations: Type.Optional(Type.Number()),
  }),
  Type.Object({ phase: Type.Literal("paused"), objective: Type.String() }),
]);
export type GoalState = Static<typeof GoalStateSchema>;
