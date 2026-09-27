import type { PluginContext } from "@frogg/plugin-api";

interface PinParams {
  agentId: string;
}

interface Note {
  agentId: string;
  title: string;
  pinnedAt: string;
}

function isPinParams(value: unknown): value is PinParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentId" in value &&
    typeof value.agentId === "string"
  );
}

function isNoteList(value: unknown): value is Note[] {
  return Array.isArray(value);
}

export default function activate(ctx: PluginContext): void {
  async function readNotes(): Promise<Note[]> {
    const stored = await ctx.settings.get("notes");
    return isNoteList(stored) ? stored : [];
  }

  ctx.rpc.handle("example.session-notes.pin", async function pin(params: unknown) {
    if (!isPinParams(params)) {
      throw new Error("expected { agentId: string }");
    }
    const agent = await ctx.agents.get(params.agentId);
    const notes = await readNotes();
    notes.push({
      agentId: params.agentId,
      title: agent?.title ?? params.agentId,
      pinnedAt: new Date().toISOString(),
    });
    await ctx.settings.set("notes", notes);
    ctx.ui.setBadge("notes", String(notes.length));
    return { count: notes.length };
  });

  ctx.rpc.handle("panel.notes.render", async function render() {
    const heading = await ctx.settings.get("heading");
    const notes = await readNotes();
    const lines = notes.map((note) => `- **${note.title}** (${note.pinnedAt})`);
    return {
      kind: "markdown",
      markdown: [`## ${typeof heading === "string" ? heading : "Pinned notes"}`, ...lines].join(
        "\n",
      ),
    };
  });
}
