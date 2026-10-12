import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccess, explainError, REMOTE_CONTROL_OFF, remoteControlEnabled } from "../src/access.ts";

const config = {
  guildId: "g",
  channelId: "agents",
  allowedUserIds: new Set(["alice"]),
  extraChannelIds: new Set(["ops"]),
};
const req = { guildId: "g", channelId: "agents", parentChannelId: null, userId: "alice" };

test("allows an allowlisted user in the agents channel, its threads and extra channels", () => {
  assert.deepEqual(checkAccess(config, req), { ok: true });
  assert.deepEqual(checkAccess(config, { ...req, channelId: "thread1", parentChannelId: "agents" }), { ok: true });
  assert.deepEqual(checkAccess(config, { ...req, channelId: "ops" }), { ok: true });
  assert.deepEqual(checkAccess(config, { ...req, channelId: "t2", parentChannelId: "ops" }), { ok: true });
});

test("denies other guilds, channels and users", () => {
  assert.equal(checkAccess(config, { ...req, guildId: "other" }).ok, false);
  assert.equal(checkAccess(config, { ...req, guildId: null }).ok, false);
  assert.equal(checkAccess(config, { ...req, channelId: "random" }).ok, false);
  assert.equal(checkAccess(config, { ...req, channelId: "t", parentChannelId: "random" }).ok, false);
  assert.equal(checkAccess(config, { ...req, userId: "mallory" }).ok, false);
});

test("an empty allowlist denies everyone", () => {
  assert.equal(checkAccess({ ...config, allowedUserIds: new Set() }, req).ok, false);
});

test("remote control is only on when the host says exactly true", () => {
  assert.equal(remoteControlEnabled({ remoteControl: true }), true);
  assert.equal(remoteControlEnabled({ remoteControl: false }), false);
  assert.equal(remoteControlEnabled({}), false);
  assert.equal(remoteControlEnabled(undefined), false);
});

test("explainError maps host error codes", () => {
  const err = (code: string) => Object.assign(new Error("x"), { code });
  assert.equal(explainError(err("forbidden")), REMOTE_CONTROL_OFF);
  assert.match(explainError(err("already_resolved")), /already answered/);
  assert.match(explainError(new Error("boom")), /boom/);
});
