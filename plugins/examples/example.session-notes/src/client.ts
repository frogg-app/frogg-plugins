// Client half. API v1 has no imperative client surface: the declarative `contributes` block in
// frogg-plugin.json drives the UI and every action round-trips to the daemon half via plugin
// RPC. The client entry exists so the host fetches and verifies it alongside the daemon half.
export default function activate(): void {}
