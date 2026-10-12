import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.ts";

test("state round-trips threads and permissions through the data dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "frogg-discord-"));
  const a = StateStore.forDataDir(dir);
  await a.load();
  a.setThread("agent1", { threadId: "t1", statusChannelId: "c", statusMessageId: "m", homeChannelId: "c" });
  a.setPermission("k1", { agentId: "agent1", requestId: "r1", channelId: "t1", messageId: "pm" });
  await a.flush();

  const b = StateStore.forDataDir(dir);
  await b.load();
  assert.equal(b.agentForThread("t1"), "agent1");
  assert.deepEqual(b.findPermission("agent1", "r1")?.[0], "k1");

  b.deleteThread("agent1");
  await b.flush();
  const raw = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
  assert.deepEqual(raw.agents, {});
  assert.deepEqual(raw.permissions, {}, "deleting a thread drops its pending permissions");
});

test("a corrupt state file starts empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "frogg-discord-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dir, "state.json"), "{nope");
  const s = StateStore.forDataDir(dir);
  await s.load();
  assert.equal(s.thread("x"), undefined);
});
