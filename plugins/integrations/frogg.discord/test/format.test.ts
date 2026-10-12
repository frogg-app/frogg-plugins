import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginAgentSummary, PluginPermissionRequest } from "@frogg/plugin-api";
import {
  agentList,
  finalAnswer,
  hostStatus,
  INLINE_ANSWER_LIMIT,
  invitePermissions,
  inviteUrl,
  MESSAGE_LIMIT,
  parsePermissionCustomId,
  permissionCustomId,
  permissionMessage,
  presenceText,
  resolvedPermissionContent,
  sanitize,
  statusEmbed,
  threadName,
  truncate,
  turnProgress,
} from "../src/format.ts";

const agent = (over: Partial<PluginAgentSummary> = {}): PluginAgentSummary => ({
  id: "0123456789abcdef",
  provider: "claude",
  cwd: "/repo",
  status: "running",
  title: "Fix login",
  ...over,
});

test("truncate keeps short text and ellipsises long text within the limit", () => {
  assert.equal(truncate("abc", 5), "abc");
  const t = truncate("x".repeat(50), 10);
  assert.equal(t.length, 10);
  assert.ok(t.endsWith("…"));
});

test("sanitize defuses @everyone, @here and role pings", () => {
  const s = sanitize("@everyone @here <@&123>");
  assert.ok(!s.includes("@everyone"));
  assert.ok(!s.includes("@here"));
  assert.ok(!s.includes("<@&"));
});

test("threadName fits Discord's 100 char limit and falls back to the id", () => {
  assert.equal(threadName(agent({ title: "y".repeat(300) })).length, 100);
  assert.equal(threadName(agent({ title: undefined })), "Agent 01234567 · claude");
});

test("statusEmbed shows status, model, branch, diff, usage and PR", () => {
  const e = statusEmbed(
    agent({ model: "opus", branch: "fix/login", prUrl: "https://x/pr/1", usage: { inputTokens: 1500, outputTokens: 500, costUsd: 0.1234 } }),
    { additions: 12, deletions: 3 },
  );
  const fields = Object.fromEntries((e.fields ?? []).map((f) => [f.name, f.value]));
  assert.equal(fields.Status, "🔄 Running");
  assert.equal(fields.Provider, "claude · opus");
  assert.equal(fields.Branch, "`fix/login`");
  assert.equal(fields.Changes, "+12 −3");
  assert.equal(fields.Usage, "2.0k tokens · $0.12");
  assert.equal(e.url, "https://x/pr/1");
});

test("statusEmbed flags waiting-for-permission over running", () => {
  const e = statusEmbed(agent({ pendingPermissions: 1 }));
  assert.equal(e.fields?.[0]?.value, "🔄 Waiting for permission");
});

test("turnProgress lists the latest tools and stays under the message limit", () => {
  const tools = Array.from({ length: 40 }, (_, i) => ({ name: "Bash", status: "completed" as const, summary: `cmd ${i} ${"z".repeat(200)}` }));
  const text = turnProgress({ prompt: "p".repeat(5000), tools, showTools: true, done: "finished" });
  assert.ok(text.length <= MESSAGE_LIMIT);
  assert.match(text, /…28 earlier tool calls/);
  assert.match(text, /Done · 40 tool calls/);
  const quiet = turnProgress({ prompt: "hi", tools, showTools: false });
  assert.ok(!quiet.includes("Bash"));
  assert.match(quiet, /Working…/);
});

test("finalAnswer inlines short answers and attaches long ones", () => {
  const short = finalAnswer({ event: { reason: "finished", agent: agent() }, answer: "All done.", diff: { additions: 1, deletions: 0 }, mentionUserIds: ["111"] });
  assert.match(short.content, /^<@111> ✅ \*\*Fix login\*\* finished · \+1 −0\n\nAll done\.$/);
  assert.equal(short.file, undefined);
  assert.deepEqual(short.allowedUserMentions, ["111"]);

  const body = "line\n".repeat(1000);
  const long = finalAnswer({ event: { reason: "finished", agent: agent() }, answer: body, diff: null, mentionUserIds: [] });
  assert.ok(long.content.length <= INLINE_ANSWER_LIMIT);
  assert.equal(long.file?.text, body.trim());
  assert.match(long.file?.name ?? "", /^answer-01234567\.md$/);
});

