import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { GoalStateMachine } from "./goal_state_machine";
import { CUSTOM_TYPE, goalForSession } from "./goal_finder";
import { runGoalCompletionAuditor } from "./goal_auditor";
import { loadGoalAuditorSettings, goalAuditorConfigWarning } from "./goal_config";

const GOAL_TOOLS = ["get_goal", "update_goal"];

/**
 * True when the just-finished agent run ended on a model *error* (a final assistant message with
 * `stopReason: "error"` -- e.g. a context-window overflow), as opposed to deliberating or being
 * aborted. `"aborted"` (user cancel) is deliberately excluded -- that path is handled by the
 * `turn_end` abort logic. Reads the `agent_end` event's messages defensively (shape is an SDK
 * contract, but a bad/missing message must never throw here).
 */
function lastTurnErrored(event: unknown): boolean {
  const messages = (event as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string };
    if (m && m.role === "assistant") return m.stopReason === "error";
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("goal", {
    description: "Give the agent a goal.",
    async handler(args, ctx) {
      let prompt: string | undefined;
      const gm = new GoalStateMachine(goalForSession(ctx.sessionManager));
      if (args.trim().length === 0) {
        ctx.ui.notify(JSON.stringify(gm.state));
        return;
      } else if (args.trim().toLowerCase() === "pause") {
        gm.pause();
      } else if (args.trim().toLowerCase() === "resume") {
        prompt = gm.resume();
      } else if (args.trim().toLowerCase() === "clear") {
        gm.clear();
        ctx.ui.notify("Goal cleared.");
      } else {
        prompt = await gm.start(
          args,
          ctx.hasUI
            ? () => ctx.ui.confirm("A goal is already active.", "Do you want to override it?")
            : () => false,
        );
      }
      if (prompt !== undefined) sendGoalMessage(pi, ctx, prompt, gm);
      else {
        pi.appendEntry(CUSTOM_TYPE, gm.state);
        syncPiState(pi, ctx, gm);
      }
    },
  });

  pi.on("session_start", async (_, ctx) => {
    const gm = new GoalStateMachine(goalForSession(ctx.sessionManager));
    syncPiState(pi, ctx, gm);
    // Surface a malformed/unreadable goal-auditor.json once, so settings silently not applying
    // isn't a mystery. An absent file is the normal case and produces no warning.
    const configWarning = goalAuditorConfigWarning();
    if (configWarning && ctx.hasUI) ctx.ui.notify(`goal-auditor config: ${configWarning}`, "warning");
  });

  pi.on("tool_call", async (_, ctx) => {
    const gm = new GoalStateMachine(goalForSession(ctx.sessionManager));
    if (gm.registerToolCall()) {
      pi.appendEntry(CUSTOM_TYPE, gm.state);
      syncPiState(pi, ctx, gm);
    }
  });

  // Docs specify `ctx.signal.aborted` is set only in turn-related events, not in session-related
  // events, so we check here.
  pi.on("turn_end", async (_, ctx) => {
    if (ctx.signal?.aborted) {
      const gm = new GoalStateMachine(goalForSession(ctx.sessionManager));
      if (gm.state.phase !== "ready") return;
      ctx.ui.notify("Agent ended due to abort signal; not sending continuation prompt.", "warning");
      gm.pause();
      pi.appendEntry(CUSTOM_TYPE, gm.state);
      syncPiState(pi, ctx, gm);
      return;
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const gm = new GoalStateMachine(goalForSession(ctx.sessionManager));
    const max = loadGoalAuditorSettings().maxEmptyContinuations;
    const step = gm.nextLoopStep(max, lastTurnErrored(event));
    if (step.kind === "idle") return;
    if (step.kind === "stall") {
      // Word the pause for the actual cause. `reason === "errors"` means the empty streak was
      // driven by model errors (e.g. a context-window overflow: "n_keep >= n_ctx") -- a
      // model/config problem, not the agent choosing to stall or awaiting input.
      const pauseMessage =
        step.reason === "errors"
          ? `Goal paused: ${max} iterations produced no tool calls because the model errored (see the errors above -- often a context-window overflow like "n_keep >= n_ctx"). This usually means the model's context window is too small or the model is misconfigured, not that the work stalled. Fix the model/context (increase its context length, or switch to a larger-context model), then resume with /goal resume.`
          : `Goal paused: ${max} consecutive iterations made no tool calls. The agent appears stalled or is waiting for input. Resume with /goal resume.`;
      ctx.ui.notify(pauseMessage, "warning");
      gm.pause();
      pi.appendEntry(CUSTOM_TYPE, gm.state);
      syncPiState(pi, ctx, gm);
      return;
    }
    // step.kind === "continue": keep the loop going. On an empty (nudged) cycle this re-prompts
    // the model to actually act instead of pausing; nextLoopStep has already updated the
    // empty-cycle streak, and sendGoalMessage persists it via the continuation message details.
    sendGoalMessage(pi, ctx, step.prompt, gm);
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Current Goal",
    description:
      "Get the current active goal objective and status. Returns 'No active goal.' if none is set.",
    parameters: Type.Object({}),
    // Forces any tool-call batch containing this tool to run sequentially, so it can never
    // observe stale state from a same-batch update_goal call that hasn't landed yet.
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const gm = new GoalStateMachine(goalForSession(ctx.sessionManager));
      if (gm.state.phase === "idle") {
        return { content: [{ type: "text", text: "No active goal." }], details: {} };
      }
      return {
        content: [
          {
            type: "text",
            text: `Objective: ${gm.state.objective}\nStatus: ${gm.state.phase}`,
          },
        ],
        details: { objective: gm.state.objective, phase: gm.state.phase },
      };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal Status",
    description:
      'Mark the current goal complete. An independent auditor will verify the objective is satisfied. Provide a completionSummary with concrete evidence of completion — the auditor uses it to evaluate your claim. Do not mark a goal complete merely because you are stopping work or the budget is running out — only mark it complete when the objective has actually been achieved and no required work remains.',
    parameters: Type.Object({
      status: Type.Literal("complete"),
      completionSummary: Type.Optional(
        Type.String({ description: "Concrete evidence summary proving the objective is satisfied. The independent auditor evaluates this claim against the actual workspace state." }),
      ),
    }),
    // Prevents a duplicated/hedged update_goal call from the executor LLM in the same turn
    // from racing another update_goal (or get_goal) call under the host's default parallel
    // tool-call dispatch — see docs/architecture.md's "Concurrent tool-call dispatch" note.
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const gm = new GoalStateMachine(goalForSession(ctx.sessionManager));
      if (gm.state.phase !== "ready") {
        throw new Error("Cannot complete goal while not ready");
      }

      const { objective, startedAt } = gm.state;
      const auditor = await runGoalCompletionAuditor({
        ctx,
        objective,
        completionSummary: params.completionSummary,
        signal: signal,
      });

      // Surface which model actually rendered the verdict. The evidence-backed-approval guard
      // removes the "approved having inspected nothing" fail-open, but a weak model that inspects
      // then misjudges can still approve -- and the only thing that catches that is a human seeing
      // it was, say, a 1.2B local model. Making the auditor model visible turns a silent weak-gate
      // into a legible one.
      const auditorModelSuffix = auditor.model ? ` (${auditor.model})` : "";

      if (!auditor.approved) {
        const rejectionText = [
          `Goal completion rejected by auditor${auditorModelSuffix}.`,
          auditor.error ? `Error: ${auditor.error}` : null,
          auditor.output || "No approval marker found.",
        ].filter(Boolean).join("\n\n");

        // Persist the streak regardless of whether the cap trips, so it survives across
        // separate update_goal calls -- state is reconstructed fresh from session entries
        // each time (goalForSession), not held in memory between tool invocations.
        const rejectionCount = gm.recordAuditRejection();
        if (rejectionCount >= loadGoalAuditorSettings().maxConsecutiveAuditRejections) {
          gm.pause();
          pi.appendEntry(CUSTOM_TYPE, gm.state);
          syncPiState(pi, ctx, gm);
          // A rejection can mean either "the work isn't done" (a substantive
          // disapproval) or "the auditor itself is broken" -- e.g. a too-weak/misconfigured
          // auditor model hollow-approving and getting voided by the evidence guard (its error
          // says "approved without running any successful tool"). The executor's correct next
          // move differs (do more work vs. fix the auditor config), so name both possibilities
          // and point at the auditor model (already in rejectionText via the auditor label).
          return {
            content: [{
              type: "text",
              text: [
                rejectionText,
                "",
                `Goal paused: ${rejectionCount} consecutive auditor rejections with no other tool call in between. Either the work genuinely isn't done -- inspect the objections above, make a real change, then resume with /goal resume -- or the auditor itself may be the problem (a too-weak or misconfigured auditor model; see the model named above and PI_GOAL_AUDITOR_MODEL), in which case fix the auditor config before resuming.`,
              ].join("\n"),
            }],
            details: {},
          };
        }

        pi.appendEntry(CUSTOM_TYPE, gm.state);
        return {
          content: [{ type: "text", text: rejectionText }],
          details: {},
        };
      }

      // Re-read state after the auditor resolves — the user may have paused or cleared the
      // goal (or cleared it and started a DIFFERENT goal) while the audit was in flight.
      // Checking phase alone isn't enough: if a new goal was started during the
      // audit, phase is "ready" again but for a different objective -- completing it now would
      // apply an approval computed for the stale objective to a goal that was never audited.
      const freshGm = new GoalStateMachine(goalForSession(ctx.sessionManager));
      const isStillTheSameGoal =
        freshGm.state.phase === "ready" &&
        freshGm.state.objective === objective &&
        freshGm.state.startedAt === startedAt;
      if (!isStillTheSameGoal) {
        return {
          content: [{ type: "text", text: "Goal state changed during audit (no longer the same goal). Auditor approved, but completion was not applied." }],
          details: {},
        };
      }

      freshGm.complete();
      pi.appendEntry(CUSTOM_TYPE, freshGm.state);
      syncPiState(pi, ctx, freshGm);
      return {
        content: [{ type: "text", text: `Goal complete.\n\nAuditor${auditorModelSuffix}: ${auditor.output}` }],
        details: {},
      };
    },
  });
}

