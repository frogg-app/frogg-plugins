import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GoogleAuth, TokenStore, emailFromIdToken } from "../src/auth.ts";
import { GoogleClient } from "../src/google.ts";
import { isAllowedGoogleUser, parseConfig } from "../src/config.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const idToken = `x.${Buffer.from(JSON.stringify({ email: "a@b.com" })).toString("base64url")}.y`;

async function makeAuth(responses: Response[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "gw-auth-"));
  const calls: { url: string; body: string }[] = [];
  let t = 0;
  const auth = new GoogleAuth({
    clientId: () => "cid",
    clientSecret: () => "sec",
    store: new TokenStore(dir),
    fetch: async (url, init) => {
      calls.push({ url, body: String(init?.body ?? "") });
      return responses.shift() ?? json(500, {});
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  return { auth, calls, dir };
}

test("device flow polls through pending and slow_down", async () => {
  const { auth, calls, dir } = await makeAuth([
    json(200, { device_code: "dc", user_code: "ABC-DEF", verification_url: "https://www.google.com/device", expires_in: 600, interval: 5 }),
    json(428, { error: "authorization_pending" }),
    json(400, { error: "slow_down" }),
    json(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, id_token: idToken }),
  ]);
  const flow = await auth.startDeviceFlow();
  assert.equal(flow.userCode, "ABC-DEF");
  const tokens = await auth.completeDeviceFlow(flow, new AbortController().signal);
  assert.equal(tokens.email, "a@b.com");
  assert.match(calls[0]!.body, /scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file/);
  assert.match(calls[3]!.body, /grant_type=urn%3Aietf/);
  assert.equal((await new TokenStore(dir).read())?.refreshToken, "rt");
  assert.equal(await auth.accessToken(), "at");
});

test("declined sign-in surfaces access_denied", async () => {
  const { auth } = await makeAuth([
    json(200, { device_code: "dc", user_code: "U", expires_in: 600, interval: 5 }),
    json(403, { error: "access_denied" }),
  ]);
  const flow = await auth.startDeviceFlow();
  await assert.rejects(auth.completeDeviceFlow(flow, new AbortController().signal), /declined/);
});

test("revoked refresh tokens disconnect", async () => {
  const { auth, dir } = await makeAuth([json(400, { error: "invalid_grant" })]);
  await new TokenStore(dir).write({ refreshToken: "rt", email: null });
  await assert.rejects(auth.accessToken(), /revoked/);
  assert.equal(auth.connected, false);
});

test("client retries 429 and refreshes once on 401", async () => {
  const seen: string[] = [];
  const responses = [new Response("", { status: 401 }), new Response("", { status: 429 }), json(200, { id: "f" })];
  const client = new GoogleClient({
    token: async (force) => {
      seen.push(force ? "forced" : "cached");
      return "t";
    },
    fetch: async () => responses.shift()!,
    sleep: async () => undefined,
  });
  assert.equal(await client.createFile("n", "m", null), "f");
  assert.deepEqual(seen, ["cached", "forced", "forced"]);
});

test("id token email and allowlist", () => {
  assert.equal(emailFromIdToken(idToken), "a@b.com");
  assert.equal(emailFromIdToken("junk"), null);
  const config = parseConfig({ allowedEmails: "Boss@x.com, ops@x.com" });
  assert.ok(isAllowedGoogleUser(config, { me: true }, null));
  assert.ok(isAllowedGoogleUser(config, { emailAddress: "boss@x.com" }, null));
  assert.ok(isAllowedGoogleUser(config, { emailAddress: "me@x.com" }, "me@x.com"));
  assert.ok(!isAllowedGoogleUser(config, { emailAddress: "evil@x.com" }, "me@x.com"));
  assert.ok(!isAllowedGoogleUser(config, { displayName: "No email" }, "me@x.com"));
});
