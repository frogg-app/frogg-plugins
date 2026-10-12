// Discord message shapes built from Frogg data. Pure: no discord.js imports, so the output is
// plain API JSON (embeds, components) that discord.js accepts as-is and tests can inspect.
import type {
  PluginAgentSummary,
  PluginAttentionEvent,
  PluginDiffStat,
  PluginPermissionDecision,
  PluginPermissionRequest,
  PluginTodo,
} from "@frogg/plugin-api";

export const MESSAGE_LIMIT = 2000;
/** Final answers longer than this go out as a preview plus a .md attachment. */
export const INLINE_ANSWER_LIMIT = 1800;
export const THREAD_NAME_LIMIT = 100;

const COLORS = {
  running: 0x3b82f6,
  idle: 0x22c55e,
  error: 0xef4444,
  attention: 0xf59e0b,
  closed: 0x6b7280,
} as const;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Keeps user text from pinging @everyone/roles or breaking out of code spans. */
export function sanitize(text: string): string {
  return text.replace(/@(everyone|here)/g, "@​$1").replace(/<@&/g, "<@​&");
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function agentTitle(agent: Pick<PluginAgentSummary, "id" | "title">): string {
  return agent.title?.trim() || `Agent ${shortId(agent.id)}`;
}

export function statusEmoji(agent: Pick<PluginAgentSummary, "status" | "attentionReason">): string {
  if (agent.attentionReason === "permission") return "✋";
  switch (agent.status) {
    case "running":
      return "🔄";
    case "initializing":
      return "⏳";
    case "error":
      return "❌";
    case "closed":
      return "📦";
    default:
      return agent.attentionReason === "finished" ? "✅" : "💤";
  }
}

export function statusLabel(agent: Pick<PluginAgentSummary, "status" | "attentionReason" | "pendingPermissions">): string {
  if (agent.attentionReason === "permission" || (agent.pendingPermissions ?? 0) > 0) {
    return "Waiting for permission";
  }
  switch (agent.status) {
    case "running":
      return "Running";
    case "initializing":
      return "Starting";
    case "error":
      return "Error";
    case "closed":
      return "Closed";
    default:
      return agent.attentionReason === "finished" ? "Finished" : "Idle";
  }
}

function statusColor(agent: PluginAgentSummary): number {
  if (agent.attentionReason === "permission" || (agent.pendingPermissions ?? 0) > 0) {
    return COLORS.attention;
  }
  if (agent.status === "running" || agent.status === "initializing") return COLORS.running;
  if (agent.status === "error") return COLORS.error;
  if (agent.status === "closed") return COLORS.closed;
  return COLORS.idle;
}

export function threadName(agent: Pick<PluginAgentSummary, "id" | "title" | "provider">): string {
  return truncate(`${agentTitle(agent)} · ${agent.provider}`, THREAD_NAME_LIMIT);
}

export function formatDiff(diff: PluginDiffStat | null | undefined): string | null {
  if (!diff) return null;
  return `+${diff.additions} −${diff.deletions}`;
}

export function formatUsage(usage: PluginAgentSummary["usage"]): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (tokens > 0) parts.push(`${compactNumber(tokens)} tokens`);
  if (typeof usage.costUsd === "number") parts.push(`$${usage.costUsd.toFixed(2)}`);
  if (usage.contextWindowUsedTokens && usage.contextWindowMaxTokens) {
    parts.push(
      `${Math.round((usage.contextWindowUsedTokens / usage.contextWindowMaxTokens) * 100)}% context`,
    );
  }
  return parts.length ? parts.join(" · ") : null;
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

/** The thread's first message, edited in place as the agent changes. */
export function statusEmbed(agent: PluginAgentSummary, diff?: PluginDiffStat | null): Embed {
  const fields: EmbedField[] = [
    { name: "Status", value: `${statusEmoji(agent)} ${statusLabel(agent)}`, inline: true },
    {
      name: "Provider",
      value: truncate(agent.model ? `${agent.provider} · ${agent.model}` : agent.provider, 1024),
      inline: true,
    },
  ];
  if (agent.branch) fields.push({ name: "Branch", value: truncate(`\`${agent.branch}\``, 1024), inline: true });
  const diffText = formatDiff(diff);
  if (diffText) fields.push({ name: "Changes", value: diffText, inline: true });
  const usage = formatUsage(agent.usage);
  if (usage) fields.push({ name: "Usage", value: usage, inline: true });
  if (agent.prUrl) fields.push({ name: "Pull request", value: truncate(agent.prUrl, 1024), inline: true });
  if (agent.lastError && agent.status === "error") {
    fields.push({ name: "Error", value: truncate(sanitize(agent.lastError), 1024) });
  }
  return {
    title: truncate(agentTitle(agent), 256),
    ...(agent.prUrl ? { url: agent.prUrl } : {}),
    description: truncate(`\`${agent.cwd}\``, 4096),
    color: statusColor(agent),
    fields,
    footer: { text: `Frogg agent ${shortId(agent.id)}` },
    ...(agent.updatedAt ? { timestamp: agent.updatedAt } : {}),
  };
}

export interface ToolLine {
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
  summary?: string;
}

const TOOL_ICON: Record<ToolLine["status"], string> = {
  running: "▸",
  completed: "✓",
  failed: "✗",
  canceled: "–",
};

/** A turn's progress message: the prompt, then the latest tool calls. Fits one message. */
export function turnProgress(input: {
  prompt: string | null;
  tools: readonly ToolLine[];
  showTools: boolean;
  done?: "finished" | "error" | "canceled";
  maxTools?: number;
}): string {
  const lines: string[] = [];
  if (input.prompt) lines.push(`**Prompt:** ${truncate(sanitize(oneLine(input.prompt)), 300)}`);
  if (input.showTools && input.tools.length) {
    const max = input.maxTools ?? 12;
    const hidden = input.tools.length - max;
    if (hidden > 0) lines.push(`-# …${hidden} earlier tool calls`);
    for (const t of input.tools.slice(-max)) {
      const gist = t.summary ? ` \`${truncate(oneLine(t.summary).replace(/`/g, "'"), 90)}\`` : "";
      lines.push(`${TOOL_ICON[t.status]} ${t.name}${gist}`);
    }
  }
  if (input.done) {
    const n = input.tools.length;
    const label = { finished: "Done", error: "Stopped on an error", canceled: "Canceled" }[input.done];
    lines.push(`-# ${label}${n ? ` · ${n} tool call${n === 1 ? "" : "s"}` : ""}`);
  } else {
    lines.push("-# Working…");
  }
  return truncate(lines.join("\n"), MESSAGE_LIMIT);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function mentions(userIds: readonly string[]): string {
  return userIds.map((id) => `<@${id}>`).join(" ");
}

