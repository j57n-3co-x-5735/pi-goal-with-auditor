import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Single configuration surface for the goal-auditor extension.
 *
 * Every knob is resolved from three layers, highest precedence first:
 *   1. environment variables (ad-hoc / CI overrides)
 *   2. a global JSON config file: `<agentDir>/goal-auditor.json`
 *   3. built-in defaults
 *
 * The config file is the visible, obvious place to set options; env vars still win so a
 * one-off run can override without editing the file. Reading a config file is a sanctioned
 * fs read (pi's own extension docs document exactly this pattern via `getAgentDir()` /
 * `CONFIG_DIR_NAME`) -- it is NOT the "write goal state to disk" the fork deliberately avoids.
 * State still lives only in the session JSONL; this file holds configuration, nothing else.
 *
 * Global-only by design: there is intentionally no project-local override, so an untrusted
 * repository can never change how its own completion gets audited.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const GOAL_AUDITOR_CONFIG_FILENAME = "goal-auditor.json";

export interface GoalAuditorSettings {
  /** Auditor provider override; undefined falls back to the host session's provider. */
  provider?: string;
  /** Auditor model override; undefined falls back to the host session's model. */
  model?: string;
  /** Auditor thinking level; undefined falls back to the host session's level. */
  thinkingLevel?: ThinkingLevel;
  /** Absolute wall-clock cap on a single audit, in ms. 0 disables the absolute cap. */
  timeoutMs: number;
  /**
   * Idle/liveness cap: abort the audit after this many ms with no streamed output from the
   * auditor session (arms on the first output, resets on every subsequent one). 0 disables it.
   * This is the primary "is it hung" backstop -- a slow-but-still-producing model never trips
   * it, only a genuinely stalled one; the absolute `timeoutMs` is the outer bound.
   */
  idleTimeoutMs: number;
  /** Consecutive no-tool-call agent cycles tolerated before the goal loop pauses (>= 1). */
  maxEmptyContinuations: number;
  /** Consecutive auditor rejections with no intervening tool call before the goal pauses (>= 1). */
  maxConsecutiveAuditRejections: number;
}

const DEFAULTS = {
  timeoutMs: 15 * 60 * 1000,
  idleTimeoutMs: 2 * 60 * 1000,
  maxEmptyContinuations: 3,
  maxConsecutiveAuditRejections: 3,
} as const;

type RawFileConfig = Partial<Record<keyof GoalAuditorSettings, unknown>>;

interface LoadedFile {
  config: RawFileConfig;
  /** Set only when the file exists but could not be read/parsed as a JSON object. */
  warning?: string;
}

function readConfigFile(agentDir: string): LoadedFile {
  const path = join(agentDir, GOAL_AUDITOR_CONFIG_FILENAME);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // An absent file is the normal case: defaults apply, no warning. Any other read error
    // (permissions, etc.) is surfaced so a real problem isn't silently swallowed.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { config: {} };
    return { config: {}, warning: `Could not read ${path}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { config: {}, warning: `${path} is not valid JSON (${(err as Error).message}); using defaults.` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config: {}, warning: `${path} must contain a JSON object; using defaults.` };
  }
  return { config: parsed as RawFileConfig };
}

/** env (trimmed, non-empty) > file (string, non-empty) > undefined. */
function pickString(envVal: string | undefined, fileVal: unknown): string | undefined {
  const e = envVal?.trim();
  if (e) return e;
  if (typeof fileVal === "string" && fileVal.trim()) return fileVal.trim();
  return undefined;
}

/** Same precedence, but the value must be a recognised thinking level or it is ignored. */
function pickThinking(envVal: string | undefined, fileVal: unknown): ThinkingLevel | undefined {
  const e = envVal?.trim();
  if (e && THINKING_LEVELS.has(e)) return e as ThinkingLevel;
  if (typeof fileVal === "string" && THINKING_LEVELS.has(fileVal.trim())) {
    return fileVal.trim() as ThinkingLevel;
  }
  return undefined;
}

/** env int > file int (both validated as finite integers >= min) > default. */
function pickInt(envVal: string | undefined, fileVal: unknown, def: number, min: number): number {
  const e = envVal?.trim();
  if (e) {
    const n = Number.parseInt(e, 10);
    if (Number.isFinite(n) && n >= min) return n;
  }
  if (typeof fileVal === "number" && Number.isInteger(fileVal) && fileVal >= min) return fileVal;
  return def;
}

function safeAgentDir(): string {
  try {
    return getAgentDir();
  } catch {
    return "";
  }
}

/**
 * Resolve the extension's settings from env vars, the global config file, and defaults.
 * Never throws: a missing or malformed config file falls back to defaults (surface the reason
 * with `goalAuditorConfigWarning`). `agentDir`/`env` are injectable for testing.
 */
export function loadGoalAuditorSettings(opts?: {
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): GoalAuditorSettings {
  const env = opts?.env ?? process.env;
  const agentDir = opts?.agentDir ?? safeAgentDir();
  const { config } = readConfigFile(agentDir);
  return {
    provider: pickString(env.PI_GOAL_AUDITOR_PROVIDER, config.provider),
    model: pickString(env.PI_GOAL_AUDITOR_MODEL, config.model),
    thinkingLevel: pickThinking(env.PI_GOAL_AUDITOR_THINKING_LEVEL, config.thinkingLevel),
    timeoutMs: pickInt(env.PI_GOAL_AUDITOR_TIMEOUT_MS, config.timeoutMs, DEFAULTS.timeoutMs, 0),
    idleTimeoutMs: pickInt(
      env.PI_GOAL_AUDITOR_IDLE_TIMEOUT_MS,
      config.idleTimeoutMs,
      DEFAULTS.idleTimeoutMs,
      0,
    ),
    maxEmptyContinuations: pickInt(
      env.PI_GOAL_MAX_EMPTY_CONTINUATIONS,
      config.maxEmptyContinuations,
      DEFAULTS.maxEmptyContinuations,
      1,
    ),
    maxConsecutiveAuditRejections: pickInt(
      env.PI_GOAL_MAX_CONSECUTIVE_AUDIT_REJECTIONS,
      config.maxConsecutiveAuditRejections,
      DEFAULTS.maxConsecutiveAuditRejections,
      1,
    ),
  };
}

/**
 * Returns a human-readable warning if the config file is present but unreadable or malformed,
 * so the extension can surface it once (settings silently not applying is its own footgun).
 * Returns undefined when the file is absent (the normal case) or valid.
 */
export function goalAuditorConfigWarning(opts?: { agentDir?: string }): string | undefined {
  const agentDir = opts?.agentDir ?? safeAgentDir();
  return readConfigFile(agentDir).warning;
}
