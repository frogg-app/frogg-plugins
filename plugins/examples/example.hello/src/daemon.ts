import type { PluginContext } from "@frogg/plugin-api";

export default function activate(ctx: PluginContext): void {
  ctx.rpc.handle("example.hello.greet", async function greet() {
    const agents = await ctx.agents.list();
    const message = `Hello from ${ctx.plugin.id} ${ctx.plugin.version}: ${agents.length} agent(s) on this host`;
    ctx.ui.notify(message);
    return { message };
  });
  ctx.log.info("example.hello activated");
}

export function deactivate(): void {}
