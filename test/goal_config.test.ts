import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadGoalAuditorSettings,
  goalAuditorConfigWarning,
  GOAL_AUDITOR_CONFIG_FILENAME,
} from "../src/goal_config";

// A real temp agent dir per test; the loader is exercised through actual fs reads (agentDir is
// injected, so getAgentDir() is never called and no host config is touched).
let agentDir: string;

function writeConfig(contents: string) {
  writeFileSync(join(agentDir, GOAL_AUDITOR_CONFIG_FILENAME), contents);
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "goal-auditor-cfg-"));
});
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

const DEFAULTS = {
  timeoutMs: 15 * 60 * 1000,
  idleTimeoutMs: 2 * 60 * 1000,
  maxEmptyContinuations: 3,
  maxConsecutiveAuditRejections: 3,
};

describe("loadGoalAuditorSettings — defaults", () => {
  it("returns built-in defaults when no file and no env", () => {
    const s = loadGoalAuditorSettings({ env: {}, agentDir });
    expect(s.provider).toBeUndefined();
    expect(s.model).toBeUndefined();
    expect(s.thinkingLevel).toBeUndefined();
    expect(s.timeoutMs).toBe(DEFAULTS.timeoutMs);
    expect(s.idleTimeoutMs).toBe(DEFAULTS.idleTimeoutMs);
    expect(s.maxEmptyContinuations).toBe(DEFAULTS.maxEmptyContinuations);
    expect(s.maxConsecutiveAuditRejections).toBe(DEFAULTS.maxConsecutiveAuditRejections);
  });

  it("defaults the absolute timeout to 15 minutes and the idle timeout to 2 minutes", () => {
    const s = loadGoalAuditorSettings({ env: {}, agentDir });
    expect(s.timeoutMs).toBe(900000);
    expect(s.idleTimeoutMs).toBe(120000);
  });
});

describe("loadGoalAuditorSettings — config file", () => {
  it("reads all values from the file", () => {
    writeConfig(JSON.stringify({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      thinkingLevel: "low",
      timeoutMs: 600000,
      idleTimeoutMs: 90000,
      maxEmptyContinuations: 5,
      maxConsecutiveAuditRejections: 2,
    }));
    const s = loadGoalAuditorSettings({ env: {}, agentDir });
    expect(s).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      thinkingLevel: "low",
      timeoutMs: 600000,
      idleTimeoutMs: 90000,
      maxEmptyContinuations: 5,
      maxConsecutiveAuditRejections: 2,
    });
  });

  it("allows timeoutMs: 0 in the file to disable the absolute cap", () => {
    writeConfig(JSON.stringify({ timeoutMs: 0 }));
    expect(loadGoalAuditorSettings({ env: {}, agentDir }).timeoutMs).toBe(0);
  });

  it("ignores an unrecognized thinking level in the file, falling back to undefined", () => {
    writeConfig(JSON.stringify({ thinkingLevel: "turbo" }));
    expect(loadGoalAuditorSettings({ env: {}, agentDir }).thinkingLevel).toBeUndefined();
  });

  it("ignores wrong-typed or out-of-range file values, falling back to defaults", () => {
    writeConfig(JSON.stringify({
      timeoutMs: "lots",          // wrong type
      maxEmptyContinuations: 0,   // below min (1)
      maxConsecutiveAuditRejections: -4, // below min
      provider: 123,              // wrong type
    }));
    const s = loadGoalAuditorSettings({ env: {}, agentDir });
    expect(s.timeoutMs).toBe(DEFAULTS.timeoutMs);
    expect(s.maxEmptyContinuations).toBe(DEFAULTS.maxEmptyContinuations);
    expect(s.maxConsecutiveAuditRejections).toBe(DEFAULTS.maxConsecutiveAuditRejections);
    expect(s.provider).toBeUndefined();
  });

  it("ignores a non-integer numeric knob", () => {
    writeConfig(JSON.stringify({ maxEmptyContinuations: 2.5 }));
    expect(loadGoalAuditorSettings({ env: {}, agentDir }).maxEmptyContinuations).toBe(3);
  });
});

