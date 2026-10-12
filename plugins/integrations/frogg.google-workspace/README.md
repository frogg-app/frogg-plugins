# Google Workspace for Frogg

Syncs Frogg into Google Sheets, Docs and Slides. Plugin API v2, daemon scope.

| Feature | Where | Direction |
|---|---|---|
| Agent run ledger: one row per agent (status, model, branch, tokens, cost, lines changed, PR, report link) | Sheets: `Frogg agent ledger` | Frogg → Google |
| Report Doc per finished agent: summary, final answer, plan, files changed, steps | Docs, per-project folder | Frogg → Google |
| `@frogg` comments on a report or plan Doc go to that agent; its answer is posted as a reply | Docs comments | Both ways |
| Plan → Doc: the session action **Send plan to Google Docs** | Docs | Frogg → Google, then comments back |
| Project to-dos mirrored to a Sheet; edits to title, priority, category, description and status flow back | Sheets: `Frogg to-dos — <project>` | Both ways |
| Release deck from agents finished in the last 7 days | Slides | Frogg → Google |

## Set up

1. **Google Cloud project.** In the [Google Cloud console](https://console.cloud.google.com/), create
   or pick a project and enable these APIs: Google Drive API, Google Docs API, Google Sheets API,
   Google Slides API.
2. **OAuth consent screen.** User type *External* (or *Internal* on Workspace). Add the scope
   `https://www.googleapis.com/auth/drive.file`. While the app is in *Testing*, add your Google
   account under *Test users*.
3. **OAuth client.** Credentials → Create credentials → OAuth client ID → application type
   **TVs and Limited Input devices**. Copy the client ID and secret.
4. **In Frogg**, open Plugins → Google Workspace → **Settings**, and paste the client ID and secret.
5. Run **Google: connect account** from the Command Center. The **Google Workspace** panel shows a
   URL and a code; open the URL on any device, enter the code, and approve.
6. Optional: turn on **Remote control** for the plugin under Plugins → Installed. Without it the
   plugin only mirrors Frogg into Google; with it, `@frogg` comments reach agents and Sheet edits
   change to-dos.

The first connect creates a `Frogg` folder in your Drive with the ledger and one to-do Sheet per
project. Reports appear as agents finish (or when you run **Export report to Google Docs** from a
session, if you set reports to manual).

## Why device sign-in and `drive.file`

The daemon is often headless or remote, so it can't open a browser. The device flow lets you
approve on any device. `drive.file` limits the plugin to files it creates: it can't read the rest
of your Drive, and Google doesn't require a security assessment for it. The trade-off: the plugin
can't open Docs or Sheets you made yourself, only its own.

## Settings

| Setting | Default | Notes |
|---|---|---|
| OAuth client ID / secret | required | From step 3 |
| Google accounts allowed to drive agents | empty | Comma-separated emails. The connected account is always allowed. Comments from anyone else are ignored, with a reply saying so. |
| Agent run ledger | on | |
| Report Doc when an agent finishes | every agent | or only on manual export |
| Sync project to-dos with Sheets | on | |
| Send Doc comments to the agent | on | needs remote control |
| Check Google for changes every | 1 minute | comments and Sheet edits are polled; no public webhook needed |
| Drive folder | `Frogg` | |

## How the two-way to-do sync resolves conflicts

The plugin remembers each to-do's values from the last sync. A cell edited in the Sheet is applied
only if Frogg still has the old value; if both sides changed the same field, Frogg wins and the
Sheet is rewritten. Rows with no ID and a title become new to-dos. Deleting a row does nothing.
`claimed` and `in_progress` follow agent claims and can't be set from the Sheet. While remote
control is off, Sheet edits are not applied and the next sync rewrites the Sheet from Frogg.

## Security

- Every change the plugin makes in Frogg (messages to agents, to-do edits) is recorded in the host
  audit log as `google:<email>`.
- Tokens live in the plugin's data directory on the host (`google-tokens.json`, mode 600).
  **Google: disconnect account** revokes them. Files already created stay in your Drive.

## Develop

```bash
npm run typecheck
npm test
npm run build
frogg plugins link "$PWD"      # on a beta host with developer mode
```
