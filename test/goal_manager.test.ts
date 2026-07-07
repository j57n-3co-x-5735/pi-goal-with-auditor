import { describe, it, expect, beforeEach } from "vitest";
import { GoalStateMachine } from "../src/goal_state_machine";
import { goalForSession, CUSTOM_TYPE } from "../src/goal_finder";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function makeEntry(
  overrides: Partial<SessionEntry> & { type: string; customType?: string; data?: unknown; details?: unknown },
): SessionEntry {
  const base = {
    id: crypto.randomUUID?.() ?? Math.random().toString(36),
    parentId: null,
    timestamp: new Date().toISOString(),
  };
  return { ...base, ...overrides } as unknown as SessionEntry;
}

function sessionManagerWith(entries: SessionEntry[]) {
  return { getEntries: () => entries };
}

// ---------------------------------------------------------------------------
// goalForSession (replaces GoalManager constructor)
// ---------------------------------------------------------------------------
describe("goalForSession", () => {
  it("defaults to idle when no entries exist", () => {
    const state = goalForSession(sessionManagerWith([]));
    expect(state).toEqual({ phase: "idle" });
  });

  it("defaults to idle when entries exist but none are goal entries", () => {
    const entries = [makeEntry({ type: "message" }), makeEntry({ type: "compaction" })];
    const state = goalForSession(sessionManagerWith(entries));
    expect(state).toEqual({ phase: "idle" });
  });

  it("reads ready state from the last matching custom entry", () => {
    const entries = [
      makeEntry({ type: "message" }),
      makeEntry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "ship it" } }),
    ];
    const state = goalForSession(sessionManagerWith(entries));
    expect(state).toEqual({ phase: "ready", objective: "ship it" });
  });

  it("reads paused state from the last matching custom entry", () => {
    const entries = [
      makeEntry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "paused", objective: "do thing" } }),
    ];
    const state = goalForSession(sessionManagerWith(entries));
    expect(state).toEqual({ phase: "paused", objective: "do thing" });
  });

  it("reads state from a custom_message entry (using details)", () => {
    const entries = [
      makeEntry({
        type: "custom_message",
        customType: CUSTOM_TYPE,
        details: { phase: "ready", objective: "via details" },
      }),
    ];
    const state = goalForSession(sessionManagerWith(entries));
    expect(state).toEqual({ phase: "ready", objective: "via details" });
  });

  it("picks the most recent matching entry (entries are reversed internally)", () => {
    const entries = [
      makeEntry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "idle" } }),
      makeEntry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "later" } }),
    ];
    const state = goalForSession(sessionManagerWith(entries));
    expect(state).toEqual({ phase: "ready", objective: "later" });
  });
});


// ---------------------------------------------------------------------------
// GoalStateMachine.start()
// ---------------------------------------------------------------------------
describe("GoalStateMachine.start", () => {
  let gm: GoalStateMachine;

  beforeEach(() => {
    gm = new GoalStateMachine({ phase: "idle" });
  });

  it("throws when not idle", async () => {
    gm.state = { phase: "ready", objective: "already running" };
    await expect(gm.start("new goal", () => false)).rejects.toThrow("Cannot set objective while not idle");
  });

  it("sets state to ready and returns a continuation prompt", async () => {
    const prompt = await gm.start("implement feature X", () => false);
    expect(gm.state.phase).toBe("ready");
    expect((gm.state as any).objective).toBe("implement feature X");
    expect(prompt).toBeDefined();
    expect(prompt).toContain("implement feature X");
  });
});

// ---------------------------------------------------------------------------
// resume()
// ---------------------------------------------------------------------------
describe("GoalStateMachine.resume", () => {
  it("throws when not paused", () => {
    const gm = new GoalStateMachine({ phase: "idle" });
    expect(() => gm.resume()).toThrow("Cannot resume goal while not paused");
  });

  it("transitions from paused to ready and returns the continuation prompt", () => {
    const gm = new GoalStateMachine({ phase: "paused", objective: "paused goal" });
    const prompt = gm.resume();
    expect(gm.state.phase).toBe("ready");
    expect((gm.state as any).objective).toBe("paused goal");
    expect(prompt).toContain("paused goal");
  });
});

