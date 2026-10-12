// Settings page values -> a validated config. Pure; the settings keys are declared in
// frogg-plugin.json `contributes.settings`.

export const ARCHIVE_MINUTES = [60, 1440, 4320, 10080] as const;
export type ArchiveMinutes = (typeof ARCHIVE_MINUTES)[number];

export interface DiscordConfig {
  botToken: string;
  guildId: string;
  /** Text or forum channel that gets one thread per agent. */
  channelId: string;
  /** Discord user ids allowed to run commands and press buttons. Empty denies everyone. */
  allowedUserIds: ReadonlySet<string>;
  /** Further channels (and their threads) where commands are accepted. */
  extraChannelIds: ReadonlySet<string>;
  /** Users pinged on alerts. */
  mentionUserIds: readonly string[];
  /** "all": every agent that starts running gets a thread. "discord": only agents started from Discord. */
  threads: "all" | "discord";
  /** Alert even while a Frogg app is in active use (push notifications are suppressed then). */
  alertWhenAppActive: boolean;
  /** Forward plain messages in agent threads (needs the Message Content intent). */
  readThreadMessages: boolean;
  showToolCalls: boolean;
  presence: boolean;
  archiveMinutes: ArchiveMinutes;
}

export type ConfigResult = { ok: true; config: DiscordConfig } | { ok: false; missing: string[] };

const SNOWFLAKE = /^\d{17,20}$/;

/** Splits a comma/space/newline separated list and keeps only valid Discord ids. */
export function parseIdList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const ids = value
    .split(/[\s,;]+/)
    .map((s) => s.trim().replace(/^<@!?|^<#|>$/g, ""))
    .filter((s) => SNOWFLAKE.test(s));
  return [...new Set(ids)];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readConfig(raw: Record<string, unknown>): ConfigResult {
  const botToken = str(raw.botToken);
  const guildId = str(raw.guildId);
  const channelId = str(raw.channelId);
  const allowedUserIds = parseIdList(raw.allowedUserIds);

  const missing: string[] = [];
  if (!botToken) missing.push("botToken");
  if (!SNOWFLAKE.test(guildId)) missing.push("guildId");
  if (!SNOWFLAKE.test(channelId)) missing.push("channelId");
  if (allowedUserIds.length === 0) missing.push("allowedUserIds");
  if (missing.length) return { ok: false, missing };

  const archive = Number(raw.threadArchiveMinutes);
  return {
    ok: true,
    config: {
      botToken,
      guildId,
      channelId,
      allowedUserIds: new Set(allowedUserIds),
      extraChannelIds: new Set(parseIdList(raw.extraChannelIds)),
      mentionUserIds: parseIdList(raw.mentionUserIds),
      threads: raw.threads === "discord" ? "discord" : "all",
      alertWhenAppActive: bool(raw.alertWhenAppActive, false),
      readThreadMessages: bool(raw.readThreadMessages, false),
      showToolCalls: bool(raw.showToolCalls, true),
      presence: bool(raw.presence, true),
      archiveMinutes: (ARCHIVE_MINUTES as readonly number[]).includes(archive)
        ? (archive as ArchiveMinutes)
        : 1440,
    },
  };
}
