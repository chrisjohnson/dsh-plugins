// The two dsh tool-runtime listeners, as plain functions. Pure: imports nothing
// from dsh, so the host registers them and the tests call them directly.
//
//   execute      wraps each browser_* call in the async-local store that tells
//                the patched controller which session is calling, and collects
//                the notices the controller left for the model.
//   postExecute  appends those notices to the same call's result text.
//
// Notices go through post-execute because a result changed inside `tools/execute`
// is re-rendered from its value and loses any edit to its content.

import { NO_AGENT_SESSION } from './routing.mjs'

const BROWSER_TOOL = /^browser_/
const NOTICE_PREFIX = 'dsh-browser: '

const UNATTACHED_NOTICE =
  "Session isolation and the remote browser are NOT in effect for this call; it used the original plugin's own shared browser. Tell the operator: dsh-browser is not attached to dsh-playwright-browser."

/**
 * @param {{ storage: { run(store: object, fn: () => any): any }, log: { error(...args: any[]): void } }} deps
 */
export function createToolBridge({ storage, log }) {
  const noticesByExecution = new WeakMap()
  const keyOf = (exec) => exec.token ?? exec

  async function execute(exec, next) {
    if (!BROWSER_TOOL.test(exec.name)) return next()
    const store = { sessionId: exec.agent?.id ?? NO_AGENT_SESSION, notices: new Set(), routed: false }
    try {
      const result = await storage.run(store, next)
      // A tool that succeeded without ever reaching a patched controller method
      // means the controller the tools use is not the class that was patched (a
      // second install of dsh-playwright-browser, or a partial hot reload). Say
      // so loudly: the call ran on the original plugin's own shared browser.
      if (!result.isError && !store.routed) {
        log.error(
          "%s ran on the original plugin's shared browser: its controller is not the class dsh-browser patched (duplicate dsh-playwright-browser install or partial reload)",
          exec.name,
        )
        store.notices.add(UNATTACHED_NOTICE)
      }
      return result
    } finally {
      if (store.notices.size > 0) noticesByExecution.set(keyOf(exec), [...store.notices])
    }
  }

  async function postExecute(exec, result, next) {
    const notices = noticesByExecution.get(keyOf(exec))
    if (notices === undefined) return next()
    noticesByExecution.delete(keyOf(exec))
    const decision = await next()
    // Only an accepted, content-bearing outcome can carry the lines; a block or a
    // value replacement is another policy's call and stays untouched.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    const content = decision.content ?? result.content
    const text = notices.map((line) => `${NOTICE_PREFIX}${line}`).join('\n')
    return { ...decision, content: [...content, { type: 'text', text }] }
  }

  return { execute, postExecute }
}
