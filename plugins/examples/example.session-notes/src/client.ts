import type { ClientPluginContext } from "@frogg/plugin-api";

// Client half: answers the session action in the app, forwards it to the daemon half, and
// confirms with a toast from this device.
export default function activate(ctx: ClientPluginContext): void {
  ctx.rpc.handle("example.session-notes.pin", async (params) => {
    const result = (await ctx.rpc.call("example.session-notes.pin", params)) as { count: number };
    ctx.ui.notify(`Pinned from this device (${result.count} notes)`, "success");
    return result;
  });
}
