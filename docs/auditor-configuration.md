# Auditor Configuration

Every knob lives in one place: a global `goal-auditor.json` in the pi agent directory (the same dir as pi's own `settings.json` — resolved via the SDK's `getAgentDir()`, typically `~/.pi/agent/`). Environment variables still work and override the file, so a one-off run can change a setting without editing it.

This is a *configuration* file — it is only ever read, never written. It follows pi's own documented per-extension config pattern (extensions read their own JSON via `getAgentDir()`/`CONFIG_DIR_NAME`); it is not the disk-backed *state* the fork deliberately avoids. It is **global only**: there is intentionally no project-local override, so an untrusted repository can never change how its own completion is audited.

## The config file

`<pi-agent-dir>/goal-auditor.json` — every key is optional; omit any to take its default:

```json
{
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001",
  "thinkingLevel": "low",
  "timeoutMs": 900000,
  "idleTimeoutMs": 120000,
  "maxEmptyContinuations": 3,
  "maxConsecutiveAuditRejections": 3
}
```

| Key | Meaning | Default |
|---|---|---|
| `provider` | Auditor LLM provider (e.g. `anthropic`, `openai`, `lmstudio`) | Host session's provider |
| `model` | Auditor model ID, optionally `provider/id` | Host session's model |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | Host session's level |
| `timeoutMs` | Absolute wall-clock cap on one audit, in ms. `0` disables the absolute cap | `900000` (15 min) |
| `idleTimeoutMs` | Idle/liveness cap: abort after this many ms with **no** streamed output from the auditor (resets on every event). `0` disables it | `120000` (2 min) |
| `maxEmptyContinuations` | Consecutive no-tool-call agent cycles before the goal loop pauses (≥ 1) | `3` |
| `maxConsecutiveAuditRejections` | Consecutive auditor rejections with no intervening tool call before the goal pauses (≥ 1) | `3` |

A missing file is normal — everything falls back to defaults. A file that exists but isn't valid JSON (or isn't a JSON object) is ignored with a one-time warning at session start, so a typo doesn't silently drop your settings. Individual values of the wrong type or out of range are ignored the same way (fall back to default), the rest of the file still applies.

## Environment variables (override the file)

Each key has an env equivalent, which takes precedence over the file:

| Variable | Overrides | Default |
|---|---|---|
| `PI_GOAL_AUDITOR_PROVIDER` | `provider` | Host session's provider |
| `PI_GOAL_AUDITOR_MODEL` | `model` | Host session's model |
| `PI_GOAL_AUDITOR_THINKING_LEVEL` | `thinkingLevel` | Host session's thinking level |
| `PI_GOAL_AUDITOR_TIMEOUT_MS` | `timeoutMs` | `900000` |
| `PI_GOAL_AUDITOR_IDLE_TIMEOUT_MS` | `idleTimeoutMs` | `120000` |
| `PI_GOAL_MAX_EMPTY_CONTINUATIONS` | `maxEmptyContinuations` | `3` |
| `PI_GOAL_MAX_CONSECUTIVE_AUDIT_REJECTIONS` | `maxConsecutiveAuditRejections` | `3` |

Precedence is **env var > config file > built-in default**. If nothing is set, the auditor uses the same model and thinking level as the host Pi session.

## Model Resolution

The `PI_GOAL_AUDITOR_MODEL` variable supports several formats:

```bash
# Explicit provider/model pair
PI_GOAL_AUDITOR_MODEL=anthropic/claude-haiku-4-5-20251001

# Model ID only (must uniquely match one available model)
PI_GOAL_AUDITOR_MODEL=claude-haiku-4-5-20251001

# Provider only (uses the first available model for that provider)
PI_GOAL_AUDITOR_PROVIDER=anthropic
```

When both `PI_GOAL_AUDITOR_PROVIDER` and `PI_GOAL_AUDITOR_MODEL` are set, the auditor looks up the model by provider and ID. When only the provider is set, it uses the first available model for that provider. When only the model is set with a `provider/id` format, it splits on `/` and looks up both.

If the configured model is not found or is ambiguous (multiple models match), the auditor fails closed — the goal stays active and the error message is returned to the executor.

## Cost Management

The auditor spawns a full agent session that can make tool calls (reading files, running grep, executing bash commands). This consumes tokens. To manage cost:

- **Use a cheaper model** — point the auditor at a smaller/faster model than the executor. The auditor's job is verification, not generation.
- **Use a lower thinking level** — `PI_GOAL_AUDITOR_THINKING_LEVEL=low` reduces token consumption for reasoning models.
- **The rejection cap bounds retry cost automatically** — each `update_goal` call spawns a fresh, full-cost auditor session, and nothing previously stopped an executor from re-triggering one immediately after every rejection. After `maxConsecutiveAuditRejections` (default 3) rejections with no other tool call in between, the goal pauses instead of leaving `update_goal` immediately callable again; any real tool call between rejections resets the count, so this only catches a stuck or looping executor, not ordinary multi-attempt iteration. Tunable via the config file / env (see the tables above).

Example — use Haiku for auditing while the executor runs on Sonnet:

```bash
export PI_GOAL_AUDITOR_PROVIDER=anthropic
export PI_GOAL_AUDITOR_MODEL=claude-haiku-4-5-20251001
export PI_GOAL_AUDITOR_THINKING_LEVEL=low
```

## Timeout

Two independent backstops bound an audit, both fail-closed (they return disapproval and abort the underlying session):

- **Idle/liveness timeout — `idleTimeoutMs`, default 2 minutes.** This is the *primary* "is it hung" detector. It arms on the auditor's first streamed output and resets on every subsequent one, so a slow-but-still-producing model (a local model at a few tokens/sec) never trips it — only a session that has genuinely gone silent does. Because it arms on the first output, first-token / cold-load latency is bounded by the absolute cap below, not by this.
- **Absolute wall-clock timeout — `timeoutMs`, default 15 minutes** (was a fixed 5 min). The outer bound: it catches a session that keeps *talking* forever (looping) without ever going idle, which the idle timeout can't see. Set higher on a slow machine, or to `0` to disable the absolute cap and rely on the idle timeout + abort alone.

Set either (or both) to `0` to disable that one. Disabling both means only user-cancel (abort) bounds an audit.

If the auditor's first response doesn't end with a parseable `<approved/>`/`<disapproved/>` verdict (and no error occurred), it gets exactly one reminder prompt in the same session before falling back to disapproval — this retry happens within the same timeout budgets, not in addition to them, and its output resets the idle timer like any other, so a genuinely working retry isn't cut off.

## Abort Behavior

If the user cancels the Pi session (Ctrl+C / Esc) while the auditor is running, the abort signal propagates to the auditor session, stopping it. The goal remains in its current state (not completed).
