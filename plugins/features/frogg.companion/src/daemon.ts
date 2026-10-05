import type { PluginContext } from "@frogg/plugin-api";

// The Companion ships with Frogg; this plugin is its opt-in. While it is installed and enabled,
// the host turns on the built-in Companion (`contributes.features`), so there is nothing to run.
export default function activate(ctx: PluginContext): void {
  ctx.log.info("Companion enabled on this host");
}
