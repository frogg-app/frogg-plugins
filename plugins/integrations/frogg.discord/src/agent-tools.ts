// Read-only agent tools (`contributes.agentTools`): agents on this host can list the configured
// channels and read their recent history through the Frogg MCP server, without ever seeing the
// bot token. Scope is the configured server, the agents channel, the extra command channels and
// threads under them; nothing else is reachable.
import type { DiscordConfig } from "./config.ts";

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 100;
const CONTENT_MAX = 4000;
const SNOWFLAKE = /^\d{17,20}$/;

export interface HistoryArgs {
  channelId: string;
  limit: number;
  before?: string;
  after?: string;
}

export class AgentToolError extends Error {}

/** Validates `read_channel_history` input; the channel defaults to the agents channel. */
export function parseHistoryArgs(raw: unknown, config: Pick<DiscordConfig, "channelId">): HistoryArgs {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const id = (key: string): string | undefined => {
    const v = input[key];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || !SNOWFLAKE.test(v.trim())) throw new AgentToolError(`${key} must be a Discord id`);
    return v.trim();
  };
  const channelId = id("channelId") ?? config.channelId;
  const before = id("before");
  const after = id("after");
  if (before && after) throw new AgentToolError("Pass before or after, not both");
  const rawLimit = input.limit;
  let limit = HISTORY_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1)
      throw new AgentToolError(`limit must be an integer from 1 to ${HISTORY_MAX_LIMIT}`);
    limit = Math.min(rawLimit, HISTORY_MAX_LIMIT);
  }
  return { channelId, limit, ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** What the scope check needs to know about a fetched channel. */
export interface ChannelFacts {
  id: string;
  guildId: string | null;
  /** Parent channel for threads; null otherwise. */
  parentId: string | null;
  isThread: boolean;
}

export function allowedChannelIds(config: Pick<DiscordConfig, "channelId" | "extraChannelIds">): Set<string> {
  return new Set([config.channelId, ...config.extraChannelIds]);
}

/** The configured server's agents channel, extra command channels, or a thread under one. */
export function isReadableChannel(
  channel: ChannelFacts,
  config: Pick<DiscordConfig, "guildId" | "channelId" | "extraChannelIds">,
): boolean {
  if (channel.guildId !== config.guildId) return false;
  const allowed = allowedChannelIds(config);
  if (allowed.has(channel.id)) return true;
  return channel.isThread && channel.parentId !== null && allowed.has(channel.parentId);
}

/** The slice of a discord.js Message the projection reads. */
export interface MessageLike {
  id: string;
  content: string;
  createdTimestamp: number;
  editedTimestamp: number | null;
  author: { id: string; username: string; globalName?: string | null; bot: boolean };
  member?: { displayName?: string } | null;
  attachments: { values(): Iterable<{ name: string; url: string; contentType?: string | null; size: number }> };
  embeds: readonly { title?: string | null; description?: string | null }[];
  reference?: { messageId?: string } | null;
  thread?: { id: string } | null;
}

export interface HistoryMessage {
  id: string;
  createdAt: string;
  editedAt: string | null;
  author: { id: string; name: string; bot: boolean };
  content: string;
  attachments: { name: string; url: string; contentType: string | null; size: number }[];
  embeds: { title: string | null; description: string | null }[];
  replyTo: string | null;
  threadId: string | null;
}

export function toHistoryMessage(m: MessageLike): HistoryMessage {
  const content = m.content.length > CONTENT_MAX ? `${m.content.slice(0, CONTENT_MAX)}…` : m.content;
  return {
    id: m.id,
    createdAt: new Date(m.createdTimestamp).toISOString(),
    editedAt: m.editedTimestamp ? new Date(m.editedTimestamp).toISOString() : null,
    author: { id: m.author.id, name: m.member?.displayName ?? m.author.globalName ?? m.author.username, bot: m.author.bot },
    content,
    attachments: [...m.attachments.values()].map((a) => ({
      name: a.name,
      url: a.url,
      contentType: a.contentType ?? null,
      size: a.size,
    })),
    embeds: m.embeds.map((e) => ({ title: e.title ?? null, description: e.description ?? null })),
    replyTo: m.reference?.messageId ?? null,
    threadId: m.thread?.id ?? null,
  };
}

/**
 * Messages from other users come back with empty content when the bot lacks the privileged
 * Message Content intent; say so instead of leaving the agent guessing.
 */
export function contentHint(messages: readonly HistoryMessage[], botUserId: string | null): string | null {
  const others = messages.filter((m) => m.author.id !== botUserId);
  if (others.length === 0) return null;
  const blank = others.every((m) => !m.content && m.attachments.length === 0 && m.embeds.length === 0);
  return blank
    ? "Message text is empty: enable the Message Content intent for the bot in the Discord Developer Portal."
    : null;
}

export const AGENT_TOOL_IDS = { listChannels: "list_channels", history: "read_channel_history" } as const;
