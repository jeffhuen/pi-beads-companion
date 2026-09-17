import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCompanion } from "./companion.js";

export default function beadsCompanion(pi: ExtensionAPI): void {
  const companion = createCompanion({
    exec: (command, args, options) => pi.exec(command, args, options),
    appendEntry: (type, data) => pi.appendEntry(type, data),
    canWrite: () => pi.getActiveTools().includes("bash") && process.env.PI_BEADS_COMPANION_READONLY !== "1",
  });

  pi.registerCommand("beads", {
    description: "Beads context: status, use <id>, clear, refresh, checkpoint <text>",
    handler: async (args, ctx) => {
      let content: string;
      try { content = await companion.command(args, ctx); }
      catch (error) { content = `Beads companion: ${error instanceof Error ? error.message : String(error)}`; }
      pi.sendMessage({ customType: "beads-companion", content, display: true }, { triggerTurn: false });
    },
  });

  pi.on("session_start", (_event, ctx) => companion.restore(ctx));
  pi.on("session_tree", (_event, ctx) => companion.restore(ctx));
  pi.on("session_shutdown", () => companion.invalidate());
  pi.on("session_compact", () => companion.invalidate());
  pi.on("before_agent_start", async (event, ctx) => {
    const context = await companion.context(ctx);
    if (context) return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
  });
}
