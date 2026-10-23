# Changelog

## 0.1.0 — 2026-10-23

First public release.

- Request router: jev (Haiku) picks effort, model (Sonnet or Opus, never down within a session) and working mode for each request, with `#max`, `#fast`, `#opus` and `#sonnet` overrides.
- Live pane: the lead, the advisor's checkpoints, jev's decisions, the latest subagents, quota and per-turn usage.
- History across sessions (7 days / all): decisions, advisor consults and subagent runs.
- Settings: `routing`, `jevModel`, `panel`, `retryConsult` (off by default).
