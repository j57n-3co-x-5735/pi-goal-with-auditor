# pi-goal-with-auditor

A fork of [PurpleMyst/pi-goal](https://github.com/PurpleMyst/pi-goal) that adds an independent completion auditor. The executor agent can no longer unilaterally mark a goal complete — an isolated auditor session inspects the workspace and renders a binding verdict first.

See [docs/why-this-fork.md](docs/why-this-fork.md) for why this fork exists and how it compares to other pi-goal implementations.

## Installation

```bash
pi install git:github.com/j57n-3co-x-5735/pi-goal-with-auditor
```

For privacy-conscious installation (manual clone, no unnecessary network requests), see [docs/installation.md](docs/installation.md).

## Usage

- `/goal <GOAL>` — set a goal for the agent (session-scoped, persisted in session JSONL)
- `/goal pause` — pause the current goal
- `/goal resume` — resume a paused goal
- `/goal clear` — clear the current goal
- `/goal` — show current goal status

The goal also pauses itself automatically (with a warning) in two cases: after several consecutive agent cycles that make **no** tool call (a genuine stall — the default is 3, set `PI_GOAL_MAX_EMPTY_CONTINUATIONS` to tune it), or after 3 consecutive auditor rejections with no other tool call in between (guards against burning repeated audits on a stuck or looping executor). A single text-only turn does **not** pause the loop — the agent is nudged to take a concrete action and the loop continues, which matters for small local models that often deliberate in prose before acting. Use `/goal resume` to continue after a pause.

When the agent calls `update_goal({status: "complete"})`, an independent auditor session spawns automatically. The auditor:

- Runs in an isolated, in-memory Pi session with a read-only-by-convention tool set (`bash` itself isn't sandboxed — see [docs/architecture.md](docs/architecture.md#limitations--quirks))
- Has no access to the executor's conversation history or extensions
- Inspects the actual workspace (reads files, runs scripts, greps for evidence)
- Renders a binding `<approved/>` or `<disapproved/>` verdict, with one bounded retry if its first response doesn't end with a parseable verdict
- On disapproval, error, or timeout, the goal stays active — after 3 consecutive rejections with no other tool call in between, it pauses instead

## Auditor Configuration

All options live in one global config file, `goal-auditor.json`, in the pi agent dir (`~/.pi/agent/`) — the auditor model, the timeout, and the loop safety caps. Every key is optional and falls back to a default; env vars override the file for one-off runs.

```json
{
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001",
  "thinkingLevel": "low",
  "timeoutMs": 900000,
  "maxEmptyContinuations": 3,
  "maxConsecutiveAuditRejections": 3
}
```

The auditor model defaults to the host session's model — point it at a cheaper model here (and note: a too-weak auditor is a weak gate, so on a small local host model set `model` to something more capable). See [docs/auditor-configuration.md](docs/auditor-configuration.md) for every key, the env-var overrides, and precedence.

## Documentation

- [Architecture](docs/architecture.md) — system overview, state machine, file map, auditor isolation details
- [Why This Fork](docs/why-this-fork.md) — comparison with upstream and capyup, design decisions
- [Auditor Configuration](docs/auditor-configuration.md) — the config file, all keys, env overrides, cost management
- [Installation](docs/installation.md) — standard and privacy-conscious installation methods

## Credits

- [PurpleMyst/pi-goal](https://github.com/PurpleMyst/pi-goal) for the upstream session-based architecture
- [capyup/pi-goal](https://github.com/capyup/pi-goal) for the `createAgentSession`-based auditor pattern
- [OpenAI Codex](https://github.com/openai/codex) for the original goal/continuation pattern
- Geoffrey Huntley's [Ralph Wiggum](https://ghuntley.com/ralph/) for the general autonomous agent loop concept

## License

ISC