/** Sync the active state of goal tools based on the current goal state, and update the UI widget. */
function syncPiState(pi: ExtensionAPI, ctx: ExtensionContext, gm: GoalStateMachine) {
  const activeTools = pi.getActiveTools();
  if (gm.state.phase === "ready") {
    const missing = GOAL_TOOLS.filter((name) => !activeTools.includes(name));
    if (missing.length > 0) pi.setActiveTools([...activeTools, ...missing]);
  } else {
    const toRemove = activeTools.filter((name) => GOAL_TOOLS.includes(name));
    if (toRemove.length > 0) pi.setActiveTools(activeTools.filter((name) => !GOAL_TOOLS.includes(name)));
  }
  if (ctx.hasUI)
    ctx.ui.setWidget(CUSTOM_TYPE, gm.state.phase === "idle" ? undefined : gm.status(ctx.ui.theme));
}

/**
 * Send a message with the given prompt and the current goal state as details.
 * If there are pending messages or the context is not idle, we pause the goal manager and send the message as an entry instead.
 */
//  This also calls syncPiState.
function sendGoalMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
  gm: GoalStateMachine,
) {
  gm.resetToolCalls();
  syncPiState(pi, ctx, gm);

  // HACK: Use setTimeout to ensure this runs after the current turn's processing is fully complete,
  // allowing the message to be properly associated with the next turn.
  // Not documented behavior, but what works works. ¯\_(ツ)_/¯
  setTimeout(() => {
    if (ctx.hasPendingMessages() || !ctx.isIdle()) {
      gm.pause();
      syncPiState(pi, ctx, gm);
      pi.appendEntry(CUSTOM_TYPE, gm.state);
    } else {
      pi.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content: prompt,
          display: true,
          details: gm.state,
        },
        {
          triggerTurn: true,
        },
      );
    }
  }, 0);
}
