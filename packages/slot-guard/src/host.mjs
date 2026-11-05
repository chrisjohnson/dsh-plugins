// dsh-slot-guard: host-plane Cordis plugin.
//
// One line at boot, and nothing else. The whole plugin is the browser half
// (src/client.mjs): a slot crash is a render-time event in the user's page, so
// only the page can see it. The host half stays out of the way — no services, no
// routes, no slots — which is also what makes this bundle safe to add to a
// deployment that is already misbehaving: if the browser half fails to load, the
// host logs that it is mounted and the page is untouched.
//
// @param ctx - Host context.
export default function slotGuard(ctx) {
  const log = ctx.logger('slot-guard')
  log.info(
    'slot-guard mounted: the browser half decodes slot crashes (React #300/#310/#311), styles the crash face, and overlays a white page. State: window.__dshSlotGuard'
  )
}
