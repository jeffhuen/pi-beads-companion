# pi-beads-companion

This package connects native Pi and OMP sessions to Beads context and explicit recovery checkpoints. Keep the official Herdr integrations separate.

## Boundaries

- Use native harness planning and delegation. Beads records durable outcomes and compact checkpoints, not every todo transition.
- The coordinator owns issue status, integration, and cleanup unless explicitly transferred. Helpers report back.
- No automatic claims, closure, worker spawning, task mirroring, global configuration edits, compaction replacement, or publication.
- Keep native Pi and OMP entrypoints distinct. Share only host-independent Beads behavior. Do not import legacy compatibility shims.
- Preserve unrelated project instructions during explicit setup. Refuse ambiguous ownership rather than overwrite custom policy.

## Development

Run `npm ci`, `npm run check`, and `npm test`. Package verification uses `npm pack --dry-run`. Use native Node tests for behavioral regressions. Typecheck both pinned host SDKs and exercise real host loading after lifecycle changes.

Use `bd` directly for durable work. Record the execution outline before nontrivial changes and checkpoint verified progress, remaining work, and live resources. Do not claim a helper's completion proves acceptance.

Use the configured Codebase Memory tools for structural discovery and verify their coverage. Native source remains authoritative when the index is incomplete. Herdr-managed resource procedures live in `skill://herdr-workflow`; this package does not own those resources.

Do not push, publish, or install globally without authorization.

<!-- BEGIN PI-BEADS-COMPANION -->
## Beads companion

Use native harness plans, todos, memory, and subagents for execution. Beads holds durable outcomes, acceptance criteria, high-level plans, and recovery checkpoints, not every execution step. Small bounded work needs no new bead unless project rules require one. Choose worktrees separately for writer or branch isolation. Read the project workflow with `bd prime`. One coordinator owns bead updates and closure unless ownership transfers explicitly. For assigned bead-scoped work, verify acceptance, record final evidence, and close the bead within your authority before reporting it complete. Completed todos alone do not prove acceptance. Helpers report back; lifecycle events do not close issues. Keep official Herdr integrations separate.
<!-- END PI-BEADS-COMPANION -->
