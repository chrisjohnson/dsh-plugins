// dsh-math-literal: Host entry (thin re-export).
//
// The whole host half is in src/host.mjs: one `webserver/index-inject`
// subscription that pushes the head-script wrapper. The wrapper source lives
// in src/wrapper.mjs so it is unit-testable without a Host context.
export { apply } from "./src/host.mjs";
