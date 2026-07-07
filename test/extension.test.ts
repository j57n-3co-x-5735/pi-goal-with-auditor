import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension";
import { CUSTOM_TYPE } from "../src/goal_finder";

vi.mock("../src/goal_auditor", () => ({
  runGoalCompletionAuditor: vi.fn().mockResolvedValue({
    approved: true,
    disapproved: false,
    output: "All criteria met.",
    model: "mock/test-model",
  }),
}));

// Config resolution is tested in goal_config.test.ts; here we mock it so the extension's use of
// the resolved values is deterministic and independent of any host goal-auditor.json.
vi.mock("../src/goal_config", () => ({
  loadGoalAuditorSettings: vi.fn(() => ({
    maxEmptyContinuations: 3,
    maxConsecutiveAuditRejections: 3,
    timeoutMs: 900000,
  })),
  goalAuditorConfigWarning: vi.fn(() => undefined),
}));

import { runGoalCompletionAuditor } from "../src/goal_auditor";
import { loadGoalAuditorSettings, goalAuditorConfigWarning } from "../src/goal_config";
const mockAuditor = vi.mocked(runGoalCompletionAuditor);
const mockSettings = vi.mocked(loadGoalAuditorSettings);
const mockConfigWarning = vi.mocked(goalAuditorConfigWarning);

