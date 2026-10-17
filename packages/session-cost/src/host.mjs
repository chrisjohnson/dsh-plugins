// session-cost: host-plane Cordis plugin (minimal on purpose).
//
// The whole feature is a client-side badge: the browser half (src/client.mjs)
// reads the session's own `contextTimeline.cost` projection — the per-turn billed
// token buckets that dsh-context folds on every settlement — and prices them with
// the public rate table in src/prices.mjs. No host-side state, tool, service, or
// route is needed, so this apply is a no-op. It exists so the bundle row has a
// valid host entry to load; the `dsh.client` field is what mounts the badge.
export default function dshSessionCost(_ctx, _config) {
  // Nothing to install on the host plane. The cost badge is drawn in the browser
  // from the session's contextTimeline.cost projection (see src/client.mjs).
}
