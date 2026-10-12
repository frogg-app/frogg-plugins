import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIdList, readConfig } from "../src/config.ts";

const A = "123456789012345678";
const B = "223456789012345678";
const C = "323456789012345678";

test("parseIdList accepts commas, spaces, mentions and drops junk and duplicates", () => {
  assert.deepEqual(parseIdList(`${A}, <@${B}>\n<@!${C}> nope 12 ${A}`), [A, B, C]);
  assert.deepEqual(parseIdList(undefined), []);
  assert.deepEqual(parseIdList(42), []);
});

test("readConfig reports every missing required key", () => {
  const r = readConfig({ guildId: "x", allowedUserIds: "" });
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.missing, ["botToken", "guildId", "channelId", "allowedUserIds"]);
});

test("readConfig applies safe defaults", () => {
  const r = readConfig({ botToken: " t ", guildId: A, channelId: B, allowedUserIds: C });
  assert.ok(r.ok);
  const c = r.config;
  assert.equal(c.botToken, "t");
  assert.equal(c.threads, "all");
  assert.equal(c.alertWhenAppActive, false);
  assert.equal(c.readThreadMessages, false);
  assert.equal(c.showToolCalls, true);
  assert.equal(c.archiveMinutes, 1440);
  assert.deepEqual([...c.allowedUserIds], [C]);
});

test("readConfig parses select values from strings", () => {
  const r = readConfig({
    botToken: "t", guildId: A, channelId: B, allowedUserIds: C,
    threadArchiveMinutes: "10080", threads: "discord", readThreadMessages: true,
  });
  assert.ok(r.ok);
  assert.equal(r.config.archiveMinutes, 10080);
  assert.equal(r.config.threads, "discord");
  assert.equal(r.config.readThreadMessages, true);
  const bad = readConfig({ botToken: "t", guildId: A, channelId: B, allowedUserIds: C, threadArchiveMinutes: "7" });
  assert.ok(bad.ok);
  assert.equal(bad.config.archiveMinutes, 1440);
});
