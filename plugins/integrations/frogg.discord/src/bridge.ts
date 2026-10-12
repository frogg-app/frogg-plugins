// Frogg -> Discord: one thread per agent, a status message edited in place, a per-turn progress
// message, final answers with diff stats, and permission requests with buttons.
import { randomBytes } from "node:crypto";
import {
  ActivityType,
  ChannelType,
  type Client,
  type MessageCreateOptions,
  type MessageEditOptions,
  type ThreadAutoArchiveDuration,
} from "discord.js";
import type {
  PluginAgentEvent,
  PluginAgentSummary,
  PluginAttentionEvent,
  PluginContext,
  PluginDiffStat,
  PluginDisposable,
  PluginPermissionRequest,
  PluginPermissionResolved,
  PluginTimelineEntry,
} from "@frogg/plugin-api";
import type { DiscordConfig } from "./config.ts";
import { remoteControlEnabled } from "./access.ts";
import { KeyedDebouncer } from "./debounce.ts";
import {
  finalAnswer,
  mentions,
  ORIGIN_LABEL,
  permissionMessage,
  presenceText,
  resolvedPermissionContent,
  statusEmbed,
  threadName,
  turnProgress,
  type OutgoingMessage,
  type ToolLine,
} from "./format.ts";
import type { AgentThread, StateStore } from "./state.ts";

interface Turn {
  agentId: string;
  messageId: string | null;
  prompt: string | null;
  tools: Map<string, ToolLine>;
  done?: "finished" | "error" | "canceled";
}

const UNKNOWN_MESSAGE = 10008;
/** Most timeline entries replayed per agent after a restart. */
const CATCH_UP_LIMIT = 500;
const UNKNOWN_CHANNEL = 10003;

