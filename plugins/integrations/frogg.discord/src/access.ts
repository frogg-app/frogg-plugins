// Who may drive Frogg from Discord. Pure: every interaction and forwarded message passes
// checkAccess, and every write additionally needs the host's remote-control switch.
import type { DiscordConfig } from "./config.ts";

export interface AccessRequest {
  guildId: string | null;
  channelId: string | null;
  /** Parent channel when `channelId` is a thread. */
  parentChannelId: string | null;
  userId: string;
}

export type AccessResult = { ok: true } | { ok: false; reason: string };

export function checkAccess(
  config: Pick<DiscordConfig, "guildId" | "channelId" | "allowedUserIds" | "extraChannelIds">,
  req: AccessRequest,
): AccessResult {
  if (req.guildId !== config.guildId) {
    return { ok: false, reason: "This bot only answers in its configured server." };
  }
  const allowedChannel = (id: string | null) =>
    id !== null && (id === config.channelId || config.extraChannelIds.has(id));
  if (!allowedChannel(req.channelId) && !allowedChannel(req.parentChannelId)) {
    return { ok: false, reason: "Commands aren't enabled in this channel." };
  }
  if (!config.allowedUserIds.has(req.userId)) {
    return { ok: false, reason: "You're not on this Frogg host's allowlist." };
  }
  return { ok: true };
}

export const REMOTE_CONTROL_OFF =
  "Remote control is off for this plugin on the Frogg host, so Discord is read-only. " +
  "The host owner can enable it with `frogg plugins remote-control frogg.discord on`.";

/** Reads the host flag at call time; the host may flip it while the plugin runs. */
export function remoteControlEnabled(host: { remoteControl?: boolean } | undefined): boolean {
  return host?.remoteControl === true;
}

/** Maps host errors (PluginServiceError carries `code`) to a message for the Discord user. */
export function explainError(err: unknown): string {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : null;
  if (code === "forbidden") return REMOTE_CONTROL_OFF;
  if (code === "already_resolved") return "That request was already answered elsewhere.";
  if (code === "not_found") return "That agent or item no longer exists.";
  const message = err instanceof Error ? err.message : String(err);
  return `Frogg refused: ${message.slice(0, 300)}`;
}
