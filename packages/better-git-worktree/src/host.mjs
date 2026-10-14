// dsh-better-git-worktree: Host half.
//
// A session can live in a self-contained git working copy *permanently*: created
// up front from the composer's Worktree switch, or moved there mid-session by the
// `worktree_convert` tool or the header menu. Nothing here reviews, merges or
// delivers: the working copy is just where the session works, and the branch is
// the user's to push.
//
// The behaviour is in service.mjs (status pipeline, creating, converting,
// removing, the endpoints); this file is the dsh wiring around it:
//
//   - a plugin-owned JSON route, `POST /betterGitWorktree/<endpoint>`, trust-checked
//     through the connection service, that the browser half calls;
//   - the model-facing `worktree_convert` tool, hidden from sessions that already
//     live in a working copy;
//   - a per-session system-prompt context naming the authoritative directory;
//   - the background status refresh.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { resolveSettings } from './config.mjs'
import { REGISTRY_FILE, WorktreeRegistry } from './registry.mjs'
import { BACKGROUND_REFRESH_MS, createService } from './service.mjs'
import { forkSeed } from './session-fork.mjs'

export const name = 'dsh-better-git-worktree'

/** Browser-facing JSON route owned by this plugin. */
export const RPC_PATH = '/betterGitWorktree'
const MAX_BODY_BYTES = 1024 * 1024

const PROMPT_CONTEXT_NAME = 'better-git-worktree:session-root'
const PROMPT_CONTEXT_ORDER = 118

const message = (error) => (error instanceof Error ? error.message : String(error))

/** Collect one bounded JSON request body. */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The text a worktree session's model reads about where it works. The session's
 * cwd already is the working copy; this makes the boundary explicit and says the
 * one thing a model would otherwise get wrong: git works here without any
 * escalation, because the copy owns its git database.
 */
export function sessionRootContext(record) {
  return [
    'This session works inside an isolated, self-contained git working copy, not the main checkout.',
    `Authoritative working directory: ${record.managedRoot}`,
    `Branch: ${record.branch}${record.baseRef ? ` (compares against ${record.baseRef})` : ''}`,
    'Run git the normal way. This working copy owns its git database, so add, commit and push work under the '
      + 'ordinary sandbox with no escalation.',
    'Never write to the original checkout.',
  ].join('\n')
}

/** The text the `worktree_convert` tool returns to the model. */
export function convertReport(result, status) {
  const lines = [
    'Moved this session into a git worktree.',
    `Worktree: ${result.record.managedRoot}`,
    `Branch: ${result.record.branch}${result.record.baseBranch ? ` (based on ${result.record.baseBranch})` : ''}`,
    result.move.moved
      ? `Moved ${result.move.files} changed path(s) from the original checkout; the backup stash entry is ${result.move.stashRef}.`
      : 'The original checkout had no uncommitted changes to move.',
  ]
  if (result.ok === true) {
    lines.push(
      result.conversationCarried
        ? `Continuing in session ${result.targetSessionId}, whose working directory is the worktree.`
        : `A new session (${result.targetSessionId}) was created in the worktree; open it to continue there.`,
    )
  } else {
    lines.push(`The worktree is ready but the session handoff failed: ${result.error}`)
    lines.push('Open a session in the worktree from the Worktree menu to continue there.')
  }
  return {
    kind: 'worktree_converted',
    managedRoot: result.record.managedRoot,
    branch: result.record.branch,
    baseRef: result.record.baseRef ?? undefined,
    targetSessionId: result.ok === true ? result.targetSessionId : undefined,
    conversationCarried: result.ok === true ? result.conversationCarried : false,
    movedFiles: result.move.files,
    stashRef: result.move.stashRef ?? undefined,
    status: status?.state ?? 'progressing',
    detail: lines.join('\n'),
  }
}

/**
 * Create the session that continues `source`'s conversation inside the working
 * copy.
 *
 * The harness cannot re-root a live session, so the continuation is a forged
 * child session: same conversation prefix, new cwd. When the fork cannot be
 * built (no completed turn yet) a plain empty session in the working copy is
 * still better than nothing, and the caller reports which one happened.
 */