export interface OutgoingMessage {
  content: string;
  embeds?: Embed[];
  components?: ActionRow[];
  /** Sent as a file; discord.js takes `{ attachment: Buffer, name }`. */
  file?: { name: string; text: string };
  /** Users that may be pinged; everything else is suppressed. */
  allowedUserMentions: string[];
}

/** Alert for a finished or failed turn: who to ping, the answer, and the diff. */
export function finalAnswer(input: {
  event: Pick<PluginAttentionEvent, "reason" | "agent">;
  answer: string | null;
  diff: PluginDiffStat | null;
  mentionUserIds: readonly string[];
}): OutgoingMessage {
  const { event, answer, diff } = input;
  const ping = mentions(input.mentionUserIds);
  const head =
    event.reason === "error"
      ? `❌ **${sanitize(agentTitle(event.agent))}** stopped on an error`
      : `✅ **${sanitize(agentTitle(event.agent))}** finished`;
  const diffText = formatDiff(diff);
  const header = [ping, head, diffText ? `· ${diffText}` : ""].filter(Boolean).join(" ");
  const body = answer?.trim() ? sanitize(answer.trim()) : event.reason === "error" && event.agent.lastError
    ? sanitize(event.agent.lastError)
    : "";
  const base = { allowedUserMentions: [...input.mentionUserIds] };
  if (!body) return { ...base, content: header };
  if (header.length + 2 + body.length <= INLINE_ANSWER_LIMIT) {
    return { ...base, content: `${header}\n\n${body}` };
  }
  const previewBudget = Math.max(200, INLINE_ANSWER_LIMIT - header.length - 60);
  return {
    ...base,
    content: `${header}\n\n${truncate(body, previewBudget)}\n-# Full answer attached.`,
    file: { name: `answer-${shortId(event.agent.id)}.md`, text: body },
  };
}