// ---------------------------------------------------------------------------
// nextLoopStep()
// ---------------------------------------------------------------------------
describe("GoalStateMachine.nextLoopStep", () => {
  it("returns idle when not ready", () => {
    const gm = new GoalStateMachine({ phase: "idle" });
    expect(gm.nextLoopStep(3)).toEqual({ kind: "idle" });
    gm.state = { phase: "paused", objective: "paused" };
    expect(gm.nextLoopStep(3)).toEqual({ kind: "idle" });
  });

  it("continues (no nudge) when the cycle used tools, and resets the empty streak", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "ongoing work", toolsUsed: 1, emptyContinuations: 2 });
    const step = gm.nextLoopStep(3);
    expect(step.kind).toBe("continue");
    if (step.kind !== "continue") throw new Error("expected continue");
    expect(step.prompt).toContain("ongoing work");
    expect(step.prompt).not.toContain("made no tool calls");
    expect((gm.state as any).emptyContinuations).toBe(0);
  });

  // The core weak-model fix: a single text-only cycle must NOT pause the loop -- it nudges and
  // continues, incrementing the empty-cycle streak.
  it("continues with a nudge (not a pause) on the first empty cycle", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "audit the repo" });
    const step = gm.nextLoopStep(3);
    expect(step.kind).toBe("continue");
    if (step.kind !== "continue") throw new Error("expected continue");
    expect(step.prompt).toContain("made no tool calls");
    expect(step.prompt).toContain("audit the repo");
    expect((gm.state as any).emptyContinuations).toBe(1);
  });

  it("accumulates the empty streak across consecutive empty cycles and stalls at the bound", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work", emptyContinuations: 2 });
    // Third consecutive empty cycle with a bound of 3 -> stall (deliberation, not errors).
    expect(gm.nextLoopStep(3)).toEqual({ kind: "stall", reason: "no-progress" });
    expect((gm.state as any).emptyContinuations).toBe(3);
  });

  it("pauses on the first empty cycle when the bound is 1 (original behavior)", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work" });
    expect(gm.nextLoopStep(1)).toEqual({ kind: "stall", reason: "no-progress" });
  });

  // Errored cycle (model stopReason "error", e.g. context overflow): continue with a PLAIN
  // prompt, not the "you made no tool calls, act instead of describing" nudge -- that advice is
  // wrong and only enlarges an already-overflowing prompt.
  it("continues an errored empty cycle with a plain prompt (no nudge)", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work" });
    const step = gm.nextLoopStep(3, true);
    expect(step.kind).toBe("continue");
    if (step.kind !== "continue") throw new Error("expected continue");
    expect(step.prompt).not.toContain("made no tool calls");
    expect((gm.state as any).emptyContinuations).toBe(1);
    expect((gm.state as any).erroredContinuations).toBe(1);
  });

  it("stalls with reason 'errors' when the empty streak was driven by model errors", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work", emptyContinuations: 2, erroredContinuations: 2 });
    expect(gm.nextLoopStep(3, true)).toEqual({ kind: "stall", reason: "errors" });
  });

  it("stalls with reason 'errors' when only some of the streak errored", () => {
    // 2 prior deliberation cycles, this 3rd one errored -> at least one error -> "errors".
    const gm = new GoalStateMachine({ phase: "ready", objective: "work", emptyContinuations: 2, erroredContinuations: 0 });
    expect(gm.nextLoopStep(3, true)).toEqual({ kind: "stall", reason: "errors" });
  });

  it("resets erroredContinuations on a tool call", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work", emptyContinuations: 2, erroredContinuations: 2 });
    gm.registerToolCall();
    expect((gm.state as any).erroredContinuations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pause()
// ---------------------------------------------------------------------------
describe("GoalStateMachine.pause", () => {
  it("throws when not ready", () => {
    const gm = new GoalStateMachine({ phase: "idle" });
    expect(() => gm.pause()).toThrow("Cannot pause goal while not ready");
  });

  it("transitions from ready to paused", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "active work" });
    gm.pause();
    expect(gm.state).toEqual({ phase: "paused", objective: "active work" });
  });
});

