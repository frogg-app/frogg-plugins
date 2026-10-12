// The Google Workspace panel: connection state, the device code while signing in, links to the
// files the plugin keeps, and recent activity.
import type { DeviceCodeState } from "./auth.ts";
import type { GoogleConfig } from "./config.ts";
import type { GoogleState } from "./state.ts";

export interface PanelInput {
  missing: string[];
  connected: boolean;
  email: string | null;
  device: DeviceCodeState | null;
  authError: string | null;
  remoteControl: boolean;
  config: GoogleConfig;
  state: GoogleState;
  lastError: string | null;
  lastSyncAt: string | null;
  notices: string[];
  urls: {
    doc: (id: string) => string;
    sheet: (id: string) => string;
    slides: (id: string) => string;
    folder: (id: string) => string;
  };
}

export function renderPanel(p: PanelInput): string {
  const out: string[] = [];
  if (p.missing.length) {
    out.push(
      "**Not configured.** Open this plugin's **Settings** and set: " + p.missing.join(", ") + ".",
      "",
      "Create the OAuth client in the Google Cloud console (type *TVs and Limited Input devices*) and enable the Drive, Docs, Sheets and Slides APIs. The plugin's README has the steps.",
    );
    return out.join("\n");
  }
  if (p.device) {
    out.push(
      "### Finish signing in",
      "",
      `1. Open **${p.device.verificationUrl}** on any device.`,
      `2. Enter the code **\`${p.device.userCode}\`**.`,
      "",
      `The code expires at ${new Date(p.device.expiresAt).toISOString().slice(11, 16)} UTC.`,
    );
    return out.join("\n");
  }
  if (!p.connected) {
    out.push("**Not connected.** Run **Google: connect account** from the Command Center.");
    if (p.authError) out.push("", `Last attempt failed: ${p.authError}`);
    return out.join("\n");
  }
  out.push(`**Connected** as ${p.email ?? "your Google account"}.`, "");
  out.push(
    p.remoteControl
      ? "Remote control is **on**: Doc comments reach agents and Sheet edits change to-dos."
      : "Remote control is **off**: the plugin mirrors Frogg into Google, but Doc comments and Sheet edits are not applied. The host owner can turn it on under Plugins.",
    "",
  );
  const links: string[] = [];
  if (p.state.rootFolderId) links.push(`- [${p.config.folderName} folder](${p.urls.folder(p.state.rootFolderId)})`);
  if (p.state.ledger) links.push(`- [Agent ledger](${p.urls.sheet(p.state.ledger.spreadsheetId)})`);
  for (const [projectId, t] of Object.entries(p.state.todos))
    links.push(`- [To-dos: ${projectId}](${p.urls.sheet(t.spreadsheetId)})`);
  const docs = Object.values(p.state.docs).slice(-5).reverse();
  for (const d of docs) links.push(`- [${d.title}](${p.urls.doc(d.docId)})`);
  for (const d of p.state.decks.slice(0, 3)) links.push(`- [${d.title}](${p.urls.slides(d.id)})`);
  if (links.length) out.push("### Files", "", ...links, "");
  if (p.state.pendingReplies.length)
    out.push(`${p.state.pendingReplies.length} Doc comment(s) waiting for an agent's answer.`, "");
  if (p.notices.length) out.push("### Recent", "", ...p.notices.map((n) => `- ${n}`), "");
  if (p.lastError) out.push(`**Last error:** ${p.lastError}`);
  else if (p.lastSyncAt) out.push(`Last synced ${p.lastSyncAt.slice(11, 16)} UTC.`);
  return out.join("\n");
}
