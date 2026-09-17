import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createCompanion } from "./companion.js";

export default function beadsCompanion(omp: ExtensionAPI): void {
  const companion = createCompanion({
    exec: (command, args, options) => omp.exec(command, args, options),
    appendEntry: (type, data) => omp.appendEntry(type, data),
    canWrite: () => omp.getActiveTools().includes("bash") && process.env.PI_BEADS_COMPANION_READONLY !== "1",
  });

  omp.registerCommand("beads", {
    description: "Beads context: status, use <id>, clear, refresh, checkpoint <text>",
    handler: async (args, ctx) => {
      let content: string;
      try { content = await companion.command(args, ctx); }
      catch (error) { content = `Beads companion: ${error instanceof Error ? error.message : String(error)}`; }
      omp.sendMessage({ customType: "beads-companion", content, display: true }, { triggerTurn: false });
    },
  });

  omp.on("session_start", (_event, ctx) => companion.restore(ctx));
  omp.on("session_switch", (_event, ctx) => companion.restore(ctx));
  omp.on("session_branch", (_event, ctx) => companion.restore(ctx));
  omp.on("session_tree", (_event, ctx) => companion.restore(ctx));
  omp.on("session_shutdown", () => companion.invalidate());
  omp.on("session_compact", () => companion.invalidate());
  omp.on("before_agent_start", async (event, ctx) => {
    const context = await companion.context(ctx);
    if (context) return { systemPrompt: [...event.systemPrompt, context] };
  });
}
