// Registers the agent tools declared in frogg-plugin.json on the live Discord client. Read-only:
// no tool posts, edits or reacts, and none needs remote control.
import type { Client, Collection, Message } from "discord.js";
import type { PluginContext } from "@frogg/plugin-api";
import type { DiscordConfig } from "./config.ts";
import {
  AGENT_TOOL_IDS,
  AgentToolError,
  allowedChannelIds,
  contentHint,
  isReadableChannel,
  parseHistoryArgs,
  toHistoryMessage,
  type ChannelFacts,
} from "./agent-tools.ts";
import type { StateStore } from "./state.ts";

export interface LiveDiscord {
  client: Client<true>;
  config: DiscordConfig;
}

interface ChannelLike {
  id: string;
  name?: string | null;
  type: number;
  guildId?: string | null;
  parentId?: string | null;
  archived?: boolean | null;
  isThread(): boolean;
  isTextBased(): boolean;
  messages?: { fetch(o: { limit: number; before?: string; after?: string }): Promise<Collection<string, Message>> };
}

function facts(c: ChannelLike): ChannelFacts {
  return { id: c.id, guildId: c.guildId ?? null, parentId: c.parentId ?? null, isThread: c.isThread() };
}

export function registerAgentTools(
  ctx: PluginContext,
  state: StateStore,
  live: () => LiveDiscord | null,
): void {
  const require = (): LiveDiscord => {
    const l = live();
    if (!l) throw new AgentToolError("Discord is not connected on this host; see the Discord panel in Frogg.");
    if (!l.config.agentTools) throw new AgentToolError("The host owner turned off agent access to Discord.");
    return l;
  };

  const fetchReadable = async (l: LiveDiscord, id: string): Promise<ChannelLike> => {
    const channel = (await l.client.channels.fetch(id).catch(() => null)) as ChannelLike | null;
    if (!channel || !isReadableChannel(facts(channel), l.config))
      throw new AgentToolError(
        `Channel ${id} is not readable: agents can read the configured agents channel, the extra command channels and their threads.`,
      );
    return channel;
  };

  ctx.rpc.handle(`tool.${AGENT_TOOL_IDS.listChannels}`, async () => {
    const l = require();
    const guild = await l.client.guilds.fetch(l.config.guildId);
    const active = await guild.channels.fetchActiveThreads().catch(() => null);
    const channels = [];
    for (const id of allowedChannelIds(l.config)) {
      const channel = (await l.client.channels.fetch(id).catch(() => null)) as ChannelLike | null;
      if (!channel || !isReadableChannel(facts(channel), l.config)) continue;
      const threads = active
        ? [...active.threads.values()]
            .filter((t) => t.parentId === id)
            .map((t) => ({ id: t.id, name: t.name, agentId: state.agentForThread(t.id) ?? null }))
        : [];
      channels.push({
        id,
        name: channel.name ?? null,
        role: id === l.config.channelId ? "agents" : "commands",
        threads,
      });
    }
    return { guild: { id: guild.id, name: guild.name }, channels };
  });

  ctx.rpc.handle(`tool.${AGENT_TOOL_IDS.history}`, async (params) => {
    const l = require();
    const args = parseHistoryArgs(params, l.config);
    const channel = await fetchReadable(l, args.channelId);
    if (!channel.isTextBased() || !channel.messages)
      throw new AgentToolError(
        `Channel ${args.channelId} has no message history of its own (forum channels keep messages in their threads; see list_channels).`,
      );
    const page = await channel.messages.fetch({
      limit: args.limit,
      ...(args.before ? { before: args.before } : {}),
      ...(args.after ? { after: args.after } : {}),
    });
    const messages = [...page.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => toHistoryMessage(m));
    const hint = contentHint(messages, l.client.user?.id ?? null);
    return {
      channel: {
        id: channel.id,
        name: channel.name ?? null,
        threadOf: channel.isThread() ? (channel.parentId ?? null) : null,
        agentId: channel.isThread() ? (state.agentForThread(channel.id) ?? null) : null,
      },
      messages,
      hasMore: page.size === args.limit,
      ...(hint ? { hint } : {}),
    };
  });
}
