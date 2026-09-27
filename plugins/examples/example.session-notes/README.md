# Session notes

Hybrid example. The daemon half stores notes in the plugin's settings store and serves the
`notes` markdown panel via the `panel.notes.render` RPC. The session header gets a **Pin note**
action that calls `example.session-notes.pin` with the current agent id.

The client half is intentionally empty in API v1 (declarative UI only); it demonstrates the
`entry.client` wiring and the "needs client component" install flow for hybrid plugins.
