import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentToolError,
  contentHint,
  isReadableChannel,
  parseHistoryArgs,
  toHistoryMessage,
} from "../src/agent-tools.ts";

const GUILD = "100000000000000001";
const AGENTS = "200000000000000002";
const EXTRA = "300000000000000003";
const OTHER = "400000000000000004";
const THREAD = "500000000000000005";
const config = { guildId: GUILD, channelId: AGENTS, extraChannelIds: new Set([EXTRA]) };

test("parseHistoryArgs defaults to the agents channel and clamps the limit", () => {
  assert.deepEqual(parseHistoryArgs(undefined, config), { channelId: AGENTS, limit: 50 });
  assert.deepEqual(parseHistoryArgs({ channelId: EXTRA, limit: 500, before: THREAD }, config), {
    channelId: EXTRA,
    limit: 100,
    before: THREAD,
  });
  assert.throws(() => parseHistoryArgs({ channelId: "general" }, config), AgentToolError);
  assert.throws(() => parseHistoryArgs({ limit: 0 }, config), AgentToolError);
  assert.throws(() => parseHistoryArgs({ before: THREAD, after: THREAD }, config), AgentToolError);
});

test("isReadableChannel allows only the configured server's channels and their threads", () => {
  const ch = (id: string, over: Partial<{ guildId: string | null; parentId: string | null; isThread: boolean }> = {}) => ({
    id,
    guildId: GUILD,
    parentId: null,
    isThread: false,
    ...over,
  });
  assert.equal(isReadableChannel(ch(AGENTS), config), true);
  assert.equal(isReadableChannel(ch(EXTRA), config), true);
  assert.equal(isReadableChannel(ch(THREAD, { isThread: true, parentId: AGENTS }), config), true);
  assert.equal(isReadableChannel(ch(OTHER), config), false);
  assert.equal(isReadableChannel(ch(THREAD, { isThread: true, parentId: OTHER }), config), false);
  // A non-thread claiming a parent is not enough.
  assert.equal(isReadableChannel(ch(OTHER, { parentId: AGENTS }), config), false);
  assert.equal(isReadableChannel(ch(AGENTS, { guildId: OTHER }), config), false);
});

const message = (over: Record<string, unknown> = {}) => ({
  id: "600000000000000006",
  content: "hello",
  createdTimestamp: Date.UTC(2026, 0, 1),
  editedTimestamp: null,
  author: { id: "700000000000000007", username: "alice", globalName: "Alice", bot: false },
  member: null,
  attachments: new Map([["a", { name: "log.txt", url: "https://cdn/x", contentType: "text/plain", size: 3 }]]),
  embeds: [],
  reference: { messageId: "800000000000000008" },
  thread: null,
  ...over,
});

test("toHistoryMessage projects author, attachments and reply ids", () => {
  assert.deepEqual(toHistoryMessage(message()), {
    id: "600000000000000006",
    createdAt: "2026-01-01T00:00:00.000Z",
    editedAt: null,
    author: { id: "700000000000000007", name: "Alice", bot: false },
    content: "hello",
    attachments: [{ name: "log.txt", url: "https://cdn/x", contentType: "text/plain", size: 3 }],
    embeds: [],
    replyTo: "800000000000000008",
    threadId: null,
  });
});

test("contentHint flags history that came back without message text", () => {
  const blank = toHistoryMessage(message({ content: "", attachments: new Map() }));
  assert.match(contentHint([blank], "bot") ?? "", /Message Content intent/);
  assert.equal(contentHint([toHistoryMessage(message())], "bot"), null);
  assert.equal(contentHint([], "bot"), null);
});
