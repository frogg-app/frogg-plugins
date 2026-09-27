import type { ClientPluginContext } from "@frogg/plugin-api";

// Client-scope plugin: runs sandboxed in the app on each device that installs it, no daemon half.
export default function activate(ctx: ClientPluginContext): void {
  ctx.rpc.handle("example.clock.now", async () => {
    const asked = (((await ctx.settings.get("asked")) as number | undefined) ?? 0) + 1;
    await ctx.settings.set("asked", asked);
    ctx.ui.notify(`It is ${new Date().toLocaleTimeString()} (asked ${asked} times)`, "success");
    return { asked };
  });
}
