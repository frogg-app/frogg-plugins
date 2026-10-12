// Discord -> Frogg: /frogg commands, autocomplete, permission buttons and (optionally) plain
// messages in agent threads. Every path passes checkAccess; writes also need remote control.
import {
  MessageFlags,
  type Attachment,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from "discord.js";
import type { PluginAttachment, PluginContext } from "@frogg/plugin-api";
import type { DiscordConfig } from "./config.ts";
import { checkAccess, explainError, REMOTE_CONTROL_OFF, remoteControlEnabled, type AccessRequest } from "./access.ts";
import type { FroggToDiscord } from "./bridge.ts";
import { COMMAND_NAME } from "./commands.ts";
import {
  agentList,
  agentTitle,
  guessMime,
  hostStatus,
  ORIGIN_LABEL,
  parsePermissionCustomId,
  sanitize,
  shortId,
  todoCreated,
  truncate,
} from "./format.ts";
import type { StateStore } from "./state.ts";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const EPHEMERAL = MessageFlags.Ephemeral;

class UserFacingError extends Error {}

export class DiscordToFrogg {
  constructor(
    private readonly ctx: PluginContext,
    private readonly config: DiscordConfig,
    private readonly bridge: FroggToDiscord,
    private readonly state: StateStore,
  ) {}

  private actor(userId: string): string {
    return `discord:${userId}`;
  }

  private access(i: { guildId: string | null; channelId: string | null; channel: unknown; userId: string }): AccessRequest {
    const channel = i.channel as { isThread?: () => boolean; parentId?: string | null } | null;
    const parentChannelId = channel?.isThread?.() ? (channel.parentId ?? null) : null;
    return { guildId: i.guildId, channelId: i.channelId, parentChannelId, userId: i.userId };
  }

  private requireRemoteControl(): void {
    if (!remoteControlEnabled(this.ctx.host)) throw new UserFacingError(REMOTE_CONTROL_OFF);
  }

  async onInteraction(i: Interaction): Promise<void> {
    if (!i.inGuild()) return;
    const access = checkAccess(
      this.config,
      this.access({ guildId: i.guildId, channelId: i.channelId, channel: i.channel, userId: i.user.id }),
    );
    if (i.isAutocomplete()) {
      if (i.commandName !== COMMAND_NAME) return;
      await i.respond(access.ok ? await this.autocomplete(i).catch(() => []) : []);
      return;
    }
    if (i.isChatInputCommand() && i.commandName === COMMAND_NAME) {
      if (!access.ok) {
        await i.reply({ content: access.reason, flags: EPHEMERAL });
        return;
      }
      await this.runCommand(i);
      return;
    }
    if (i.isButton()) {
      const parsed = parsePermissionCustomId(i.customId);
      if (!parsed) return;
      if (!access.ok) {
        await i.reply({ content: access.reason, flags: EPHEMERAL });
        return;
      }
      await this.onPermissionButton(i, parsed.decision, parsed.key);
    }
  }

  // -------------------------------------------------------------------------
  // Commands

  private async runCommand(i: ChatInputCommandInteraction<"cached" | "raw">): Promise<void> {
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand();
    const name = group ? `${group} ${sub}` : sub;
    const ephemeral = name === "status" || name === "agents";
    await i.deferReply(ephemeral ? { flags: EPHEMERAL } : {});
    try {
      const content = await this.command(name, i);
      await i.editReply({ content, allowedMentions: { parse: [] } });
    } catch (err) {
      const message = err instanceof UserFacingError ? err.message : explainError(err);
      if (!(err instanceof UserFacingError)) {
        this.ctx.log.warn("discord: command failed", { command: name, error: String(err) });
      }
      await i.editReply({ content: message, allowedMentions: { parse: [] } });
    }
  }

  private async command(name: string, i: ChatInputCommandInteraction<"cached" | "raw">): Promise<string> {
    const { agents } = this.ctx;
    const actor = { actor: this.actor(i.user.id) };
    switch (name) {
      case "status":
        return hostStatus({
          agents: await agents.list(),
          hostVersion: this.ctx.host?.version ?? null,
          remoteControl: remoteControlEnabled(this.ctx.host),
        });
      case "agents":
        return agentList(await agents.list(), (id) => this.bridge.threadFor(id));
      case "new": {
        this.requireRemoteControl();
        const workspaceId = i.options.getString("workspace", true);
        const workspace = this.ctx.workspaces ? await this.ctx.workspaces.get(workspaceId) : null;
        if (this.ctx.workspaces && !workspace) throw new UserFacingError("Pick a workspace from the list.");
        const provider = i.options.getString("provider") ?? (await this.defaultProvider());
        const model = i.options.getString("model");
        const title = i.options.getString("title");
        const agent = await agents.create({
          workspaceId,
          provider,
          prompt: i.options.getString("prompt", true),
          ...(model ? { model } : {}),
          ...(title ? { title } : {}),
          labels: { [ORIGIN_LABEL]: "discord", "discord.user": i.user.id },
          ...actor,
        });
        const thread = await this.bridge.ensureThread(agent);
        return `🚀 Started **${sanitize(agentTitle(agent))}** (${agent.provider}) in ${workspace ? `**${sanitize(workspace.title)}**` : "the workspace"}${thread ? ` → <#${thread.threadId}>` : ""}`;
      }
      case "stop": {
        this.requireRemoteControl();
        const agent = await this.resolveAgent(i);
        await agents.cancel(agent.id, actor);
        return `⏹️ Stopped **${sanitize(agentTitle(agent))}**.`;
      }
      case "reply": {
        this.requireRemoteControl();
        const agent = await this.resolveAgent(i);
        const text = i.options.getString("text", true);
        const file = i.options.getAttachment("attachment");
        const attachments = file ? await fetchAttachments([file]) : [];
        await agents.sendMessage(agent.id, text, { ...actor, ...(attachments.length ? { attachments } : {}) });
        const where = this.bridge.threadFor(agent.id);
        const inThread = where === i.channelId;
        return `💬 → **${sanitize(agentTitle(agent))}**${!inThread && where ? ` (<#${where}>)` : ""}: ${truncate(sanitize(text), 1500)}${file ? ` 📎 ${file.name}` : ""}`;
      }
      case "todo add": {
        if (!this.ctx.todos) throw new UserFacingError("To-dos aren't available on this host.");
        this.requireRemoteControl();
        const projectId = i.options.getString("project") ?? (await this.projectFromContext(i));
        const description = i.options.getString("description");
        const priority = i.options.getString("priority");
        const todo = await this.ctx.todos.create(
          projectId,
          {
            title: i.options.getString("title", true),
            ...(description ? { description } : {}),
            ...(priority ? { priority } : {}),
          },
          actor,
        );
        return todoCreated(todo);
      }
      default:
        throw new UserFacingError(`Unknown command ${name}.`);
    }
  }

  private async defaultProvider(): Promise<string> {
    const providers = await this.ctx.agents.listProviders();
    const first = providers.find((p) => p.available);
    if (!first) throw new UserFacingError("No agent provider is available on this host.");
    return first.id;
  }

  /** The `agent` option, else the agent whose thread the command was run in. */
  private async resolveAgent(i: ChatInputCommandInteraction<"cached" | "raw">) {
    const id = i.options.getString("agent") ?? this.bridge.agentForThread(i.channelId);
    if (!id) throw new UserFacingError("Run this in an agent's thread or pick an `agent`.");
    const agent = await this.ctx.agents.get(id);
    if (!agent) throw new UserFacingError("That agent no longer exists.");
    return agent;
  }

  private async projectFromContext(i: ChatInputCommandInteraction<"cached" | "raw">): Promise<string> {
    const agentId = this.bridge.agentForThread(i.channelId);
    const workspaceId = agentId ? (await this.ctx.agents.get(agentId))?.workspaceId : null;
    if (workspaceId && this.ctx.workspaces) {
      const ws = await this.ctx.workspaces.get(workspaceId);
      if (ws) return ws.projectId;
    }
    const projects = this.ctx.workspaces ? await this.ctx.workspaces.listProjects() : [];
    if (projects.length === 1) return projects[0]!.id;
    throw new UserFacingError("Pick a `project`, or run this in an agent's thread.");
  }

  private async autocomplete(i: AutocompleteInteraction): Promise<{ name: string; value: string }[]> {
    const focused = i.options.getFocused(true);
    const q = focused.value.toLowerCase();
    const match = (...parts: (string | null | undefined)[]) =>
      !q || parts.some((p) => p?.toLowerCase().includes(q));
    const choice = (name: string, value: string) => ({ name: truncate(name, 100), value });
    switch (focused.name) {
      case "agent":
        return (await this.ctx.agents.list())
          .filter((a) => a.status !== "closed" && match(a.title, a.id, a.provider))
          .slice(0, 25)
          .map((a) => choice(`${agentTitle(a)} · ${a.provider} · ${a.status} (${shortId(a.id)})`, a.id));
      case "workspace":
        if (!this.ctx.workspaces) return [];
        return (await this.ctx.workspaces.list())
          .filter((w) => match(w.title, w.branch, w.cwd))
          .slice(0, 25)
          .map((w) => choice(w.branch ? `${w.title} (${w.branch})` : w.title, w.id));
      case "provider":
        return (await this.ctx.agents.listProviders())
          .filter((p) => p.available && match(p.label, p.id))
          .slice(0, 25)
          .map((p) => choice(p.label, p.id));
      case "project":
        if (!this.ctx.workspaces) return [];
        return (await this.ctx.workspaces.listProjects())
          .filter((p) => match(p.name, p.rootPath))
          .slice(0, 25)
          .map((p) => choice(p.name, p.id));
      default:
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Permission buttons

  private async onPermissionButton(
    i: ButtonInteraction<"cached" | "raw">,
    decision: "allow" | "deny" | "always",
    key: string,
  ): Promise<void> {
    const pending = this.state.permission(key);
    if (!pending || !this.ctx.permissions) {
      await i.update({ components: [] });
      await i.followUp({ content: "That request is no longer pending.", flags: EPHEMERAL });
      return;
    }
    if (!remoteControlEnabled(this.ctx.host)) {
      await i.reply({ content: REMOTE_CONTROL_OFF, flags: EPHEMERAL });
      return;
    }
    await i.deferUpdate();
    this.bridge.rememberAnswer(key, i.user.id, decision === "always");
    try {
      await this.ctx.permissions.respond(pending.agentId, pending.requestId, decision, {
        actor: this.actor(i.user.id),
      });
      // onResolved edits the message (buttons off, "Approved by").
    } catch (err) {
      this.bridge.forgetAnswer(key);
      const code = (err as { code?: unknown }).code;
      if (code === "already_resolved" || code === "not_found") {
        this.state.deletePermission(key);
        await this.bridge.closePermissionMessage(pending.channelId, pending.messageId, (c) =>
          `${c.replace(/^(<@\d+>\s*)+/, "")}\n-# Answered elsewhere.`,
        );
      }
      await i.followUp({ content: explainError(err), flags: EPHEMERAL });
    }
  }

  // -------------------------------------------------------------------------
  // Plain messages in agent threads (Message Content intent; off by default)

  async onMessage(message: Message): Promise<void> {
    if (!this.config.readThreadMessages || message.author.bot || !message.inGuild()) return;
    if (!message.channel.isThread()) return;
    const agentId = this.bridge.agentForThread(message.channel.id);
    if (!agentId) return;
    const access = checkAccess(
      this.config,
      this.access({ guildId: message.guildId, channelId: message.channelId, channel: message.channel, userId: message.author.id }),
    );
    if (!access.ok) return;
    if (!remoteControlEnabled(this.ctx.host)) {
      await message.react("🔒").catch(() => undefined);
      return;
    }
    try {
      const attachments = await fetchAttachments([...message.attachments.values()]);
      const text = message.content.trim();
      if (!text && !attachments.length) return;
      await this.ctx.agents.sendMessage(agentId, text, {
        actor: this.actor(message.author.id),
        ...(attachments.length ? { attachments } : {}),
      });
      await message.react("✅").catch(() => undefined);
    } catch (err) {
      await message.reply({ content: err instanceof UserFacingError ? err.message : explainError(err), allowedMentions: { parse: [] } }).catch(() => undefined);
    }
  }
}

async function fetchAttachments(files: Attachment[]): Promise<PluginAttachment[]> {
  if (files.length > MAX_ATTACHMENTS) throw new UserFacingError(`At most ${MAX_ATTACHMENTS} attachments.`);
  const out: PluginAttachment[] = [];
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_BYTES) throw new UserFacingError(`${f.name} is over 8 MB.`);
    const res = await fetch(f.url);
    if (!res.ok) throw new UserFacingError(`Couldn't download ${f.name} from Discord.`);
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    out.push({ name: f.name, mime: guessMime(f.name, f.contentType), data });
  }
  return out;
}
