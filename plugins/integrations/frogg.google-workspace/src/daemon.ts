// frogg.google-workspace: daemon entry. Wires Frogg events to the sync engine, runs the poll loop
// for Google-side changes, and answers the commands, session actions and panel.
import type { PluginContext } from "@frogg/plugin-api";
import { GoogleAuth, GoogleAuthError, TokenStore, type DeviceCodeState } from "./auth.ts";
import { missingConfig, parseConfig, type GoogleConfig } from "./config.ts";
import { GoogleClient, fileUrl } from "./google.ts";
import { renderPanel } from "./panel.ts";
import { StateFile } from "./state.ts";
import { GoogleSync } from "./sync.ts";

let stop: (() => void) | null = null;

export default async function activate(ctx: PluginContext): Promise<void> {
  let config: GoogleConfig = parseConfig(await ctx.settings.all());
  const auth = new GoogleAuth({
    clientId: () => config.clientId,
    clientSecret: () => config.clientSecret,
    store: new TokenStore(ctx.plugin.dataDir),
    fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ?? ctx.signal }),
  });
  await auth.load();
  const state = new StateFile(ctx.plugin.dataDir);
  await state.load();
  const google = new GoogleClient({ token: (force) => auth.accessToken(force), fetch: (u, i) => fetch(u, i) });
  const sync = new GoogleSync({ ctx, google, state, config: () => config, connectedEmail: () => auth.email });

  let device: DeviceCodeState | null = null;
  let deviceAbort: AbortController | null = null;
  let authError: string | null = null;
  const refresh = () => ctx.ui.refreshPanel("google");

  ctx.settings.onChange(() => {
    void ctx.settings.all().then((raw) => {
      config = parseConfig(raw);
      refresh();
    });
  });

  const ready = () => auth.connected && missingConfig(config).length === 0;

  // Frogg → Google
  ctx.agents.onEvent((event) => {
    if (event.kind === "state" && ready()) sync.markAgent(event.agentId);
  });
  ctx.agents.onAttention(
    (event) => {
      if (ready()) void sync.onAgentFinished(event.agentId, event.reason, event.message).finally(refresh);
    },
    { force: true },
  );
  ctx.todos?.onChange((change) => {
    if (ready()) sync.markProject(change.projectId);
  });
  ctx.host.onRemoteControlChange(() => refresh());

  // Google → Frogg
  let polling = false;
  const poll = async () => {
    if (polling || !ready()) return;
    polling = true;
    try {
      await sync.pollComments();
      await sync.pollTodos();
    } finally {
      polling = false;
      refresh();
    }
  };
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void poll(), config.pollSeconds * 1000);
    timer.unref?.();
  };
  schedule();
  ctx.settings.onChange((key) => {
    if (key === "pollSeconds") setTimeout(schedule, 0);
  });

  const requireReady = () => {
    const missing = missingConfig(config);
    if (missing.length) throw new Error(`Set ${missing.join(" and ")} in the plugin settings first`);
    if (!auth.connected) throw new Error("Connect a Google account first (Google: connect account)");
  };

  const firstSync = async () => {
    for (const a of await ctx.agents.list()) sync.markAgent(a.id);
    await sync.flushLedger();
    await sync.syncAllTodos();
  };

  ctx.rpc.handle("google.connect", async () => {
    const missing = missingConfig(config);
    if (missing.length) {
      ctx.ui.notify(`Set ${missing.join(" and ")} in the Google Workspace settings first`, "warning");
      return { ok: false };
    }
    deviceAbort?.abort();
    authError = null;
    const flow = await auth.startDeviceFlow();
    device = { userCode: flow.userCode, verificationUrl: flow.verificationUrl, expiresAt: flow.expiresAt };
    const abort = new AbortController();
    deviceAbort = abort;
    ctx.signal.addEventListener("abort", () => abort.abort(), { once: true });
    refresh();
    ctx.ui.notify(`Open ${flow.verificationUrl} and enter ${flow.userCode} (also shown in the Google panel)`, "info");
    void auth
      .completeDeviceFlow(flow, abort.signal)
      .then(async (tokens) => {
        device = null;
        ctx.ui.notify(`Google connected${tokens.email ? ` as ${tokens.email}` : ""}`, "success");
        refresh();
        await firstSync();
      })
      .catch((err) => {
        device = null;
        if (err instanceof GoogleAuthError && err.code === "aborted") return;
        authError = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Google sign-in failed: ${authError}`, "error");
      })
      .finally(refresh);
    return { ok: true, userCode: flow.userCode, verificationUrl: flow.verificationUrl };
  });

  ctx.rpc.handle("google.disconnect", async () => {
    deviceAbort?.abort();
    device = null;
    await auth.disconnect();
    await state.reset();
    ctx.ui.notify("Google disconnected. Files already created stay in your Drive.", "info");
    refresh();
    return { ok: true };
  });

  ctx.rpc.handle("google.sync", async () => {
    requireReady();
    await firstSync();
    await poll();
    ctx.ui.notify("Google sync finished", sync.lastError ? "warning" : "success");
    return { ok: !sync.lastError, error: sync.lastError };
  });

  ctx.rpc.handle("google.deck", async () => {
    requireReady();
    const url = await sync.createDeck();
    ctx.ui.notify(`Deck created: ${url}`, "success");
    refresh();
    return { url };
  });

  const agentIdOf = (params: unknown): string => {
    const id = (params as { agentId?: unknown } | null)?.agentId;
    if (typeof id !== "string" || !id) throw new Error("Open this from an agent session");
    return id;
  };

  ctx.rpc.handle("google.report", async (params) => {
    requireReady();
    const url = await sync.exportReport(agentIdOf(params));
    ctx.ui.notify(`Report ready: ${url}`, "success");
    refresh();
    return { url };
  });

  ctx.rpc.handle("google.plan", async (params) => {
    requireReady();
    const url = await sync.exportPlan(agentIdOf(params));
    ctx.ui.notify(`Plan sent to Google Docs: ${url}`, "success");
    refresh();
    return { url };
  });

  ctx.rpc.handle("panel.google.render", async () => ({
    kind: "markdown",
    markdown: renderPanel({
      missing: missingConfig(config),
      connected: auth.connected,
      email: auth.email,
      device,
      authError,
      remoteControl: ctx.host.remoteControl,
      config,
      state: state.value,
      lastError: sync.lastError,
      lastSyncAt: sync.lastSyncAt,
      notices: sync.notices,
      urls: fileUrl,
    }),
  }));

  stop = () => {
    if (timer) clearInterval(timer);
    deviceAbort?.abort();
    sync.dispose();
  };
  ctx.signal.addEventListener("abort", () => stop?.(), { once: true });
  ctx.log.info(ready() ? "google: connected" : "google: not connected", {
    email: auth.email,
    missing: missingConfig(config),
  });
}

export function deactivate(): void {
  stop?.();
  stop = null;
}