test("finalAnswer for an error falls back to lastError", () => {
  const m = finalAnswer({ event: { reason: "error", agent: agent({ status: "error", lastError: "boom" }) }, answer: null, diff: null, mentionUserIds: [] });
  assert.match(m.content, /stopped on an error\n\nboom$/);
});

test("permission custom ids round-trip and fit in 100 chars", () => {
  const id = permissionCustomId("always", "AbC-123_xyz");
  assert.ok(id.length <= 100);
  assert.deepEqual(parsePermissionCustomId(id), { decision: "always", key: "AbC-123_xyz" });
  assert.equal(parsePermissionCustomId("other:allow:k"), null);
  assert.equal(parsePermissionCustomId("fdperm:nuke:k"), null);
  assert.equal(parsePermissionCustomId("fdperm:allow:"), null);
  assert.equal(parsePermissionCustomId("fdperm:allow:k:extra"), null);
});

const request: PluginPermissionRequest = {
  agentId: "a", requestId: "r", name: "Bash", kind: "tool", inputPreview: "rm -rf ```x```", canAlways: false,
};

test("permissionMessage offers Always only when the provider allows it", () => {
  const m = permissionMessage({ request, agent: agent(), key: "k", mentionUserIds: ["111"], remoteControl: true });
  assert.deepEqual(m.components?.[0]?.components.map((b) => b.label), ["Approve", "Deny"]);
  const m2 = permissionMessage({ request: { ...request, canAlways: true }, agent: agent(), key: "k", mentionUserIds: [], remoteControl: true });
  assert.equal(m2.components?.[0]?.components.length, 3);
  assert.ok(!m.content.includes("```x```"), "fences in the preview are neutralised");
});

test("permissionMessage drops buttons when remote control is off", () => {
  const m = permissionMessage({ request, agent: agent(), key: "k", mentionUserIds: [], remoteControl: false });
  assert.deepEqual(m.components, []);
  assert.match(m.content, /answer in Frogg/);
});

test("resolvedPermissionContent strips pings and records who answered", () => {
  const out = resolvedPermissionContent("<@111> <@222> ✋ wants Bash", { behavior: "allow", by: "333", always: true });
  assert.equal(out, "✋ wants Bash\n**✅ Always allowed by <@333>**");
  assert.match(resolvedPermissionContent("x", { behavior: "deny" }), /🚫 Denied in Frogg/);
});

test("agentList sorts waiting first, hides closed agents and links threads", () => {
  const list = agentList(
    [
      agent({ id: "idle0000", title: "Idle", status: "idle", updatedAt: "2026-01-02" }),
      agent({ id: "wait0000", title: "Waiting", status: "running", attentionReason: "permission" }),
      agent({ id: "gone0000", title: "Gone", status: "closed" }),
      agent({ id: "run00000", title: "Run" }),
    ],
    (id) => (id === "run00000" ? "999" : undefined),
  );
  const lines = list.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /Waiting/);
  assert.match(lines[1]!, /Run.*<#999>/);
  assert.ok(!list.includes("Gone"));
  assert.equal(agentList([], () => undefined), "No agents on this host.");
});

test("hostStatus and presence summarise counts", () => {
  const agents = [agent(), agent({ status: "error" }), agent({ status: "idle", pendingPermissions: 2 })];
  const s = hostStatus({ agents, hostVersion: "1.7.0", remoteControl: false });
  assert.match(s, /1 running · ✋ 1 waiting · ❌ 1 errored · 💤 1 idle/);
  assert.match(s, /read-only/);
  assert.equal(presenceText(agents), "1 agent running · 1 waiting");
  assert.equal(presenceText([]), "No agents running");
});

test("invite URL requests bot + commands scopes and thread permissions", () => {
  const url = new URL(inviteUrl("42", "7"));
  assert.equal(url.searchParams.get("scope"), "bot applications.commands");
  assert.equal(url.searchParams.get("guild_id"), "7");
  const perms = BigInt(url.searchParams.get("permissions")!);
  assert.equal(perms, invitePermissions());
  assert.ok(perms & (1n << 38n), "SendMessagesInThreads");
  assert.ok(!(perms & 8n), "never Administrator");
});