describe("loadGoalAuditorSettings — env overrides file (precedence)", () => {
  it("env wins over a file value", () => {
    writeConfig(JSON.stringify({ model: "file-model", timeoutMs: 600000 }));
    const s = loadGoalAuditorSettings({
      env: { PI_GOAL_AUDITOR_MODEL: "env-model", PI_GOAL_AUDITOR_TIMEOUT_MS: "120000" },
      agentDir,
    });
    expect(s.model).toBe("env-model");
    expect(s.timeoutMs).toBe(120000);
  });

  it("falls through to the file when the env var is unset", () => {
    writeConfig(JSON.stringify({ model: "file-model" }));
    expect(loadGoalAuditorSettings({ env: {}, agentDir }).model).toBe("file-model");
  });

  it("an invalid env value is ignored, falling back to the file value", () => {
    writeConfig(JSON.stringify({ maxEmptyContinuations: 4 }));
    const s = loadGoalAuditorSettings({ env: { PI_GOAL_MAX_EMPTY_CONTINUATIONS: "0" }, agentDir });
    expect(s.maxEmptyContinuations).toBe(4);
  });

  it("reads every knob from env", () => {
    const s = loadGoalAuditorSettings({
      env: {
        PI_GOAL_AUDITOR_PROVIDER: "openai",
        PI_GOAL_AUDITOR_MODEL: "gpt-x",
        PI_GOAL_AUDITOR_THINKING_LEVEL: "high",
        PI_GOAL_AUDITOR_TIMEOUT_MS: "0",
        PI_GOAL_AUDITOR_IDLE_TIMEOUT_MS: "45000",
        PI_GOAL_MAX_EMPTY_CONTINUATIONS: "7",
        PI_GOAL_MAX_CONSECUTIVE_AUDIT_REJECTIONS: "9",
      },
      agentDir,
    });
    expect(s).toEqual({
      provider: "openai",
      model: "gpt-x",
      thinkingLevel: "high",
      timeoutMs: 0,
      idleTimeoutMs: 45000,
      maxEmptyContinuations: 7,
      maxConsecutiveAuditRejections: 9,
    });
  });

  it("trims and ignores empty env strings", () => {
    writeConfig(JSON.stringify({ provider: "file-provider" }));
    const s = loadGoalAuditorSettings({
      env: { PI_GOAL_AUDITOR_PROVIDER: "   ", PI_GOAL_AUDITOR_MODEL: "  gpt-4o  " },
      agentDir,
    });
    expect(s.provider).toBe("file-provider"); // empty env ignored -> file wins
    expect(s.model).toBe("gpt-4o"); // trimmed
  });
});

describe("loadGoalAuditorSettings — malformed/absent file never throws", () => {
  it("uses defaults when the file is absent", () => {
    const s = loadGoalAuditorSettings({ env: {}, agentDir });
    expect(s.maxEmptyContinuations).toBe(3);
  });

  it("uses defaults when the file is not valid JSON", () => {
    writeConfig("{ not json");
    const s = loadGoalAuditorSettings({ env: {}, agentDir });
    expect(s.maxEmptyContinuations).toBe(3);
  });

  it("uses defaults when the file is a JSON array, not an object", () => {
    writeConfig(JSON.stringify([1, 2, 3]));
    expect(loadGoalAuditorSettings({ env: {}, agentDir }).timeoutMs).toBe(DEFAULTS.timeoutMs);
  });
});

describe("goalAuditorConfigWarning", () => {
  it("returns undefined when the file is absent", () => {
    expect(goalAuditorConfigWarning({ agentDir })).toBeUndefined();
  });

  it("returns undefined when the file is a valid object", () => {
    writeConfig(JSON.stringify({ timeoutMs: 1000 }));
    expect(goalAuditorConfigWarning({ agentDir })).toBeUndefined();
  });

  it("warns when the file is present but not valid JSON", () => {
    writeConfig("{ oops");
    expect(goalAuditorConfigWarning({ agentDir })).toContain("not valid JSON");
  });

  it("warns when the file is present but not a JSON object", () => {
    writeConfig(JSON.stringify("just a string"));
    expect(goalAuditorConfigWarning({ agentDir })).toContain("must contain a JSON object");
  });
});