const DEFAULT_SETTINGS = { maxEmptyContinuations: 3, maxConsecutiveAuditRejections: 3, timeoutMs: 900000, idleTimeoutMs: 120000 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SessionEntry-like object for use in getEntries(). */
function entry(overrides: Partial<SessionEntry> & { type: string; customType?: string; data?: unknown; details?: unknown }): SessionEntry {
  const base = {
    id: crypto.randomUUID?.() ?? Math.random().toString(36),
    parentId: null,
    timestamp: new Date().toISOString(),
  };
  return { ...base, ...overrides } as unknown as SessionEntry;
}

type CapturedCommand = {
  name: string;
  handler: (args: string, ctx: any) => Promise<void>;
};

type CapturedTool = {
  name: string;
  executionMode?: string;
  execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

type CapturedHandler = {
  event: string;
  handler: (event: any, ctx: any) => Promise<void> | void;
};

interface MockAPI {
  commands: CapturedCommand[];
  tools: CapturedTool[];
  handlers: CapturedHandler[];
  appendEntryCalls: { customType: string; data: unknown }[];
  sendMessageCalls: { message: any; options: any }[];
  activeTools: string[];
  setActiveToolsCalls: string[][];
  notifyCalls: { message: string; type?: string }[];
  setWidgetCalls: { key: string; content: any }[];
  getEntries: () => SessionEntry[];
}

const mockTheme = { fg: (_style: string, text: string) => text };

/** Create a mock ExtensionAPI wired to a shared MockAPI state bag. */
function createMockAPI(bag: MockAPI): ExtensionAPI {
  const sessionManager = { getEntries: () => bag.getEntries() };

  const ui = {
    notify: (message: string, type?: string) => {
      bag.notifyCalls.push({ message, type });
    },
    setWidget: (key: string, content: any) => {
      bag.setWidgetCalls.push({ key, content });
    },
    theme: mockTheme,
    confirm: (_title: string, _message: string) => Promise.resolve(true),
  };

  const api = {
    registerCommand(name: string, options: any) {
      bag.commands.push({ name, handler: options.handler });
    },
    registerTool(tool: any) {
      bag.tools.push({ name: tool.name, executionMode: tool.executionMode, execute: tool.execute });
    },
    on(event: string, handler: any) {
      bag.handlers.push({ event, handler });
    },
    appendEntry(customType: string, data?: unknown) {
      bag.appendEntryCalls.push({ customType, data });
    },
    sendMessage(message: any, options?: any) {
      bag.sendMessageCalls.push({ message, options });
    },
    getActiveTools() {
      return bag.activeTools;
    },
    setActiveTools(toolNames: string[]) {
      bag.setActiveToolsCalls.push(toolNames);
      bag.activeTools = toolNames;
    },
  } as unknown as ExtensionAPI;

  // Patch context factory onto the mock so tests can build ctx objects
  (api as any).sessionManager = sessionManager;
  (api as any).ui = ui;

  return api;
}

function buildCtx(bag: MockAPI, overrides: Record<string, unknown> = {}) {
  const sessionManager = { getEntries: () => bag.getEntries() };
  return {
    sessionManager,
    ui: {
      notify: (message: string, type?: string) => {
        bag.notifyCalls.push({ message, type });
      },
      setWidget: (key: string, content: any) => {
        bag.setWidgetCalls.push({ key, content });
      },
      theme: mockTheme,
      confirm: (_title: string, _message: string) => Promise.resolve(true),
    },
    hasUI: true,
    cwd: "/test",
    modelRegistry: {} as any,
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extension", () => {
  let bag: MockAPI;
  let pi: ExtensionAPI;

  beforeEach(() => {
    vi.useFakeTimers();
    // Re-establish default settings each test so a per-test override can't leak forward.
    mockSettings.mockReturnValue({ ...DEFAULT_SETTINGS });
    mockConfigWarning.mockReturnValue(undefined);

    bag = {
      commands: [],
      tools: [],
      handlers: [],
      appendEntryCalls: [],
      sendMessageCalls: [],
      activeTools: [],
      setActiveToolsCalls: [],
      notifyCalls: [],
      setWidgetCalls: [],
      getEntries: () => [],
    };
    pi = createMockAPI(bag);
    extension(pi);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -- registration ---------------------------------------------------------

  it("registers the goal command", () => {
    expect(bag.commands.some(c => c.name === "goal")).toBe(true);
  });

  it("registers event handlers for turn_end, agent_end, session_start", () => {
    const events = bag.handlers.map(h => h.event);
    expect(events).toContain("turn_end");
    expect(events).toContain("agent_end");
    expect(events).toContain("session_start");
  });

  it("registers get_goal and update_goal tools", () => {
    const names = bag.tools.map(t => t.name);
    expect(names).toContain("get_goal");
    expect(names).toContain("update_goal");
  });

  // The host's tool dispatcher runs a batch of tool calls in parallel by default unless a
  // tool in the batch declares executionMode: "sequential". Without this, a duplicated/hedged
  // update_goal call from the executor LLM in one turn could run concurrently with another
  // update_goal (or get_goal) call. See docs/architecture.md.
  it("declares executionMode 'sequential' on get_goal and update_goal", () => {
    const getGoal = bag.tools.find(t => t.name === "get_goal")!;
    const updateGoal = bag.tools.find(t => t.name === "update_goal")!;
    expect(getGoal.executionMode).toBe("sequential");
    expect(updateGoal.executionMode).toBe("sequential");
  });

  // -- /goal <empty> (idle) -------------------------------------------------

  it("/goal with empty args when idle shows state via notify", async () => {
    const cmd = bag.commands.find(c => c.name === "goal")!;
    const ctx = buildCtx(bag);
    await cmd.handler("", ctx);
    // idle → shows JSON state
    expect(bag.notifyCalls.length).toBe(1);
    expect(bag.notifyCalls[0].message).toContain('"idle"');
  });

  // -- /goal <objective> ----------------------------------------------------

  it("/goal <objective> starts a goal and sends a continuation message", async () => {
    const cmd = bag.commands.find(c => c.name === "goal")!;
    const ctx = buildCtx(bag);
    await cmd.handler("write unit tests", ctx);

    // Should have sent a continuation message (via setTimeout)
    expect(bag.sendMessageCalls.length).toBe(0); // setTimeout hasn't fired yet
    vi.runAllTimers();
    expect(bag.sendMessageCalls.length).toBe(1);
    const msg = bag.sendMessageCalls[0].message;
    expect(msg.customType).toBe(CUSTOM_TYPE);
    expect(msg.content).toContain("write unit tests");
    expect(bag.sendMessageCalls[0].options.triggerTurn).toBe(true);

    // Should have set the widget
    expect(bag.setWidgetCalls.length).toBe(1);
    expect(bag.setWidgetCalls[0].key).toBe(CUSTOM_TYPE);
    expect(bag.setWidgetCalls[0].content![0]).toContain("write unit tests");

    // Should have added goal tools
    expect(bag.setActiveToolsCalls.length).toBeGreaterThan(0);
    const last = bag.setActiveToolsCalls[bag.setActiveToolsCalls.length - 1];
    expect(last).toContain("get_goal");
    expect(last).toContain("update_goal");
  });

  // -- /goal pause ----------------------------------------------------------

  it("/goal pause pauses the goal and appends state entry", async () => {
    // Start a goal first so we have something to pause
    const cmd = bag.commands.find(c => c.name === "goal")!;
    const ctx = buildCtx(bag);

    // First set the goal
    bag.getEntries = () => [];
    await cmd.handler("some objective", ctx);
    vi.runAllTimers();

    // Now feed the entry so the next GoalStateMachine picks it up
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "some objective" } }),
    ];

    // Reset bag
    bag.appendEntryCalls = [];
    bag.sendMessageCalls = [];
    bag.setWidgetCalls = [];

    await cmd.handler("pause", ctx);

    expect(bag.appendEntryCalls.length).toBe(1);
    expect(bag.appendEntryCalls[0].customType).toBe(CUSTOM_TYPE);
    expect((bag.appendEntryCalls[0].data as any).phase).toBe("paused");
    expect(bag.setWidgetCalls.length).toBe(1);
    expect(bag.setWidgetCalls[0].content![0]).toContain("some objective");
  });

  // -- /goal resume ---------------------------------------------------------

  it("/goal resume resumes a paused goal and sends continuation", async () => {
    const cmd = bag.commands.find(c => c.name === "goal")!;
    const ctx = buildCtx(bag);

    // Feed state as paused
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "paused", objective: "paused goal" } }),
    ];

    await cmd.handler("resume", ctx);

    vi.runAllTimers();
    expect(bag.sendMessageCalls.length).toBe(1);
    expect(bag.sendMessageCalls[0].message.content).toContain("paused goal");
    expect(bag.setWidgetCalls.length).toBe(1);
    expect(bag.setWidgetCalls[0].content![0]).toContain("paused goal");
  });

  // -- /goal clear ----------------------------------------------------------

  it("/goal clear clears the goal and appends idle state", async () => {
    const cmd = bag.commands.find(c => c.name === "goal")!;
    const ctx = buildCtx(bag);

    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "to be cleared" } }),
    ];

    await cmd.handler("clear", ctx);

    expect(bag.appendEntryCalls.length).toBe(1);
    expect(bag.appendEntryCalls[0].customType).toBe(CUSTOM_TYPE);
    expect((bag.appendEntryCalls[0].data as any).phase).toBe("idle");
  });

  // -- get_goal tool --------------------------------------------------------

  it("get_goal returns 'No active goal.' when idle", async () => {
    const tool = bag.tools.find(t => t.name === "get_goal")!;
    const ctx = buildCtx(bag);
    const result = await tool.execute("id1", {}, undefined, undefined, ctx);
    expect(result.content[0].text).toBe("No active goal.");
  });

  it("get_goal returns objective and phase when a goal is active", async () => {
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "build stuff" } }),
    ];
    const tool = bag.tools.find(t => t.name === "get_goal")!;
    const ctx = buildCtx(bag);
    const result = await tool.execute("id1", {}, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Objective: build stuff");
    expect(result.content[0].text).toContain("Status: ready");
    expect(result.details).toEqual({ objective: "build stuff", phase: "ready" });
  });

  // -- update_goal tool -----------------------------------------------------

  it("update_goal completes the goal when auditor approves", async () => {
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "finish me" } }),
    ];
    mockAuditor.mockResolvedValueOnce({
      approved: true, disapproved: false, output: "All criteria met.", model: "mock/model",
    });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);

    const result = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("Goal complete.");
    expect(result.content[0].text).toContain("All criteria met.");
    // The auditor's model is surfaced so a weak-model verdict is visible, not silent.
    expect(result.content[0].text).toContain("Auditor (mock/model):");
    expect(bag.appendEntryCalls.length).toBe(1);
    expect((bag.appendEntryCalls[0].data as any).phase).toBe("idle");
    expect(bag.setWidgetCalls.length).toBe(1);
    expect(bag.setWidgetCalls[0].content).toBeUndefined();
  });

  it("surfaces the auditor model in a rejection", async () => {
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "finish me" } }),
    ];
    mockAuditor.mockResolvedValueOnce({
      approved: false, disapproved: true, output: "Not done.", model: "lmstudio/liquid/lfm2.5-1.2b",
    });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const result = await tool.execute("id1", { status: "complete" }, undefined, undefined, buildCtx(bag));

    expect(result.content[0].text).toContain("rejected by auditor (lmstudio/liquid/lfm2.5-1.2b).");
  });

  it("omits the model label when the auditor model is unknown", async () => {
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "finish me" } }),
    ];
    mockAuditor.mockResolvedValueOnce({ approved: false, disapproved: true, output: "Not done." });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const result = await tool.execute("id1", { status: "complete" }, undefined, undefined, buildCtx(bag));

    // No model -> no parenthetical, still a clean sentence.
    expect(result.content[0].text).toContain("rejected by auditor.");
    expect(result.content[0].text).not.toContain("auditor (");
  });

  it("update_goal rejects when auditor disapproves", async () => {
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "finish me" } }),
    ];
    mockAuditor.mockResolvedValueOnce({
      approved: false, disapproved: true, output: "Missing unit tests for module X.",
    });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);

    const result = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("rejected by auditor");
    expect(result.content[0].text).toContain("Missing unit tests");
    // A rejection now persists the incremented consecutive-rejection counter, so it
    // survives across separate update_goal calls -- state is reconstructed fresh each time.
    expect(bag.appendEntryCalls.length).toBe(1);
    expect((bag.appendEntryCalls[0].data as any).phase).toBe("ready");
    expect((bag.appendEntryCalls[0].data as any).auditRejections).toBe(1);
  });

  it("update_goal rejects when auditor errors", async () => {
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "finish me" } }),
    ];
    mockAuditor.mockResolvedValueOnce({
      approved: false, disapproved: true, output: "", error: "Model not found.",
    });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);

    const result = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("rejected by auditor");
    expect(result.content[0].text).toContain("Model not found");
    expect(bag.appendEntryCalls.length).toBe(1);
    expect((bag.appendEntryCalls[0].data as any).auditRejections).toBe(1);
  });

  it("update_goal rejects when auditor returns neither approved nor disapproved", async () => {
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "finish me" } }),
    ];
    mockAuditor.mockResolvedValueOnce({
      approved: false, disapproved: false, output: "",
    });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);

    const result = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);

    expect(result.content[0].text).toContain("rejected by auditor");
    expect(result.content[0].text).toContain("No approval marker found");
    expect(bag.appendEntryCalls.length).toBe(1);
    expect((bag.appendEntryCalls[0].data as any).auditRejections).toBe(1);
  });

  // A rejection loop with no intervening tool call must be bounded rather than leaving
  // update_goal immediately re-callable forever. Simulates 3 consecutive rejections by feeding
  // each call's persisted state back into getEntries(), the same way real session reconstruction
  // would -- state is not held in memory between separate tool invocations.
  it("pauses the goal after 3 consecutive auditor rejections with no intervening tool call", async () => {
    let latestData: unknown = { phase: "ready", objective: "finish me" };
    bag.getEntries = () => [entry({ type: "custom", customType: CUSTOM_TYPE, data: latestData })];
    mockAuditor.mockResolvedValue({ approved: false, disapproved: true, output: "Still incomplete." });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);

    for (let i = 0; i < 2; i++) {
      const result = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain("rejected by auditor");
      expect(result.content[0].text).not.toContain("Goal paused");
      latestData = bag.appendEntryCalls[bag.appendEntryCalls.length - 1].data;
      expect((latestData as any).phase).toBe("ready");
      expect((latestData as any).auditRejections).toBe(i + 1);
    }

    const finalResult = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);
    expect(finalResult.content[0].text).toContain("Goal paused");
    expect(finalResult.content[0].text).toContain("3 consecutive auditor rejections");
    latestData = bag.appendEntryCalls[bag.appendEntryCalls.length - 1].data;
    expect((latestData as any).phase).toBe("paused");
  });

  // When the rejections are guard-voided hollow approvals (the auditor is the broken
  // component, e.g. a too-weak model), the pause message must surface the auditor's own error and
  // point at the auditor-config possibility, so the human's next move (fix auditor vs. do work) is
  // guided rather than blamed generically on the executor. The auditor model is already named.
  it("guides toward the auditor-config possibility when hollow approvals drive the pause", async () => {
    let latestData: unknown = { phase: "ready", objective: "finish me" };
    bag.getEntries = () => [entry({ type: "custom", customType: CUSTOM_TYPE, data: latestData })];
    mockAuditor.mockResolvedValue({
      approved: false,
      disapproved: true,
      output: "",
      model: "lmstudio/liquid/lfm2.5-1.2b",
      error: "Auditor approved without running any successful tool -- no evidence gathered; treated as disapproval.",
    });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);

    let finalResult: any;
    for (let i = 0; i < 3; i++) {
      finalResult = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);
      latestData = bag.appendEntryCalls[bag.appendEntryCalls.length - 1].data;
    }

    const text = finalResult.content[0].text;
    expect(text).toContain("Goal paused");
    // The guard's own error is surfaced (the executor sees WHY, not a generic rejection)...
    expect(text).toContain("approved without running any successful tool");
    // ...the auditor model is named...
    expect(text).toContain("lmstudio/liquid/lfm2.5-1.2b");
    // ...and the pause guidance names the auditor-config possibility.
    expect(text).toContain("PI_GOAL_AUDITOR_MODEL");
  });

  // A real tool call between rejections is evidence of new work, not looping -- the
  // streak must reset rather than accumulating toward the pause across an entire long task.
  it("does not pause when a tool call happens between rejections", async () => {
    let latestData: unknown = { phase: "ready", objective: "finish me" };
    bag.getEntries = () => [entry({ type: "custom", customType: CUSTOM_TYPE, data: latestData })];
    mockAuditor.mockResolvedValue({ approved: false, disapproved: true, output: "Still incomplete." });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const toolCallHandler = bag.handlers.find(h => h.event === "tool_call")!;
    const ctx = buildCtx(bag);

    for (let i = 0; i < 5; i++) {
      const result = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);
      expect(result.content[0].text).not.toContain("Goal paused");
      latestData = bag.appendEntryCalls[bag.appendEntryCalls.length - 1].data;
      await toolCallHandler.handler({}, ctx);
      latestData = bag.appendEntryCalls[bag.appendEntryCalls.length - 1].data;
      expect((latestData as any).auditRejections).toBe(0);
    }
  });

  // The caps are read from the config module, not hardcoded: a custom rejection cap changes
  // when the pause trips. Proves the extension actually consumes the resolved settings.
  it("uses the configured maxConsecutiveAuditRejections (settings-driven, not hardcoded)", async () => {
    mockSettings.mockReturnValue({ ...DEFAULT_SETTINGS, maxConsecutiveAuditRejections: 2 });
    let latestData: unknown = { phase: "ready", objective: "finish me" };
    bag.getEntries = () => [entry({ type: "custom", customType: CUSTOM_TYPE, data: latestData })];
    mockAuditor.mockResolvedValue({ approved: false, disapproved: true, output: "Still incomplete." });
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);

    // First rejection: not yet at the cap of 2.
    let result = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);
    expect(result.content[0].text).not.toContain("Goal paused");
    latestData = bag.appendEntryCalls[bag.appendEntryCalls.length - 1].data;

    // Second rejection: hits the configured cap of 2 -> pause.
    result = await tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Goal paused");
    expect((bag.appendEntryCalls[bag.appendEntryCalls.length - 1].data as any).phase).toBe("paused");
  });

  // -- config warning -------------------------------------------------------

  it("notifies once at session_start when the config file is malformed", async () => {
    mockConfigWarning.mockReturnValue("goal-auditor.json is not valid JSON; using defaults.");
    const handler = bag.handlers.find(h => h.event === "session_start")!;
    await handler.handler({}, buildCtx(bag));

    expect(bag.notifyCalls.some(c => c.message.includes("not valid JSON"))).toBe(true);
  });

  it("does not notify at session_start when the config is absent/valid", async () => {
    mockConfigWarning.mockReturnValue(undefined);
    const handler = bag.handlers.find(h => h.event === "session_start")!;
    await handler.handler({}, buildCtx(bag));

    expect(bag.notifyCalls.length).toBe(0);
  });

  // Defense-in-depth: even if two update_goal invocations somehow run concurrently
  // (e.g. the executionMode guard is bypassed by a future host change), the freshGm re-read
  // must ensure only one of them applies its completion — regardless of which auditor
  // resolves first. This exercises that guard directly, independent of the executionMode fix.
  it("only one of two overlapping update_goal calls completes the goal, regardless of auditor resolution order", async () => {
    const sessionEntries = [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "finish me" } }),
    ];
    // Return a fresh copy each call: goalForSession reverses the array in place, and a shared
    // live reference would corrupt ordering across the two overlapping calls below.
    bag.getEntries = () => [...sessionEntries];
    (pi as any).appendEntry = (customType: string, data?: unknown) => {
      bag.appendEntryCalls.push({ customType, data });
      sessionEntries.push(entry({ type: "custom", customType, data }));
    };

    let resolveFirst: (v: any) => void;
    let resolveSecond: (v: any) => void;
    const firstAuditorPromise = new Promise((resolve) => { resolveFirst = resolve; });
    const secondAuditorPromise = new Promise((resolve) => { resolveSecond = resolve; });
    mockAuditor
      .mockImplementationOnce(() => firstAuditorPromise as any)
      .mockImplementationOnce(() => secondAuditorPromise as any);

    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);

    // Fire both without awaiting the first, simulating the host dispatching two update_goal
    // tool calls from the same batch concurrently.
    const call1 = tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);
    const call2 = tool.execute("id2", { status: "complete" }, undefined, undefined, ctx);

    // The second call's audit resolves first (arrival order is nondeterministic in reality).
    resolveSecond!({ approved: true, disapproved: false, output: "second" });
    const result2 = await call2;
    // The first call's audit resolves after the second has already completed the goal.
    resolveFirst!({ approved: true, disapproved: false, output: "first" });
    const result1 = await call1;

    const completions = bag.appendEntryCalls.filter(c => (c.data as any).phase === "idle");
    expect(completions.length).toBe(1);
    expect(result2.content[0].text).toContain("Goal complete.");
    expect(result1.content[0].text).toContain("Goal state changed during audit");
    expect(result1.content[0].text).toContain("was not applied");
  });

  // TOCTOU: the post-audit re-read used to check phase only. If
  // the audited goal is cleared and a DIFFERENT goal is started while the audit
  // is still in flight, phase reads "ready" again -- but for a goal that was never audited.
  // The re-read must also confirm the objective (and startedAt) haven't changed underneath it.
  it("does not complete a different goal that was started during the audit (TOCTOU)", async () => {
    const sessionEntries = [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "goal A", startedAt: 1000 } }),
    ];
    bag.getEntries = () => [...sessionEntries];
    (pi as any).appendEntry = (customType: string, data?: unknown) => {
      bag.appendEntryCalls.push({ customType, data });
      sessionEntries.push(entry({ type: "custom", customType, data }));
    };

    let resolveAuditor: (v: any) => void;
    const auditorPromise = new Promise((resolve) => { resolveAuditor = resolve; });
    mockAuditor.mockImplementationOnce(() => auditorPromise as any);

    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);

    const call = tool.execute("id1", { status: "complete" }, undefined, undefined, ctx);

    // While the audit for "goal A" is in flight, the user clears it and starts a different
    // goal ("goal B") -- same phase ("ready") but a different objective and startedAt.
    sessionEntries.push(entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "idle" } }));
    sessionEntries.push(entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "goal B", startedAt: 2000 } }));

    // The audit for goal A resolves as approved -- but goal A is no longer the active goal.
    resolveAuditor!({ approved: true, disapproved: false, output: "approved for goal A" });
    const result = await call;

    const completions = bag.appendEntryCalls.filter(c => (c.data as any).phase === "idle");
    expect(completions.length).toBe(0);
    expect(result.content[0].text).toContain("Goal state changed during audit");
    expect(result.content[0].text).toContain("no longer the same goal");
  });

  it("update_goal throws when not ready", async () => {
    bag.getEntries = () => [];
    const tool = bag.tools.find(t => t.name === "update_goal")!;
    const ctx = buildCtx(bag);
    await expect(
      tool.execute("id1", { status: "complete" }, undefined, undefined, ctx),
    ).rejects.toThrow("Cannot complete goal while not ready");
  });

  // -- session_start event --------------------------------------------------

  it("session_start syncs goal tools based on persisted state", () => {
    const handler = bag.handlers.find(h => h.event === "session_start")!;
    const ctx = buildCtx(bag);

    // When state is idle, goal tools should NOT be active
    bag.activeTools = ["foo"];
    handler.handler({ type: "session_start", reason: "startup" }, ctx);
    expect(bag.setActiveToolsCalls.length).toBe(0);

    // When state is ready, goal tools should be added
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "ongoing" } }),
    ];
    handler.handler({ type: "session_start", reason: "resume" }, ctx);
    expect(bag.setActiveToolsCalls.length).toBeGreaterThan(0);
    const last = bag.setActiveToolsCalls[bag.setActiveToolsCalls.length - 1];
    expect(last).toContain("get_goal");
    expect(last).toContain("update_goal");
  });

  // -- turn_end event -------------------------------------------------------

  it("turn_end with aborted signal pauses the goal", () => {
    const handler = bag.handlers.find(h => h.event === "turn_end")!;

    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "work" } }),
    ];

    const ctx = buildCtx(bag, { signal: { aborted: true } });
    handler.handler({ type: "turn_end", turnIndex: 1, message: {} as any, toolResults: [] }, ctx);

    // Should have paused the goal
    expect(bag.appendEntryCalls.length).toBe(1);
    expect((bag.appendEntryCalls[0].data as any).phase).toBe("paused");
    // Should have notified
    expect(bag.notifyCalls.length).toBe(1);
    expect(bag.notifyCalls[0].message).toContain("abort signal");
  });

  it("turn_end without aborted signal does nothing", () => {
    const handler = bag.handlers.find(h => h.event === "turn_end")!;
    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "work" } }),
    ];
    const ctx = buildCtx(bag, { signal: undefined });
    handler.handler({ type: "turn_end", turnIndex: 1, message: {} as any, toolResults: [] }, ctx);

    // No calls should have been made
    expect(bag.appendEntryCalls.length).toBe(0);
    expect(bag.notifyCalls.length).toBe(0);
  });

  // -- agent_end event ------------------------------------------------------

  it("agent_end continues when goal is ready and tools were used", async () => {
    const handler = bag.handlers.find(h => h.event === "agent_end")!;

    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "keep going", toolsUsed: 1 } }),
    ];

    const ctx = buildCtx(bag);
    await handler.handler({ type: "agent_end", messages: [] }, ctx);

    vi.runAllTimers();
    expect(bag.sendMessageCalls.length).toBe(1);
    expect(bag.sendMessageCalls[0].message.content).toContain("keep going");
    expect(bag.setWidgetCalls.length).toBe(1);
    expect(bag.setWidgetCalls[0].content![0]).toContain("keep going");
  });

  // Weak-model fix: a single empty (text-only) cycle no longer pauses the loop. It nudges the
  // model to act and continues, so a small model that emits a clarifying question or plan on one
  // turn doesn't kill the goal.
  it("agent_end nudges and continues (does not pause) on the first empty cycle", async () => {
    const handler = bag.handlers.find(h => h.event === "agent_end")!;

    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "no tools used" } }),
    ];

    const ctx = buildCtx(bag);
    await handler.handler({ type: "agent_end", messages: [] }, ctx);

    vi.runAllTimers();
    // Sends a nudged continuation, does not pause.
    expect(bag.sendMessageCalls.length).toBe(1);
    expect(bag.sendMessageCalls[0].message.content).toContain("made no tool calls");
    expect(bag.sendMessageCalls[0].message.content).toContain("no tools used");
    // The incremented empty-cycle streak is persisted via the continuation message details.
    expect((bag.sendMessageCalls[0].message.details as any).emptyContinuations).toBe(1);
    // No pause notification.
    expect(bag.notifyCalls.length).toBe(0);
  });

  // Only a genuine stall -- MAX_EMPTY_CONTINUATIONS (default 3) empty cycles in a row with no
  // tool call in between -- pauses. Simulated by feeding each cycle's persisted streak back in.
  it("agent_end pauses after the default 3 consecutive empty cycles (stall)", async () => {
    const handler = bag.handlers.find(h => h.event === "agent_end")!;
    let latestData: unknown = { phase: "ready", objective: "stalled goal" };
    bag.getEntries = () => [entry({ type: "custom", customType: CUSTOM_TYPE, data: latestData })];
    const ctx = buildCtx(bag);

    // Cycles 1 and 2: empty -> nudge + continue, no pause.
    for (let i = 0; i < 2; i++) {
      await handler.handler({ type: "agent_end", messages: [] }, ctx);
      vi.runAllTimers();
      latestData = bag.sendMessageCalls[bag.sendMessageCalls.length - 1].message.details;
      expect((latestData as any).emptyContinuations).toBe(i + 1);
    }
    expect(bag.notifyCalls.length).toBe(0);

    // Cycle 3: third empty in a row -> stall -> pause.
    await handler.handler({ type: "agent_end", messages: [] }, ctx);
    vi.runAllTimers();
    expect(bag.notifyCalls.length).toBe(1);
    expect(bag.notifyCalls[0].message).toContain("stalled");
    const paused = bag.appendEntryCalls[bag.appendEntryCalls.length - 1].data as any;
    expect(paused.phase).toBe("paused");
  });

  // Error handling: empty cycles caused by MODEL ERRORS (stopReason "error", e.g. context
  // overflow) get a plain continuation (no nudge) and, on pause, a message that diagnoses the
  // model/config rather than blaming a work stall.
  it("agent_end diagnoses a model/context error when empty cycles are errored turns", async () => {
    const handler = bag.handlers.find(h => h.event === "agent_end")!;
    let latestData: unknown = { phase: "ready", objective: "big-context goal" };
    bag.getEntries = () => [entry({ type: "custom", customType: CUSTOM_TYPE, data: latestData })];
    const ctx = buildCtx(bag);
    // An agent_end whose final assistant message errored (the qwen n_keep>=n_ctx case).
    const erroredEvent = {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "n_keep: 17006 >= n_ctx: 4352" }],
    };

    // Cycles 1 and 2: errored -> continue with a PLAIN prompt (no "made no tool calls" nudge).
    for (let i = 0; i < 2; i++) {
      await handler.handler(erroredEvent, ctx);
      vi.runAllTimers();
      const sent = bag.sendMessageCalls[bag.sendMessageCalls.length - 1].message;
      expect(sent.content).not.toContain("made no tool calls");
      latestData = sent.details;
      expect((latestData as any).erroredContinuations).toBe(i + 1);
    }

    // Cycle 3: third errored in a row -> pause with the model/context diagnosis, not "stalled".
    await handler.handler(erroredEvent, ctx);
    vi.runAllTimers();
    const msg = bag.notifyCalls[bag.notifyCalls.length - 1].message;
    expect(msg).toContain("the model errored");
    expect(msg).toContain("context window");
    expect(msg).not.toContain("appears stalled");
  });

  it("agent_end does nothing when goal is idle", async () => {
    const handler = bag.handlers.find(h => h.event === "agent_end")!;
    bag.getEntries = () => [];
    const ctx = buildCtx(bag);
    await handler.handler({ type: "agent_end", messages: [] }, ctx);

    vi.runAllTimers();
    expect(bag.sendMessageCalls.length).toBe(0);
  });

  // -- syncPiState idempotency ----------------------------------------------

  it("syncPiState does not modify tools when already in correct state", () => {
    const handler = bag.handlers.find(h => h.event === "session_start")!;
    bag.activeTools = ["get_goal", "update_goal"];
    bag.setActiveToolsCalls = [];

    bag.getEntries = () => [
      entry({ type: "custom", customType: CUSTOM_TYPE, data: { phase: "ready", objective: "test" } }),
    ];

    handler.handler({ type: "session_start", reason: "startup" }, buildCtx(bag));
    // Tools already present → no change
    expect(bag.setActiveToolsCalls.length).toBe(0);
  });

  it("syncPiState removes goal tools when goal is not ready", () => {
    const handler = bag.handlers.find(h => h.event === "session_start")!;
    bag.activeTools = ["get_goal", "update_goal", "other_tool"];
    bag.setActiveToolsCalls = [];

    bag.getEntries = () => [];
    handler.handler({ type: "session_start", reason: "startup" }, buildCtx(bag));

    expect(bag.setActiveToolsCalls.length).toBe(1);
    expect(bag.setActiveToolsCalls[0]).toEqual(["other_tool"]);
  });
});
