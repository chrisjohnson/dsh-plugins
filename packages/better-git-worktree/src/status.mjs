// The status vocabulary of dsh-better-git-worktree, as pure functions. No git, no
// dsh: git output goes in as text or numbers, and what comes out is what the
// sidebar row, the header pill, the hover card and the archive dialog show. One
// vocabulary feeds all of them, so they can never disagree.

/** Strip a trailing newline only; git output is otherwise significant. */
export function lines(text) {
  if (text === undefined) return []
  const trimmed = text.replace(/\n$/, '')
  return trimmed === '' ? [] : trimmed.split('\n')
}

/** Parse `git status --porcelain=v1 -z` into change counts. */
export function parsePorcelain(text) {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  const files = []
  const tokens = text.split('\0')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '') continue
    const xy = token.slice(0, 2)
    const path = token.slice(3)
    if (xy === '??') {
      untracked += 1
    } else {
      if (xy[0] !== ' ' && xy[0] !== '?') staged += 1
      if (xy[1] !== ' ' && xy[1] !== '?') unstaged += 1
      // A rename/copy emits a second NUL-framed path we do not need.
      if (xy[0] === 'R' || xy[0] === 'C') index += 1
    }
    if (files.length < 200) files.push({ path, xy })
  }
  return { staged, unstaged, untracked, files, dirty: staged + unstaged + untracked }
}

/** Parse `git rev-list --left-right --count A...B` into `{ left, right }`. */
export function parseLeftRight(text) {
  if (text === undefined) return undefined
  const parts = text.trim().split(/\s+/)
  if (parts.length !== 2) return undefined
  const left = Number(parts[0])
  const right = Number(parts[1])
  if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined
  return { left, right }
}

/**
 * The one status vocabulary shared by the sidebar badge, the header pill, and
 * every tooltip.
 *
 *   progressing  work is not published yet: no upstream, or commits ahead of it
 *   behind       the upstream moved on and this branch has nothing of its own
 *   up_to_date   exactly in step with its upstream, but not identical to
 *                `origin/<default>`
 *   in_sync      in step with its upstream AND identical to `origin/<default>`
 *
 * The needs-rebasing glow is a separate overlay: a branch with its own commits
 * and a default branch that has moved on.
 */
export function worktreeState(measured) {
  const { upstream, aheadUpstream, behindUpstream, baseRef, aheadBase, behindBase } = measured
  if (upstream === undefined || upstream === '') return 'progressing'
  if ((aheadUpstream ?? 0) > 0) return 'progressing'
  if ((behindUpstream ?? 0) > 0) return 'behind'
  if (baseRef !== undefined && (aheadBase ?? 0) === 0 && (behindBase ?? 0) === 0) return 'in_sync'
  return 'up_to_date'
}

/** Whether the branch has its own commits while the default branch has moved on. */
export function needsRebase(measured) {
  return (measured.behindBase ?? 0) > 0 && (measured.aheadBase ?? 0) > 0
}

/**
 * The hover-card / tooltip summary of a status object.
 *
 * Two lines on purpose: the first says which checkout this is, the second how it
 * stands: upstream, working tree, comparison with the default branch. One
 * run-on line is unreadable at hover-card width, and both the harness hover card
 * and a native `title` render the newline.
 */
