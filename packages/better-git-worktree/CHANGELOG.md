# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

## 0.1.0

First release: the in-tree `dsh-better-git-worktree` plugin of a private deployment, rebuilt for dsh 0.2.0-rc.2 or later. The registry format (`STATE_VERSION 1`), the working-copy layout (`<repo>/.dsh-worktrees/<pet>`, branch `dsh/<pet>`), the RPC route (`/betterGitWorktree`), the `worktree_convert` tool and the status vocabulary are unchanged, so sessions already bound to a working copy keep their status and binding.

### Changed (behaviour differences from the in-tree plugin)

- **The client no longer inlines the official workspace client.** The generated `client.js`, its template, the string "seams", `scripts/build-client.mjs` and the `entry-rN.mjs` shims are gone. The 0.1.5 seams would break on 0.2.0 (7 of 9 do), and the official Workspace UI now stays active: the plugin adds to it through the seats it declares (`sidebar.session.row.leading` / `.hover`, `sidebar.workspaces.session.menu.item`, `sidebar.workspaces.session.row.action`).
- **No `ui-workspace` election.** The plugin no longer disables the official Workspace row, publishes the `betterGitWorktreeWorkspaceProvider` marker, or needs a `ui-workspace` row in the profile (**remove it**).
- **Session-row badge.** An icon in the row's leading cell, coloured by status with the rebase glow, instead of a text pill (`Progressing`, `Up To Date`, ...) beside the status dot. The full status text is on the row's hover card as before. Because the seat is rendered only by an idle row, a busy or pending row shows no badge; there is none in search results either (the old pill appeared there).
- **Worktree sessions are no longer regrouped under their project.** The old client rewrote the workspace list so a working-copy session appeared under the repository it was branched from and its host-registered workspace was hidden. The official UI has no seat for that, so a working-copy session is now its own workspace in the sidebar (named after the copy) and the copy is listed in the new-session workspace dropdown.
- **Archive prompt** is a shadow of the official `archive` entries (row hover button and "..." menu row, priority -1, official component and inject reused) instead of a patched archive callback, and it no longer also replaces `uiWorkspace.archiveSession` on the service. The keyboard shortcut for archiving is therefore not intercepted: it archives without the dialog and keeps the working copy.
- **Hover card width.** The best-effort widening of the hover card now matches `[class*='_card']` ancestors of the status line (the old selector matched 0.1.5's hashed class names); the card may stay at its default width.
- **System prompt context** is registered per agent in `agent/created` (and for agents already live at boot), because a 0.2.0 prompt assembly carries a scope key, not an agent. Its text no longer describes a *linked* worktree that is denied git commands and "approved once through the standard sandbox escalation": a working copy is self-contained, git runs normally, and the text says so.
- **Registry safety.** The registry is written atomically with a unique temp file, is never written before it has been read, preserves records and fields it does not understand, and is left untouched (with a boot warning, and new copies refused) when it exists but cannot be read, parsed or has another version. Before, any such file was treated as empty and overwritten by the next write.
- **`stateDir`** is now a documented key; a relative value resolves against the dsh home (before: against the process working directory), and the default follows `$DSH_HOME` through the same resolution as the harness (`~` expanded, made absolute).
- Icons use the 0.2.0 `*Regular` names (`IconBranchOutlineRegular`, ...).
- The plugin no longer stands down a leftover `dsh-git-worktree` loader row on boot.
- `worktree_convert` and the endpoints are otherwise unchanged. The Branch review tab and its fallback modal carry over; the tab is registered only when `dsh-better-sidebar` is present (through `ctx.inject(['betterSidebar'])`), as an optional integration.

- **Remove archives first.** The in-tree dialog deleted the working copy and then archived the session; the harness refuses to archive a session with running work, so cancelling its stop dialog left a running session in a deleted directory. *Remove* now archives through the official service first and deletes the copy only if that succeeded; a refused archive leaves the copy untouched and tells the user to stop the session. It therefore does nothing while the session runs.
- **The source of a converted session is archived with retries.** After the agent's `worktree_convert` the source turn is still running when the continuation opens, so the one archive attempt was refused and silently dropped, leaving both sessions in the sidebar. It is now retried with back-off (0, 3, 8, 20, 45, 90 s) and a warning is logged if it never succeeds.
- **Unpushed commits are counted before a copy's first fetch.** The archive dialog counted unpushed commits only against an upstream or `origin/<default>`, so a fresh copy's local commits were not warned about. Status now carries `unpublished` (commits reachable from no remote-tracking ref and no ref of the source repository, through the alternate) and the dialog uses it when there is no upstream.
- The images in `docs/screenshots` are kept in the repository but not shipped in the package until they are retaken on a 0.2.0 UI.
- A tool restriction the harness refuses is retried on the next refresh tick instead of being given up on.

### Added

- Session "..." menu rows *Copy worktree path* and *Open worktree folder* for sessions with a working copy (*Open worktree folder* only when the host has a folder opener; a missing or failing clipboard, or a failed open, is reported in a notice).
- `snapshot` returns `registry: { writable, problem }`, and each entry carries its `decoration` and `archive` plan, computed on the host (`src/status.mjs`) so the browser only draws them.
- Tests: status derivation, registry load/round-trip/refusal (a registry in the real v1 shape), config, removal policy, fork seed (V4 events), folder opener, working-copy creation / change-move / status / review against real temporary git repositories, the service endpoints, the real host on a mock context (including 15 v1-bound sessions), and the browser half's seat and shadowing contract.

### Removed

- The inert approval answerer (it was registered on three contexts and never dispatched to), its `approvals.jsonl` audit file, `host/approval.mjs` and `scripts/test-approval.mjs`.
- `scripts/dev-reload-host.mjs` and the versioned entry shims. Ship a version instead.
- Prompt, header and doc text about linked worktrees and sandbox escalation.