// ---------------------------------------------------------------------------
// Buttons

export interface Button {
  type: 2;
  style: 1 | 2 | 3 | 4;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

export interface ActionRow {
  type: 1;
  components: Button[];
}

const PERMISSION_PREFIX = "fdperm";
const DECISIONS: readonly PluginPermissionDecision[] = ["allow", "deny", "always"];

/** custom_id is capped at 100 chars, so buttons carry a short key into the plugin's state. */
export function permissionCustomId(decision: PluginPermissionDecision, key: string): string {
  return `${PERMISSION_PREFIX}:${decision}:${key}`;
}

export function parsePermissionCustomId(
  customId: string,
): { decision: PluginPermissionDecision; key: string } | null {
  const [prefix, decision, key, ...rest] = customId.split(":");
  if (prefix !== PERMISSION_PREFIX || rest.length || !key) return null;
  if (!(DECISIONS as readonly string[]).includes(decision ?? "")) return null;
  return { decision: decision as PluginPermissionDecision, key };
}

/** Label set on agents started from Discord, so threads="discord" mode can follow them. */
export const ORIGIN_LABEL = "discord.origin";

export function permissionButtons(key: string, canAlways: boolean): ActionRow[] {
  const buttons: Button[] = [
    { type: 2, style: 3, label: "Approve", custom_id: permissionCustomId("allow", key) },
    { type: 2, style: 4, label: "Deny", custom_id: permissionCustomId("deny", key) },
  ];
  if (canAlways) {
    buttons.push({ type: 2, style: 2, label: "Always", custom_id: permissionCustomId("always", key) });
  }
  return [{ type: 1, components: buttons }];
}

export function permissionMessage(input: {
  request: PluginPermissionRequest;
  agent: Pick<PluginAgentSummary, "id" | "title"> | null;
  key: string;
  mentionUserIds: readonly string[];
  remoteControl: boolean;
}): OutgoingMessage {
  const { request } = input;
  const who = input.agent ? `**${sanitize(agentTitle(input.agent))}**` : "An agent";
  const what = request.title?.trim() || request.name;
  const lines = [
    [mentions(input.mentionUserIds), `✋ ${who} wants to use **${sanitize(what)}**`].filter(Boolean).join(" "),
  ];
  if (request.description) lines.push(truncate(sanitize(request.description), 400));
  if (request.inputPreview) {
    lines.push("```", truncate(request.inputPreview.replace(/```/g, "ˋˋˋ"), 1200), "```");
  }
  const requested = request.requestedAt ? Date.parse(request.requestedAt) : NaN;
  if (Number.isFinite(requested)) lines.push(`-# Requested <t:${Math.floor(requested / 1000)}:R>`);
  if (!input.remoteControl) lines.push(REMOTE_OFF_NOTE);
  return {
    content: truncate(lines.join("\n"), MESSAGE_LIMIT),
    components: input.remoteControl ? permissionButtons(input.key, request.canAlways) : [],
    allowedUserMentions: [...input.mentionUserIds],
  };
}

const REMOTE_OFF_NOTE = "-# Remote control is off on the host, so answer in Frogg.";

/** The permission message after it was answered: same text, no buttons, plus the outcome. */
export function resolvedPermissionContent(
  original: string,
  outcome: { behavior: "allow" | "deny"; by?: string | null; always?: boolean },
): string {
  const verdict =
    outcome.behavior === "allow" ? (outcome.always ? "✅ Always allowed" : "✅ Approved") : "🚫 Denied";
  const by = outcome.by ? ` by <@${outcome.by}>` : " in Frogg";
  // Strip the leading pings so the edit doesn't read as a fresh alert.
  const body = original.replace(/^(<@\d+>\s*)+/, "");
  return truncate(`${body}\n**${verdict}${by}**`, MESSAGE_LIMIT);
}

// ---------------------------------------------------------------------------
// Command replies

export function agentListLine(agent: PluginAgentSummary, threadId: string | undefined): string {
  const where = threadId ? ` <#${threadId}>` : "";
  return truncate(
    `${statusEmoji(agent)} **${sanitize(agentTitle(agent))}** · ${agent.provider} · ${statusLabel(agent)}${where} · \`${shortId(agent.id)}\``,
    300,
  );
}

export function agentList(
  agents: readonly PluginAgentSummary[],
  threadFor: (agentId: string) => string | undefined,
  limit = 20,
): string {
  const visible = agents.filter((a) => a.status !== "closed");
  if (!visible.length) return "No agents on this host.";
  const order = (a: PluginAgentSummary) =>
    a.attentionReason === "permission" ? 0 : a.status === "running" ? 1 : a.status === "error" ? 2 : 3;
  const sorted = [...visible].sort(
    (a, b) => order(a) - order(b) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  const lines = sorted.slice(0, limit).map((a) => agentListLine(a, threadFor(a.id)));
  if (sorted.length > limit) lines.push(`-# …and ${sorted.length - limit} more`);
  return truncate(lines.join("\n"), MESSAGE_LIMIT);
}

export function hostStatus(input: {
  agents: readonly PluginAgentSummary[];
  hostVersion: string | null;
  remoteControl: boolean;
}): string {
  const count = (pred: (a: PluginAgentSummary) => boolean) => input.agents.filter(pred).length;
  const running = count((a) => a.status === "running");
  const waiting = count((a) => a.attentionReason === "permission" || (a.pendingPermissions ?? 0) > 0);
  const errored = count((a) => a.status === "error");
  const idle = count((a) => a.status === "idle");
  return [
    `**Frogg host**${input.hostVersion ? ` ${input.hostVersion}` : ""}`,
    `🔄 ${running} running · ✋ ${waiting} waiting · ❌ ${errored} errored · 💤 ${idle} idle`,
    input.remoteControl ? "🔓 Remote control on" : "🔒 Remote control off (read-only)",
  ].join("\n");
}

export function presenceText(agents: readonly PluginAgentSummary[]): string {
  const running = agents.filter((a) => a.status === "running").length;
  const waiting = agents.filter((a) => (a.pendingPermissions ?? 0) > 0).length;
  if (!running && !waiting) return "No agents running";
  const parts = [`${running} agent${running === 1 ? "" : "s"} running`];
  if (waiting) parts.push(`${waiting} waiting`);
  return parts.join(" · ");
}

export function todoCreated(todo: Pick<PluginTodo, "id" | "title" | "priority" | "status">): string {
  return `📝 Added to-do **${sanitize(todo.title)}** · ${todo.priority} · ${todo.status} · \`${todo.id}\``;
}

// ---------------------------------------------------------------------------
// Thread backlog

/** Messages older than this are not forwarded after downtime; stale instructions do more harm. */
export const BACKLOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Of the messages a thread received after `afterId`, the ones to forward now: human-authored,
 * recent enough, oldest first.
 */
export function selectBacklog<M extends { id: string; createdTimestamp: number; bot: boolean }>(
  messages: readonly M[],
  afterId: string,
  now: number,
  maxAgeMs = BACKLOG_MAX_AGE_MS,
): M[] {
  const after = BigInt(afterId);
  return messages
    .filter((m) => BigInt(m.id) > after && !m.bot && now - m.createdTimestamp <= maxAgeMs)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Setup

/** Bot permissions the invite asks for. */
export const BOT_PERMISSIONS = {
  AddReactions: 1n << 6n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  SendMessagesInThreads: 1n << 38n,
} as const;

export function invitePermissions(): bigint {
  return Object.values(BOT_PERMISSIONS).reduce((a, b) => a | b, 0n);
}

export function inviteUrl(applicationId: string, guildId?: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: "bot applications.commands",
    permissions: invitePermissions().toString(),
  });
  if (guildId) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Base64 file data -> MIME, for attachments Discord didn't label. */
export function guessMime(name: string, contentType: string | null | undefined): string {
  if (contentType) return contentType.split(";")[0]!.trim();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}