export function statusSummary(status, options = {}) {
  const head = []
  const branch = status.branch ?? '(detached HEAD)'
  if (options.petName) head.push(`Worktree ${options.petName}`)
  head.push(`branch ${branch}`)
  if (options.managedRoot) head.push(`at ${options.managedRoot}`)

  const body = []
  if (status.state === 'progressing') {
    if (status.upstream === undefined) {
      const ahead = status.aheadBase ?? 0
      body.push(
        ahead > 0
          ? `Progressing: ${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${status.baseRef ?? 'the base branch'}, nothing published yet`
          : 'Progressing: not published yet (no upstream)',
      )
    } else {
      body.push(`Progressing: ${status.aheadUpstream} unpushed commit${status.aheadUpstream === 1 ? '' : 's'} on ${status.upstream}`)
    }
  } else if (status.state === 'behind') {
    body.push(`Behind ${status.upstream} by ${status.behindUpstream} commit${status.behindUpstream === 1 ? '' : 's'}`)
  } else if (status.state === 'up_to_date') {
    body.push(`Up to date with ${status.upstream}`)
  } else if (status.state === 'in_sync') {
    body.push(`In sync with ${status.upstream}`)
  }

  const dirtyParts = []
  if (status.staged > 0) dirtyParts.push(`${status.staged} staged`)
  if (status.unstaged > 0) dirtyParts.push(`${status.unstaged} modified`)
  if (status.untracked > 0) dirtyParts.push(`${status.untracked} untracked`)
  body.push(dirtyParts.length > 0 ? `Working tree: ${dirtyParts.join(', ')}` : 'Working tree: clean')

  if (status.needsRebase) {
    body.push(`Needs rebasing: ${status.baseRef} has ${status.behindBase} commit${status.behindBase === 1 ? '' : 's'} this branch does not have`)
  } else if (status.baseRef !== undefined && (status.aheadBase ?? 0) === 0 && (status.behindBase ?? 0) === 0) {
    body.push(`Same commit as ${status.baseRef}`)
  } else if (status.baseRef !== undefined && (status.aheadBase ?? 0) > 0) {
    body.push(`${status.aheadBase} commit${status.aheadBase === 1 ? '' : 's'} ahead of ${status.baseRef}, not merged`)
  }
  if (status.lastCommit) body.push(status.lastCommit)

  return [head.join(' · '), body.join(' · ')].join('\n')
}

const STATE_LABELS = {
  progressing: 'Progressing',
  behind: 'Behind',
  up_to_date: 'Up To Date',
  in_sync: 'In Sync',
  unknown: 'Unknown',
}

/** The display word for a status state. */
export function stateLabel(state) {
  return STATE_LABELS[state] ?? STATE_LABELS.unknown
}

/** What to call a checkout on screen: its pet name, else its branch. */
export function checkoutName(entry) {
  if (entry === undefined || entry === null) return undefined
  if (typeof entry.petName === 'string' && entry.petName !== '') return entry.petName
  if (typeof entry.branch === 'string' && entry.branch !== '') return entry.branch
  return undefined
}

/**
 * Everything the browser draws about one checkout's status, derived once on the
 * host from the merged status object: the badge state and word, the rebase glow,
 * the tooltip, and the header pill's text.
 */
export function decorationOf(entry) {
  if (entry === undefined || entry === null) return undefined
  const name = checkoutName(entry)
  if (entry.missing === true || entry.state === 'unknown') {
    const label = entry.missing === true ? 'Missing' : 'Unknown'
    return {
      state: 'unknown',
      label,
      needsRebase: false,
      tooltip: entry.tooltip || 'The managed worktree no longer exists on disk.',
      name,
      // The pill names the state, not the cause, so a missing copy reads "Unknown".
      title: `${name === undefined ? 'No repository' : name} - ${stateLabel('unknown')}`,
    }
  }
  const state = typeof entry.state === 'string' ? entry.state : 'unknown'
  return {
    state,
    label: stateLabel(state),
    needsRebase: entry.needsRebase === true,
    tooltip: entry.tooltip || '',
    name,
    title: `${name === undefined ? 'No repository' : name} - ${stateLabel(state)}`,
  }
}

/**
 * Whether archiving a session needs the working-copy dialog, and what the dialog
 * warns about. Only a session with a managed working copy that still exists has
 * anything to decide: a plain checkout session is archived straight away, keeping
 * its directory (which is the workspace itself), and a copy whose directory is
 * already gone has nothing left to remove.
 */
export function archivePlan(entry) {
  const managed = entry !== undefined && entry !== null && entry.missing !== true && typeof entry.managedRoot === 'string'
  if (!managed) return { prompt: false, dirty: 0, unpushed: 0 }
  const dirty = typeof entry.dirty === 'number' ? entry.dirty : 0
  const unpushed = typeof entry.aheadUpstream === 'number' ? entry.aheadUpstream : (entry.aheadBase || 0)
  return { prompt: true, dirty, unpushed }
}