export function toPayload(m: OutgoingMessage): MessageCreateOptions & MessageEditOptions {
  return {
    content: m.content,
    ...(m.embeds ? { embeds: m.embeds } : {}),
    ...(m.components ? { components: m.components as MessageCreateOptions["components"] } : {}),
    ...(m.file ? { files: [{ attachment: Buffer.from(m.file.text, "utf8"), name: m.file.name }] } : {}),
    allowedMentions: { parse: [], users: m.allowedUserMentions },
  };
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

export class FroggToDiscord {
  private readonly summaries = new Map<string, PluginAgentSummary>();
  private readonly diffs = new Map<string, PluginDiffStat | null>();
  private readonly turns = new Map<string, Turn>();
  private readonly creating = new Map<string, Promise<AgentThread | null>>();
  /** Permission key -> Discord user who pressed the button, for the "Approved by" line. */
  private readonly answeredBy = new Map<string, { userId: string; always: boolean }>();
  private readonly disposables: PluginDisposable[] = [];
  /** Live timeline events held back while an agent's offline gap is replayed. */
  private catchingUp: Map<string, PluginAgentEvent[]> | null = null;
  /** Highest seq handled per agent in this process, to drop replay/live overlap. */
  private readonly lastSeq = new Map<string, number>();
  private readonly statusEdits: KeyedDebouncer<string>;
  private readonly turnEdits: KeyedDebouncer<Turn>;
  private readonly presence: KeyedDebouncer<"presence">;

  constructor(
    private readonly ctx: PluginContext,
    private readonly client: Client<true>,
    private readonly config: DiscordConfig,
    private readonly state: StateStore,
  ) {
    const onError = (what: string) => (_key: unknown, err: unknown) =>
      ctx.log.warn(`discord: ${what} failed`, { error: String(err) });
    this.statusEdits = new KeyedDebouncer<string>({
      delayMs: 2500,
      maxWaitMs: 8000,
      run: (agentId) => this.renderStatus(agentId),
      onError: onError("status edit"),
    });
    this.turnEdits = new KeyedDebouncer<Turn>({
      delayMs: 2000,
      maxWaitMs: 6000,
      run: (turn) => this.renderTurn(turn),
      onError: onError("turn edit"),
    });
    this.presence = new KeyedDebouncer<"presence">({
      delayMs: 10_000,
      maxWaitMs: 30_000,
      run: () => this.renderPresence(),
      onError: onError("presence"),
    });
  }

  async start(): Promise<void> {
    const { agents, permissions, host } = this.ctx;
    for (const agent of await agents.list()) this.summaries.set(agent.id, agent);
    this.catchingUp = new Map();
    this.disposables.push(agents.onEvent((e) => this.onAgentEvent(e)));
    // Forced so the thread always gets the final answer; presence only decides who gets pinged.
    this.disposables.push(agents.onAttention((e) => void this.onAttention(e), { force: true }));
    await this.catchUp();
    if (permissions) {
      // The host withholds these while remote control is off; list() catches up when it flips on.
      this.disposables.push(permissions.onRequest((r) => void this.onPermissionRequest(r)));
      this.disposables.push(permissions.onResolved((r) => void this.onPermissionResolved(r)));
      await this.syncPermissions();
    }
    if (host?.onRemoteControlChange) {
      this.disposables.push(host.onRemoteControlChange((on) => void this.onRemoteControlChange(on)));
    }
    // Refresh status messages for agents that already have threads (they may have changed while
    // the bot was offline).
    for (const id of this.summaries.keys()) if (this.state.thread(id)) this.statusEdits.schedule(id);
    if (this.config.presence) this.presence.schedule("presence");
  }

  stop(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.statusEdits.stop();
    this.turnEdits.stop();
    this.presence.stop();
  }

  threadFor(agentId: string): string | undefined {
    const t = this.state.thread(agentId);
    return t && t.homeChannelId === this.config.channelId ? t.threadId : undefined;
  }

  agentForThread(threadId: string): string | undefined {
    return this.state.agentForThread(threadId);
  }

  rememberAnswer(key: string, userId: string, always: boolean): void {
    this.answeredBy.set(key, { userId, always });
  }

  forgetAnswer(key: string): void {
    this.answeredBy.delete(key);
  }

  // -------------------------------------------------------------------------
  // Frogg events

  private wantsThread(agent: PluginAgentSummary | undefined): agent is PluginAgentSummary {
    return !!agent && (this.config.threads === "all" || agent.labels?.[ORIGIN_LABEL] === "discord");
  }

  private onAgentEvent(e: PluginAgentEvent): void {
    if (e.kind === "state" && e.agent) {
      this.summaries.set(e.agentId, e.agent);
      if (this.config.presence) this.presence.schedule("presence");
      if (this.threadFor(e.agentId)) this.statusEdits.schedule(e.agentId);
      else if (e.agent.status === "running" && this.wantsThread(e.agent)) {
        void this.ensureThread(e.agent);
      }
      return;
    }
    if (e.kind === "removed") {
      void this.onRemoved(e.agentId);
      return;
    }
    if (e.kind === "timeline" && e.entry) {
      const held = this.catchingUp?.get(e.agentId);
      if (held) held.push(e);
      else this.handleEntry(e.agentId, e.entry, e.cursor);
    }
  }

  private handleEntry(agentId: string, entry: PluginTimelineEntry, cursor: string | undefined): void {
    const last = this.lastSeq.get(agentId);
    if (last !== undefined && entry.seq <= last) return;
    this.lastSeq.set(agentId, entry.seq);
    this.onTimeline(agentId, entry.item);
    if (cursor && this.threadFor(agentId)) this.state.setCursor(agentId, cursor);
  }

  /**
   * Replays what agents with threads did while the bot was offline (from the persisted cursor),
   * holding live events for those agents until their replay is done.
   */
  private async catchUp(): Promise<void> {
    const ids = [...this.summaries.keys()].filter((id) => this.threadFor(id) && this.state.thread(id)?.cursor);
    for (const id of ids) this.catchingUp!.set(id, []);
    for (const id of ids) {
      try {
        let cursor: string | null = this.state.thread(id)!.cursor!;
        let seen = 0;
        for (;;) {
          const page = await this.ctx.agents.getTimeline(id, { cursor, limit: 200 });
          if (page.reset) {
            // Timeline rebuilt: nothing reliable to replay; resume from its current end.
            this.lastSeq.delete(id);
            const latest = await this.ctx.agents.getTimeline(id, { limit: 1 });
            if (latest.cursor) this.state.setCursor(id, latest.cursor);
            for (const e of latest.entries) this.lastSeq.set(id, e.seq);
            break;
          }
          for (const entry of page.entries) this.handleEntry(id, entry, undefined);
          if (page.cursor) {
            cursor = page.cursor;
            this.state.setCursor(id, page.cursor);
          }
          seen += page.entries.length;
          if (!page.hasMore || seen >= CATCH_UP_LIMIT || !page.entries.length) break;
        }
      } catch (err) {
        this.ctx.log.warn("discord: timeline catch-up failed", { agentId: id, error: String(err) });
      }
      const held = this.catchingUp!.get(id) ?? [];
      this.catchingUp!.delete(id);
      for (const e of held) if (e.entry) this.handleEntry(id, e.entry, e.cursor);
      // A replayed turn whose finish happened offline would otherwise stay "Working…".
      const turn = this.turns.get(id);
      const status = this.summaries.get(id)?.status;
      if (turn && !turn.done && status !== "running" && status !== "initializing") {
        turn.done = status === "error" ? "error" : "finished";
        this.turnEdits.schedule(turn);
      }
    }
    this.catchingUp = null;
  }

  private async onRemoteControlChange(enabled: boolean): Promise<void> {
    this.ctx.log.info("discord: remote control changed", { enabled });
    for (const [key, p] of this.state.allPermissions()) {
      if (!p.request) continue;
      const agent = this.summaries.get(p.agentId) ?? null;
      const m = permissionMessage({ request: p.request, agent, key, mentionUserIds: [], remoteControl: enabled });
      await this.editMessage(p.channelId, p.messageId, {
        content: m.content,
        components: m.components as MessageEditOptions["components"],
        allowedMentions: { parse: [] },
      }).catch((err) => this.ctx.log.debug("discord: re-rendering permission failed", { error: String(err) }));
    }
    if (enabled && this.ctx.permissions) await this.syncPermissions();
  }

  private onTimeline(agentId: string, item: PluginTimelineEntry["item"]): void {
    if (!this.threadFor(agentId)) {
      const agent = this.summaries.get(agentId);
      if (!(this.wantsThread(agent) && item.type === "user_message")) return;
      void this.ensureThread(agent);
    }
    if (item.type === "user_message") {
      const prev = this.turns.get(agentId);
      if (prev && !prev.done) {
        prev.done = "canceled";
        this.turnEdits.schedule(prev);
      }
      const turn: Turn = { agentId, messageId: null, prompt: item.text, tools: new Map() };
      this.turns.set(agentId, turn);
      this.turnEdits.schedule(turn);
      return;
    }
    if (item.type === "tool_call" && this.config.showToolCalls) {
      const turn = this.currentTurn(agentId);
      turn.tools.set(item.callId, { name: item.name, status: item.status, ...(item.summary ? { summary: item.summary } : {}) });
      this.turnEdits.schedule(turn);
    }
  }

  private currentTurn(agentId: string): Turn {
    let turn = this.turns.get(agentId);
    if (!turn || turn.done) {
      turn = { agentId, messageId: null, prompt: null, tools: new Map() };
      this.turns.set(agentId, turn);
    }
    return turn;
  }

  private async onAttention(e: PluginAttentionEvent): Promise<void> {
    this.summaries.set(e.agentId, e.agent);
    const ping = !e.clientActive || this.config.alertWhenAppActive ? this.config.mentionUserIds : [];
    const thread = this.threadFor(e.agentId) ? this.state.thread(e.agentId)! : await this.ensureThreadIfWanted(e.agent);
    if (!thread) return;

    if (e.reason === "permission") {
      // With agent.permissions the request itself is posted (with buttons) by onPermissionRequest.
      if (!this.ctx.permissions) {
        await this.post(e.agentId, {
          content: `${mentions(ping)} ✋ **${e.agent.title ?? "Agent"}** is waiting for permission. Answer it in Frogg.`.trim(),
          allowedUserMentions: [...ping],
        });
      }
      this.statusEdits.schedule(e.agentId);
      return;
    }

    const turn = this.turns.get(e.agentId);
    if (turn && !turn.done) {
      turn.done = e.reason === "error" ? "error" : "finished";
      this.turnEdits.schedule(turn);
    }
    const [diff, answer] = await Promise.all([
      this.ctx.agents.getDiffStat(e.agentId).catch(() => null),
      e.message !== null
        ? Promise.resolve(e.message)
        : this.ctx.agents.getLastAssistantMessage(e.agentId).catch(() => null),
    ]);
    this.diffs.set(e.agentId, diff);
    await this.post(e.agentId, finalAnswer({ event: e, answer, diff, mentionUserIds: ping }));
    this.statusEdits.schedule(e.agentId);
  }

  private async onRemoved(agentId: string): Promise<void> {
    const t = this.threadFor(agentId) ? this.state.thread(agentId) : undefined;
    const summary = this.summaries.get(agentId);
    this.summaries.delete(agentId);
    this.turns.delete(agentId);
    if (!t) return;
    try {
      if (summary) {
        await this.editMessage(t.statusChannelId, t.statusMessageId, {
          embeds: [statusEmbed({ ...summary, status: "closed", attentionReason: null }, this.diffs.get(agentId))],
        });
      }
      const thread = await this.client.channels.fetch(t.threadId);
      if (thread?.isThread() && !thread.archived) await thread.setArchived(true, "Agent archived in Frogg");
    } catch (err) {
      this.ctx.log.debug("discord: archiving thread failed", { error: String(err) });
    }
    this.state.deleteThread(agentId);
    this.diffs.delete(agentId);
  }

  private async onPermissionRequest(r: PluginPermissionRequest): Promise<void> {
    if (this.state.findPermission(r.agentId, r.requestId)) return;
    const agent = this.summaries.get(r.agentId) ?? (await this.ctx.agents.get(r.agentId));
    if (!agent) return;
    const thread = await this.ensureThreadIfWanted(agent);
    if (!thread) return;
    const key = randomBytes(6).toString("base64url");
    const message = permissionMessage({
      request: r,
      agent,
      key,
      mentionUserIds: this.config.mentionUserIds,
      remoteControl: remoteControlEnabled(this.ctx.host),
    });
    const sent = await this.post(r.agentId, message);
    if (sent) {
      this.state.setPermission(key, { agentId: r.agentId, requestId: r.requestId, ...sent, request: r });
    }
    this.statusEdits.schedule(r.agentId);
  }

  private async onPermissionResolved(r: PluginPermissionResolved): Promise<void> {
    const found = this.state.findPermission(r.agentId, r.requestId);
    if (!found) return;
    const [key, p] = found;
    const by = this.answeredBy.get(key);
    this.answeredBy.delete(key);
    this.state.deletePermission(key);
    await this.closePermissionMessage(p.channelId, p.messageId, (content) =>
      resolvedPermissionContent(content, {
        behavior: r.behavior,
        by: by?.userId ?? null,
        always: by?.always ?? false,
      }),
    );
    this.statusEdits.schedule(r.agentId);
  }

  /** Posts requests that arrived while offline and closes ones answered meanwhile. */
  private async syncPermissions(): Promise<void> {
    let pending: PluginPermissionRequest[];
    try {
      pending = await this.ctx.permissions.list();
    } catch (err) {
      // Forbidden while remote control is off; onRemoteControlChange retries.
      this.ctx.log.debug("discord: listing permissions failed", { error: String(err) });
      return;
    }
    const live = new Set(pending.map((p) => `${p.agentId}\u0000${p.requestId}`));
    for (const [key, p] of this.state.allPermissions()) {
      if (live.has(`${p.agentId}\u0000${p.requestId}`)) continue;
      this.state.deletePermission(key);
      await this.closePermissionMessage(p.channelId, p.messageId, (c) =>
        `${c.replace(/^(<@\d+>\s*)+/, "")}\n-# Answered while the bot was offline.`,
      );
    }
    for (const r of pending) await this.onPermissionRequest(r);
  }

  async closePermissionMessage(
    channelId: string,
    messageId: string,
    rewrite: (content: string) => string,
  ): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const message = await channel.messages.fetch(messageId);
      await message.edit({ content: rewrite(message.content), components: [], allowedMentions: { parse: [] } });
    } catch (err) {
      this.ctx.log.debug("discord: closing permission message failed", { error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Threads and messages

  private ensureThreadIfWanted(agent: PluginAgentSummary): Promise<AgentThread | null> {
    if (this.threadFor(agent.id)) return Promise.resolve(this.state.thread(agent.id)!);
    if (!this.wantsThread(agent)) return Promise.resolve(null);
    return this.ensureThread(agent);
  }

  /** Creates the agent's thread (once; concurrent callers share the promise). */
  ensureThread(agent: PluginAgentSummary): Promise<AgentThread | null> {
    if (this.threadFor(agent.id)) return Promise.resolve(this.state.thread(agent.id)!);
    const inFlight = this.creating.get(agent.id);
    if (inFlight) return inFlight;
    const p = this.createThread(agent)
      .catch((err) => {
        this.ctx.log.warn("discord: creating thread failed", { agentId: agent.id, error: String(err) });
        return null;
      })
      .finally(() => this.creating.delete(agent.id));
    this.creating.set(agent.id, p);
    return p;
  }

  private async createThread(agent: PluginAgentSummary): Promise<AgentThread | null> {
    const home = await this.client.channels.fetch(this.config.channelId);
    const name = threadName(agent);
    const embeds = [statusEmbed(agent, this.diffs.get(agent.id))];
    const autoArchiveDuration = this.config.archiveMinutes as ThreadAutoArchiveDuration;
    let record: AgentThread;
    if (home?.type === ChannelType.GuildForum || home?.type === ChannelType.GuildMedia) {
      const thread = await home.threads.create({ name, autoArchiveDuration, message: { embeds } });
      // A forum post's starter message shares the thread's id.
      record = { threadId: thread.id, statusChannelId: thread.id, statusMessageId: thread.id, homeChannelId: home.id };
    } else if (home?.type === ChannelType.GuildText || home?.type === ChannelType.GuildAnnouncement) {
      const starter = await home.send({ embeds });
      const thread = await starter.startThread({ name, autoArchiveDuration });
      record = { threadId: thread.id, statusChannelId: home.id, statusMessageId: starter.id, homeChannelId: home.id };
    } else {
      this.ctx.log.warn("discord: channelId must be a text or forum channel the bot can see");
      return null;
    }
    this.state.setThread(agent.id, record);
    return record;
  }

  /** Sends into the agent's thread, reopening it if it auto-archived. */
  async post(agentId: string, message: OutgoingMessage): Promise<{ channelId: string; messageId: string } | null> {
    const t = this.state.thread(agentId);
    if (!t) return null;
    try {
      const thread = await this.client.channels.fetch(t.threadId);
      if (!thread?.isThread()) return null;
      if (thread.archived && !thread.locked) await thread.setArchived(false);
      const sent = await thread.send(toPayload(message));
      return { channelId: thread.id, messageId: sent.id };
    } catch (err) {
      if (errorCode(err) === UNKNOWN_CHANNEL) this.state.deleteThread(agentId);
      this.ctx.log.warn("discord: posting to thread failed", { agentId, error: String(err) });
      return null;
    }
  }

  private async editMessage(channelId: string, messageId: string, payload: MessageEditOptions): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    await channel.messages.edit(messageId, payload);
  }

  private async renderStatus(agentId: string): Promise<void> {
    const t = this.threadFor(agentId) ? this.state.thread(agentId) : undefined;
    if (!t) return;
    const agent = (await this.ctx.agents.get(agentId)) ?? this.summaries.get(agentId);
    if (!agent) return;
    this.summaries.set(agentId, agent);
    try {
      await this.editMessage(t.statusChannelId, t.statusMessageId, {
        embeds: [statusEmbed(agent, this.diffs.get(agentId))],
      });
    } catch (err) {
      const code = errorCode(err);
      // Status message or thread deleted by hand: forget it, a new thread opens on next activity.
      if (code === UNKNOWN_MESSAGE || code === UNKNOWN_CHANNEL) this.state.deleteThread(agentId);
      else throw err;
    }
  }

  private async renderTurn(turn: Turn): Promise<void> {
    if (!this.threadFor(turn.agentId)) return;
    const content = turnProgress({
      prompt: turn.prompt,
      tools: [...turn.tools.values()],
      showTools: this.config.showToolCalls,
      ...(turn.done ? { done: turn.done } : {}),
    });
    if (!turn.messageId) {
      // A turn with nothing to show yet stays silent until it has a prompt or a tool call.
      if (!turn.prompt && turn.tools.size === 0) return;
      const sent = await this.post(turn.agentId, { content, allowedUserMentions: [] });
      turn.messageId = sent?.messageId ?? null;
      return;
    }
    const t = this.state.thread(turn.agentId)!;
    await this.editMessage(t.threadId, turn.messageId, { content, allowedMentions: { parse: [] } });
  }

  private async renderPresence(): Promise<void> {
    const text = presenceText([...this.summaries.values()]);
    this.client.user.setPresence({
      activities: [{ name: "Custom Status", state: text, type: ActivityType.Custom }],
      status: "online",
    });
  }
}