// ---------------------------------------------------------------------------
// complete()
// ---------------------------------------------------------------------------
describe("GoalStateMachine.complete", () => {
  it("throws when not ready", () => {
    const gm = new GoalStateMachine({ phase: "idle" });
    expect(() => gm.complete()).toThrow("Cannot complete goal while not ready");
    gm.state = { phase: "paused", objective: "paused" };
    expect(() => gm.complete()).toThrow("Cannot complete goal while not ready");
  });

  it("clears state to idle when ready", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "finished work" });
    gm.complete();
    expect(gm.state).toEqual({ phase: "idle" });
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------
describe("GoalStateMachine.clear", () => {
  it("sets state to idle from ready", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "some goal" });
    gm.clear();
    expect(gm.state).toEqual({ phase: "idle" });
  });

  it("sets state to idle from paused", () => {
    const gm = new GoalStateMachine({ phase: "paused", objective: "paused goal" });
    gm.clear();
    expect(gm.state).toEqual({ phase: "idle" });
  });

  it("leaves idle state as idle", () => {
    const gm = new GoalStateMachine({ phase: "idle" });
    gm.clear();
    expect(gm.state).toEqual({ phase: "idle" });
  });
});

// ---------------------------------------------------------------------------
// registerToolCall() / resetToolCalls()
// ---------------------------------------------------------------------------
describe("GoalStateMachine.registerToolCall", () => {
  it("returns false and does nothing when not ready", () => {
    const gm = new GoalStateMachine({ phase: "idle" });
    expect(gm.registerToolCall()).toBe(false);
  });

  it("increments toolsUsed from unset and returns true when ready", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work" });
    expect(gm.registerToolCall()).toBe(true);
    expect((gm.state as any).toolsUsed).toBe(1);
    gm.registerToolCall();
    expect((gm.state as any).toolsUsed).toBe(2);
  });

  // A real tool call between auditor rejections is evidence of new work, not looping,
  // so the consecutive-rejection streak used to cap retries must reset here.
  it("resets auditRejections to 0", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work", auditRejections: 2 });
    gm.registerToolCall();
    expect((gm.state as any).auditRejections).toBe(0);
  });

  // A real tool call means the cycle made progress, so the empty-cycle stall streak resets too.
  it("resets emptyContinuations to 0", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work", emptyContinuations: 2 });
    gm.registerToolCall();
    expect((gm.state as any).emptyContinuations).toBe(0);
  });
});

describe("GoalStateMachine.resetToolCalls", () => {
  it("does nothing when not ready", () => {
    const gm = new GoalStateMachine({ phase: "idle" });
    gm.resetToolCalls();
    expect(gm.state).toEqual({ phase: "idle" });
  });

  it("resets toolsUsed to 0 when ready", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work", toolsUsed: 5 });
    gm.resetToolCalls();
    expect((gm.state as any).toolsUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recordAuditRejection() -- bounds unbounded auditor-rejection retries
// ---------------------------------------------------------------------------
describe("GoalStateMachine.recordAuditRejection", () => {
  it("returns 0 and does nothing when not ready", () => {
    const gm = new GoalStateMachine({ phase: "idle" });
    expect(gm.recordAuditRejection()).toBe(0);
  });

  it("increments auditRejections from unset and returns the new count", () => {
    const gm = new GoalStateMachine({ phase: "ready", objective: "work" });
    expect(gm.recordAuditRejection()).toBe(1);
    expect(gm.recordAuditRejection()).toBe(2);
    expect((gm.state as any).auditRejections).toBe(2);
  });
});
