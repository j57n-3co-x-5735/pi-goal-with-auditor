# Why This Fork Exists

This is a fork of [PurpleMyst/pi-goal](https://github.com/PurpleMyst/pi-goal) with one addition: an independent completion auditor that verifies goal completion before accepting it.

## The Problem With Self-Grading

In the upstream pi-goal, the executor agent decides when a goal is complete. It calls `update_goal({status: "complete"})` and the state machine transitions to idle — no questions asked. The continuation prompt includes a self-audit checklist ("restate the objective as concrete deliverables," "inspect the relevant files"), but the model grading the work is the same model that did the work. The judge and the executor are the same entity.

This creates a structural failure mode: the agent can mark a goal complete based on intent, partial progress, elapsed effort, or proxy signals (tests passing, files existing) without the objective actually being satisfied. The self-audit checklist mitigates this somewhat, but it's still a model evaluating its own output — a known weakness in LLM systems.

## The Fix: Separate the Judge From the Executor

This fork adds an independent auditor — a separate Pi agent session that has no access to the executor's conversation history, no shared context, and its own system prompt that instructs it to be skeptical. When the executor claims completion, the auditor spawns, inspects the actual workspace (reads files, runs scripts, greps for evidence), and renders a binding verdict.

The auditor is authoritative. If it says `<disapproved/>`, the goal stays active and the executor receives the objections. The executor cannot override the auditor.

## Why PurpleMyst's Architecture, Not Capyup's

There are two pi-goal implementations with auditing capabilities:

| | PurpleMyst/pi-goal | capyup/pi-goal |
|---|---|---|
| State storage | Session JSONL (`appendEntry`) | Filesystem (`.pi/goals/` directory + ledger) |
| State reconstruction | Scan session entries (last-write-wins) | Read/write goal files, reconcile memory vs disk |
| Complexity | ~360 lines across 7 files | ~2400 lines across 16 files |
| Auditor | None (added by this fork) | Built-in, with ledger integration |

Capyup's auditor is more featureful — it has a file-based config, a ledger that tracks audit history, rejection feedback injected into subsequent system prompts, and a sisyphus mode for step-by-step execution. But its state management is significantly more complex: goals are written to disk as files, reconciled between memory and disk on every operation, merged on session resume, and archived on completion.

PurpleMyst's architecture is simpler and cleaner. All state lives in the session JSONL — the same append-only log that Pi uses for everything else. No filesystem access, no file reconciliation, no disk-memory divergence. The tradeoff is less functionality, but the code is easier to understand, modify, and verify.

This fork grafts capyup's auditor concept onto PurpleMyst's clean session-based architecture with a deliberately small footprint: two new files (`goal_auditor.ts`, `goal_config.ts`) plus focused edits to four existing ones (`extension.ts` for the auditor integration and loop handling, `goal_state.ts`/`goal_state_machine.ts` for the new counters and `nextLoopStep`, and `prompts.ts` for control-char stripping and the empty-turn nudge). The session-based state model itself is untouched.

## What This Fork Adds

1. **Independent auditor session** — spawned via `createAgentSession` with `SessionManager.inMemory`, a read-only-by-convention tool set (`bash` itself isn't sandboxed — pi has no built-in sandbox for any session, by design; see `docs/architecture.md`'s Limitations section), no extensions
2. **`<approved/>`/`<disapproved/>` decision protocol** — machine-parseable, fail-closed, with an **evidence-backed-approval guard**: an approval is only honored if the auditor actually ran at least one **successful tool call** (any of `read`/`grep`/`find`/`ls`/`bash`) in its session — an `<approved/>` backed by nothing, or by only failed calls, is downgraded to disapproval. This closes the silent fail-open where a too-weak auditor model rubber-stamps work it never touched. Asymmetric (only approvals are gated) and deliberately honest about its limit: it guarantees the auditor *ran a tool*, not that it *inspected the right content* (a no-op `bash true` or an unrelated `read` still count) — that ceiling is the auditor's model, made visible by naming the model in the verdict (item 17). Counting *any* successful tool (rather than a "content" subset) is intentional: for existence/absence/structure objectives `find`/`ls` is the correct verification, so a subset would false-reject legitimate approvals and still be bypassable via `bash ls`
3. **Configurable auditor model** — env vars (`PI_GOAL_AUDITOR_PROVIDER`, `PI_GOAL_AUDITOR_MODEL`, `PI_GOAL_AUDITOR_THINKING_LEVEL`) let you point the auditor at a cheaper model
4. **Abort signal wiring** — cancelling the parent turn cancels the auditor
5. **Dual timeout (idle + absolute)** — an idle/liveness timeout (default 2 min of silence) is the primary hang detector and never kills a slow-but-producing model, plus a configurable absolute cap (default 15 min) bounds a looping one; both are configurable (see [Auditor Configuration](auditor-configuration.md))
6. **Sequential tool-call dispatch guard** — `get_goal` and `update_goal` declare `executionMode: "sequential"`, so a duplicated or hedged `update_goal` call from the executor LLM in one turn can't run concurrently with another `update_goal` (or `get_goal`) call under the host's default parallel tool-call dispatch
7. **State freshness check** — re-reads goal state after the audit and now compares objective identity (text + start timestamp), not just phase, to prevent a goal cleared-and-replaced with a different one during the audit from being completed on a stale approval, in addition to the original concurrent-pause/clear protection
8. **Prompt injection defense** — strips control and bidi-override characters, then XML-escapes the objective and completion summary before embedding them in the auditor prompt (the shared `escapeXML` function, also used by the upstream continuation prompt), and the prompt itself now explicitly frames both fields as data to verify, not instructions to follow — escaping alone stops structural injection but not a model being talked into a verdict by content it's asked to evaluate, so this is a disclosed, partial mitigation, not a claim of immunity
9. **Evidence-trust steering** — the auditor prompt explicitly weights directly-executed checks (running tests, diffing against git, executing the build) over narrative claims in files it reads, since the executor had full write access to the same workspace moments before
10. **Evidence-before-verdict requirement** — the auditor must account, per stated requirement, for what it checked and whether the check was direct or indirect before it may conclude, must treat a green test/build/status check as proof only of what it actually covers (not of the requirement it's being cited for), and must run a self-test asking whether a skeptical outside reviewer would reach the same verdict from that account alone
11. **Terminal-verdict parsing contract, with a bounded reminder retry** — the auditor's decision is read only from the final non-empty line of its response, tolerant of a missing trailing slash, internal whitespace, or common markdown emphasis wrapping, but deliberately not of a leading slash (which would readmit a closing-tag false approval) or a code fence around the verdict. That strictness has a real false-rejection cost, so if the first response produces neither tag as the terminal line, the auditor gets exactly one more bounded chance — a reminder prompt in the same session, racing the same timeout/abort as the original attempt — before falling back to fail-closed
12. **Robust abort and timeout handling** — cancellation is settled by a dedicated promise the moment the signal fires, rather than assuming `session.abort()` alone unblocks the auditor's in-flight prompt; both the idle and absolute timeouts also abort the underlying session instead of leaving it to run in the background; the session is disposed and both timers cleared on every exit path
13. **Bounded consecutive-rejection cap** — three `update_goal` rejections in a row with no intervening tool call pauses the goal instead of leaving it immediately re-callable forever; any real tool call between rejections resets the streak, so legitimate multi-attempt iteration is never penalized, only a stuck or looping executor
14. **Compaction left at the SDK default (enabled)** — the auditor session previously disabled compaction on the theory that summarizing older exploration was its own fail-open risk; left disabled, it instead meant any repository large enough for the auditor's own exploration to exceed context would fail closed on every audit, indistinguishable from a genuine disapproval. Compaction preserves recent context and cumulative file-tracking rather than blindly truncating, and the auditor can always re-read or re-run anything it needs afterward — the same trust the executor's own session already extends to it
15. **Weak-model-tolerant loop continuation** — the goal loop no longer pauses on the first agent cycle that makes no tool call. A single text-only turn (a clarifying question, a plan, reasoning) is treated as deliberation, not a stall: the agent is nudged to take a concrete action and the loop continues, pausing only after `PI_GOAL_MAX_EMPTY_CONTINUATIONS` (default 3) consecutive empty cycles. The original pause-on-first-empty behavior permanently killed the loop for small local models (e.g. LFM 1.2B) that produce a text-only turn on nearly every step, defeating the extension's purpose for exactly the cheap models it's meant to support. Set the env var to 1 to restore the strict behavior. An empty cycle caused by a model *error* rather than deliberation (most often a context-window overflow: `stopReason "error"`) is handled distinctly — it's continued with a plain prompt instead of the "act, don't describe" nudge (which would only enlarge an already-overflowing prompt), and it's tracked separately (`erroredContinuations`) so that when the loop does pause, the message names the likely model/context cause instead of misreporting a work stall
16. **Single config file** — one global `goal-auditor.json` (in the pi agent dir) exposes every knob — auditor model, timeout, loop-stall cap, rejection cap — in one visible place, with env vars still overriding it for ad-hoc runs. See [Auditor Configuration](auditor-configuration.md)
17. **Auditor model surfaced in the verdict** — the completion and rejection text name the model that rendered the verdict (`Auditor (lmstudio/liquid/lfm2.5-1.2b): …`). The evidence guard removes the "approved having run nothing" fail-open but can't catch a weak model that runs a tool then misjudges; making the model visible is what lets a human catch *that*, and the consecutive-rejection pause message points at the auditor-config possibility so the human's next move (fix the auditor vs. do more work) is guided
18. **Dependency pinning** — all dev dependencies pinned to exact versions

## What This Fork Does NOT Add

- No goal **state** on disk — no ledger, event log, or per-goal files. All *state* lives in the session JSONL; the one `goal-auditor.json` is *configuration*, not state, and is only ever read (never written), following pi's own documented per-extension config pattern. This is the line the fork holds: config in, state stays in the session.
- No auditor rejection *content* memory across turns — a consecutive-rejection *count* is tracked (item 13 above), but the rejection text itself is never re-injected into a subsequent system prompt
- No new state phases
- No sisyphus mode
- No goal file management

These are deliberate exclusions, not missing features. The upstream's session-based architecture is the constraint that makes the code simple, and this fork respects that constraint — a read-only config file doesn't compromise it (the complexity the "no files" rule guards against was disk-backed *state*, not a settings file).