async function createWorktreeSessionFor(ctx, source, record) {
  const sessionId = `session-${randomUUID()}`
  const agentLoop = ctx.get('agentLoop')
  if (agentLoop === undefined || typeof agentLoop.createAgent !== 'function') {
    throw new Error('ctx.agentLoop is unavailable, so a worktree session cannot be created')
  }
  const seed = forkSeed(source.session)
  const agentPreset = ctx.get('agentPresets')?.composedPreset?.(source.ctx)
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
  const options = {
    sessionId,
    meta: {
      cwd: record.managedRoot,
      // Lineage only when the conversation prefix actually came along: a
      // seeded marker without a seed would misreport the new session's origin.
      ...(seed.length > 0 ? { parentSession: source.session.id, isSeeded: true } : {}),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
    ...(seed.length > 0 ? { seed, inheritedEventCount: seed.length } : {}),
    agentOptions: {
      ...(selection.provider === undefined ? {} : { provider: selection.provider }),
      ...(selection.model === undefined ? {} : { model: selection.model }),
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
  }
  await agentLoop.createAgent(ctx, options)
  return { sessionId, carried: seed.length > 0 }
}

export default function betterGitWorktree(ctx, config = {}) {
  const log = typeof ctx.logger === 'function' ? ctx.logger(name) : console
  const settings = resolveSettings(config)
  for (const warning of settings.warnings) log.warn(warning)

  const registry = new WorktreeRegistry(join(settings.stateDir, REGISTRY_FILE))
  if (registry.problem !== undefined) {
    log.warn(`${registry.problem}; working copies already recorded keep working on disk but sessions will not be bound to them, and no new copies will be created until the file is readable`)
  }

  const agents = () => {
    try {
      return ctx.get('agents')
    } catch {
      return undefined
    }
  }
  const service = createService({
    registry,
    log,
    home: homedir(),
    getAgent: (sessionId) => agents()?.get?.(sessionId),
    workspaceRegistry: () => ctx.get('workspaceRegistry'),
    createSession: (source, record) => createWorktreeSessionFor(ctx, source, record),
  })

  // -- RPC surface (client -> host) ---------------------------------------------
  //
  // A plugin-owned route rather than `connection.rpc.handle`: a channel registered
  // there is mounted from a child scope and was observed answering 405. This route
  // reuses the same trust fence (`connection.requestRejection` is a public method)
  // and speaks plain JSON instead of the RPC envelope.
  ctx.inject(['connection', 'webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      log.warn('webServer is unavailable; the sidebar and composer surfaces stay off')
      return
    }
    scope.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: RPC_PATH,
          handler: async (req, res) => {
            try {
              const connection = scope.get('connection')
              const rejection =
                connection !== undefined && typeof connection.requestRejection === 'function'
                  ? connection.requestRejection(req)
                  : undefined
              if (rejection !== undefined) {
                res.writeHead(rejection)
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
                return
              }
              if (req.method !== 'POST') {
                res.writeHead(405)
                res.end('method not allowed')
                return
              }
              const url = new URL(req.url ?? '/', 'http://dsh.internal')
              const endpoint = decodeURIComponent(url.pathname.slice(RPC_PATH.length + 1))
              const payload = await readJsonBody(req)
              const result = await service.handleRpc(endpoint, payload)
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(result))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: message(error), details: {} } }))
            }
          },
        }),
      'dsh-better-git-worktree: rpc route',
    )
  })

  // -- model tool ---------------------------------------------------------------

  /** Whether a live agent is already a worktree session (recorded, or rooted in a managed copy). */
  const inWorktree = (agent) => {
    const managedRoots = new Set(registry.list().map((record) => record.managedRoot))
    const cwd = agent?.session?.header?.cwd
    return registry.get(agent.id) !== undefined || (typeof cwd === 'string' && managedRoots.has(cwd))
  }

  ctx.inject(['tools'], (scope) => {
    scope.effect(
      () =>
        scope.tools.register(
          defineTool({
            name: 'worktree_convert',
            description:
              'Move this session into an isolated git worktree. Creates a branch and an isolated working copy for '
              + 'the current repository, moves the uncommitted working-tree changes into it (kept recoverable as a git '
              + 'stash entry), and continues this conversation in a new session rooted there. Use it when work should '
              + 'stop touching the main checkout. Do not call it when the session is already a worktree session.',
            parameters: {},
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true },
                  managedRoot: { type: 'string', required: true },
                  branch: { type: 'string', required: true },
                  baseRef: { type: 'string' },
                  targetSessionId: { type: 'string' },
                  conversationCarried: { type: 'boolean', required: true },
                  movedFiles: { type: 'number', required: true },
                  stashRef: { type: 'string' },
                  status: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                },
              },
              render: (_args, value) => [{ type: 'text', text: value.detail }],
            },
            async execute(_args, exec) {
              const sessionId = exec?.agent?.session?.id
              if (typeof sessionId !== 'string') throw new Error('worktree_convert can only run inside a DSH session')
              const already = registry.get(sessionId)
              if (already !== undefined) {
                throw new Error(
                  `this session is already a worktree session at ${already.managedRoot} (branch ${already.branch}); nothing to convert`,
                )
              }
              const result = await service.convertSession(sessionId)
              const status = await service.statusFor(sessionId).catch(() => undefined)
              return convertReport(result, status)
            },
            presentCall: () => ({ card: 'generic', title: 'Move into a git worktree', kind: 'other', rawInput: {} }),
          }),
        ),
      'dsh-better-git-worktree: worktree_convert tool',
    )
  })

  // -- per-agent composition ------------------------------------------------------
  //
  // Once a session is a worktree session the tool has done its job: it is denied
  // in that agent's scope so it disappears from the model's tool list. And the
  // model is told where it works, through a prompt context registered in the same
  // scope (an assembly carries a scope key, not an agent, so the context is bound
  // to its agent when it is registered).
  const composed = new WeakSet()
  const composeAgent = (agent) => {
    if (agent === undefined || agent === null || composed.has(agent)) return
    composed.add(agent)
    try {
      // Only `worktree_convert` is hidden here. Whether a session is a worktree
      // session can still change after creation (a conversion registers the
      // record afterwards), so a one-shot deny would hide a tool for good.
      if (inWorktree(agent)) agent.ctx.tools.restrict({ deny: ['worktree_convert'] })
    } catch (error) {
      log.warn(`could not scope the worktree tools for ${agent.id}: ${message(error)}`)
    }
    try {
      agent.ctx.systemPrompt.context({
        name: PROMPT_CONTEXT_NAME,
        order: PROMPT_CONTEXT_ORDER,
        text: () => {
          const record = registry.get(agent.id)
          return record === undefined ? '' : sessionRootContext(record)
        },
      })
    } catch (error) {
      log.warn(`could not add the worktree prompt context for ${agent.id}: ${message(error)}`)
    }
  }
  for (const agent of agents()?.list?.() ?? []) composeAgent(agent)
  ctx.on('agent/created', (payload) => composeAgent(payload?.agent))

  // -- background refresh -------------------------------------------------------

  const timer = ctx.get('timer')
  if (timer !== undefined && typeof timer.interval === 'function') {
    const disposeTimer = timer.interval(() => service.warmAll(), BACKGROUND_REFRESH_MS)
    ctx.effect(() => disposeTimer, 'dsh-better-git-worktree: status refresh')
  } else {
    const handle = setInterval(() => service.warmAll(), BACKGROUND_REFRESH_MS)
    handle.unref?.()
    ctx.effect(() => () => clearInterval(handle), 'dsh-better-git-worktree: status refresh')
  }

  ctx.on('ready', () => {
    service.warmAll()
    for (const record of registry.list()) service.kickFetch(record.repoRoot)
  })

  log.info(`mounted (${registry.list().length} worktree session(s) registered)`)
}
