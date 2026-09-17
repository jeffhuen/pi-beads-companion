export const POLICY_MARKER = "<!-- pi-beads-companion:policy v1 -->";
export const BLOCK_START = "<!-- BEGIN PI-BEADS-COMPANION -->";
export const BLOCK_END = "<!-- END PI-BEADS-COMPANION -->";

export const AGENTS_BLOCK = `${BLOCK_START}\n## Beads companion\n\nUse native harness todos and subagents for execution. Beads holds durable outcomes and compact recovery checkpoints, not every execution step. Read the project workflow with \`bd prime\`. One coordinator owns status updates unless ownership transfers explicitly. Helpers report back; lifecycle events do not close issues. Keep official Herdr integrations separate.\n${BLOCK_END}\n`;
