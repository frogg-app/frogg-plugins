// frogg.discord daemon entry: owns the Discord gateway connection and restarts it whenever the
// settings change. Outbound only (Gateway WebSocket + REST), so hosts behind NAT need no port.
import { Client, Events, GatewayIntentBits } from "discord.js";
import type { PluginContext } from "@frogg/plugin-api";
import { readConfig, type DiscordConfig } from "./config.ts";
import { remoteControlEnabled } from "./access.ts";
import { FroggToDiscord } from "./bridge.ts";
import { FROGG_COMMAND } from "./commands.ts";
import { KeyedDebouncer } from "./debounce.ts";
import { inviteUrl } from "./format.ts";
import { DiscordToFrogg, forwardBacklog } from "./interactions.ts";
import { StateStore } from "./state.ts";

type Phase =
  | { kind: "unconfigured"; missing: string[] }
  | { kind: "connecting" }
  | { kind: "connected"; botTag: string; applicationId: string }
  | { kind: "error"; message: string; applicationId?: string };

interface Running {
  client: Client;
  bridge: FroggToDiscord | null;
}

const DISALLOWED_INTENTS = 4014;
const AUTH_FAILED = 4004;

export default async function activate(ctx: PluginContext): Promise<void> {
  const state = StateStore.forDataDir(ctx.plugin.dataDir);
  await state.load();

  let phase: Phase = { kind: "connecting" };
  let running: Running | null = null;
  let config: DiscordConfig | null = null;

  const setPhase = (next: Phase) => {
    phase = next;
    ctx.ui?.refreshPanel("discord");
    ctx.ui?.setBadge("discord", next.kind === "connected" ? null : next.kind === "connecting" ? "…" : "!");
  };

  const stop = async () => {
    const r = running;
    running = null;
    if (!r) return;
    r.bridge?.stop();
    await r.client.destroy().catch(() => undefined);
    await state.flush();
  };

  const start = async () => {
    await stop();
    const result = readConfig(await ctx.settings.all());
    if (!result.ok) {
      config = null;
      setPhase({ kind: "unconfigured", missing: result.missing });
      ctx.log.info("discord: not configured", { missing: result.missing });
      return;
    }
    const cfg = result.config;
    config = cfg;
    setPhase({ kind: "connecting" });

    const intents = [GatewayIntentBits.Guilds];
    if (cfg.readThreadMessages) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    const client = new Client({ intents });
    const r: Running = { client, bridge: null };
    running = r;

    client.once(Events.ClientReady, async (ready) => {
      if (running !== r) return;
      try {
        const guild = await ready.guilds.fetch(cfg.guildId).catch(() => null);
        if (!guild) {
          // Finish starting as soon as someone uses the invite link.
          client.on(Events.GuildCreate, (g) => {
            if (g.id === cfg.guildId && running === r) restarts.schedule("restart");
          });
          setPhase({
            kind: "error",
            message: "The bot isn't in the configured server yet. Invite it with the link below.",
            applicationId: ready.application.id,
          });
          return;
        }
        await ready.application.commands.set([FROGG_COMMAND], cfg.guildId);
        const bridge = new FroggToDiscord(ctx, ready, cfg, state);
        const inbound = new DiscordToFrogg(ctx, cfg, bridge, state);
        r.bridge = bridge;
        client.on(Events.InteractionCreate, (i) => {
          inbound.onInteraction(i).catch((err) => ctx.log.warn("discord: interaction failed", { error: String(err) }));
        });
        if (cfg.readThreadMessages) {
          client.on(Events.MessageCreate, (m) => {
            inbound.onMessage(m).catch((err) => ctx.log.warn("discord: message failed", { error: String(err) }));
          });
        }
        await bridge.start();
        if (cfg.readThreadMessages) await forwardBacklog(inbound, client, state, cfg.channelId, ctx.log);
        setPhase({ kind: "connected", botTag: ready.user.tag, applicationId: ready.application.id });
        ctx.log.info("discord: connected", { bot: ready.user.tag, guild: guild.name });
      } catch (err) {
        ctx.log.error("discord: startup failed", { error: String(err) });
        setPhase({ kind: "error", message: String(err), applicationId: ready.application.id });
      }
    });
    client.on(Events.Error, (err) => ctx.log.warn("discord: client error", { error: String(err) }));

    try {
      await client.login(cfg.botToken);
    } catch (err) {
      if (running !== r) return;
      const code = (err as { code?: unknown }).code;
      const message =
        code === DISALLOWED_INTENTS
          ? "Discord refused the Message Content intent. Enable it for the bot in the Developer Portal, or turn off \"Read thread messages\"."
          : code === AUTH_FAILED || code === "TokenInvalid"
            ? "Discord rejected the bot token."
            : String(err);
      ctx.log.error("discord: login failed", { error: String(err) });
      setPhase({ kind: "error", message });
      await stop();
    }
  };

  const restarts = new KeyedDebouncer<"restart">({
    delayMs: 1500,
    maxWaitMs: 5000,
    run: () => start(),
    onError: (_k, err) => ctx.log.error("discord: restart failed", { error: String(err) }),
  });

  ctx.settings.onChange(() => restarts.schedule("restart"));
  const remoteWatch = ctx.host?.onRemoteControlChange?.(() => ctx.ui?.refreshPanel("discord"));

  ctx.rpc?.handle("panel.discord.render", () => ({ kind: "markdown", markdown: panelMarkdown(phase, config, ctx) }));
  ctx.rpc?.handle("discord.reconnect", async () => {
    await start();
    ctx.ui?.notify(phase.kind === "connected" ? "Discord reconnected" : "Discord: see the Discord panel", phase.kind === "connected" ? "success" : "warning");
    return { phase: phase.kind };
  });

  ctx.signal.addEventListener("abort", () => {
    restarts.stop();
    remoteWatch?.dispose();
    void stop();
  });

  // Don't block activation on Discord's handshake.
  void start().catch((err) => ctx.log.error("discord: start failed", { error: String(err) }));
}

function panelMarkdown(phase: Phase, config: DiscordConfig | null, ctx: PluginContext): string {
  const lines: string[] = ["## Discord"];
  switch (phase.kind) {
    case "unconfigured":
      lines.push(`Not configured. Fill in these settings: ${phase.missing.map((k) => `\`${k}\``).join(", ")}.`);
      lines.push("", "See the plugin README for creating the bot application.");
      break;
    case "connecting":
      lines.push("Connecting…");
      break;
    case "connected":
      lines.push(`Connected as **${phase.botTag}**.`);
      break;
    case "error":
      lines.push(`**Not connected:** ${phase.message}`);
      break;
  }
  const appId = phase.kind === "connected" || phase.kind === "error" ? phase.applicationId : undefined;
  if (appId) lines.push("", `[Invite the bot to your server](${inviteUrl(appId, config?.guildId)})`);
  lines.push(
    "",
    remoteControlEnabled(ctx.host)
      ? "Remote control is **on**: allowlisted Discord users can start, stop and message agents, approve permissions and add to-dos."
      : "Remote control is **off**: Discord is read-only. Enable with `frogg plugins remote-control frogg.discord on`.",
  );
  if (config) {
    lines.push(
      "",
      `Allowlisted users: ${config.allowedUserIds.size} · Threads: ${config.threads === "all" ? "every agent" : "agents started from Discord"}`,
    );
  }
  return lines.join("\n");
}
