# dsh-better-git-worktree

Git worktree **sessions** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a session can live in its own self-contained git working copy permanently, instead of the harness's review/acceptance lifecycle.

It borrows the UX of [`dsh-git-worktree`](https://github.com/wloops/dsh-git-worktree) (the composer switch, the session-list status indicator, the session-header menu) and drops everything else: there is no review checkpoint, no preview/apply, no delivery handoff. A working copy here is simply where the session works.

**Usage guide:** [`docs/USAGE.md`](docs/USAGE.md): surfaces, statuses, workflows, and a screenshot gallery.

![Session list statuses](docs/screenshots/02-session-list-statuses.png)

> The screenshots were taken on dsh 0.1.5 with the earlier, inlined version of this plugin. The session-row badge is now an icon in the row's leading cell instead of a text pill, so they are out of date until they are retaken on a 0.2.0 UI.

## What it does

- **Composer switch (blank sessions).** A `Worktree` toggle sits in the composer tool row. Turning it on opens one confirmation dialog; confirming creates the branch and working copy immediately and continues **that** session inside it. The toggle then reads ON and disabled.
- **`worktree_convert` tool.** Takes a session running in a checkout, creates a working copy, moves its uncommitted work into it (kept recoverable as a `git stash` entry), and continues the conversation in a session rooted there. Once a session is in a working copy the tool is denied for that agent's scope, so it leaves the tool list.
- **Session-list status badge**, on the session row: **blue** Progressing, **green** Up To Date / In Sync, **amber** Behind, **grey** Unknown/Missing, plus a **yellow glow** when the branch needs rebasing. The row's hover card spells out the full status.
- **Header pill and menu, for every session.** The pill reads `<name> - <status>` (`brave-otter - Progressing`, `main - In Sync`). Its menu offers *Git Changes*, *Review branch vs `<default>`*, *git fetch*, *Copy worktree path* / *Open worktree folder* for working-copy sessions, and *Move this session into a worktree* for the rest.
- **Session "..." menu**: *Copy worktree path* and *Open worktree folder* on a session that has a working copy.
- **Archiving a worktree session asks about the working copy.** The official *Archive* actions (the row's hover button and the "..." menu row) are shadowed: a session with a working copy opens one dialog (*Remove*, *Keep*, *Cancel*) that names the path and branch and warns about uncommitted paths and unpushed commits. *Remove* also retires the dead workspace registration. Every other session archives exactly as before.
- **Background git with a cache.** TTL cache (single-flight, stale-while-revalidate), a 15 s background refresher, and a 90 s-throttled `git fetch` of the source checkout that never blocks a read (a copy's own refs update when the copy fetches; see Working copies).

The official Workspace UI stays in charge of the sidebar; this plugin only adds to it through the seats that UI declares (see [How it plugs in](#how-it-plugs-in)). It does not replace or disable any core row.

## Install

Installed from a git tag of this repository; it is not published to npm. Replace `<version>` with a released version (tags are named `dsh-better-git-worktree-v<version>`; see [the tag list](https://github.com/chrisjohnson/dsh-plugins/tags)):

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-better-git-worktree-v<version>&path:/packages/better-git-worktree"
```

That installs the package into the profile and enables its bundle. If you manage the profile's `package.json` yourself, the pnpm equivalent is below, then also add `dsh-better-git-worktree` to the profile's `dsh.profile.bundles`:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-better-git-worktree-v<version>&path:/packages/better-git-worktree"
```

> **Warning:** never install it by bare name. Unscoped `dsh-*` names on the npm registry can belong to unrelated authors.

Restart dsh. If you ran an earlier, in-tree version of this plugin, also **remove its old `ui-workspace` row** (the one whose `disabled` expression tests `betterGitWorktreeWorkspaceProvider`) and its old `better-git-worktree` row pointing at an `entry-rN.mjs`: the official Workspace UI must stay active, and this plugin no longer elects itself in its place. A fresh install needs no other row.

## Configuration

Nothing is required.

| Key | Default | What it does |
| --- | --- | --- |
| `stateDir` | `<dsh home>/plugins/dsh-better-git-worktree` | Directory holding the session-to-working-copy registry (`worktrees.json`). Unset, it is where earlier releases kept it, so an existing registry is found with no configuration. A relative value resolves against the dsh home (`$DSH_HOME`, else `~/.dsh`), never the working directory; `~` is expanded. A blank or non-string value falls back to the default with a warning. |

A misspelled key is warned about once at boot and ignored. A bundle patch layer replaces a row's whole `config`, so if you set `stateDir` on your row, restate any other key you rely on.

## Working copies

A worktree session gets its own **self-contained working copy**, nested inside the checkout it was branched from:

```
<repo>/.dsh-worktrees/<pet-name>/
```

It owns its git database (`git init` in place) and reads the checkout's objects through `.git/objects/info/alternates`, so nothing is downloaded, no object is duplicated, and no file is copied by a clone. The working tree is materialised from the session's starting commit, on a branch `dsh/<pet-name>`. A checkout that cannot be written to hosts its copies under `~/.dsh-worktrees/<pet-name>` instead.

That layout is what makes the sandbox sufficient. `dsh-sandbox` grants a session exactly one writable root, its own cwd, and a *linked* worktree keeps its index and refs in the source repository, one directory outside it, so `git add`, `commit`, `push` and anything that shells out to git would stop for an escalation. Here every write git makes (index, refs, new objects) lands inside the copy, so plain `workspace-write` is enough.

Two trade-offs, deliberately accepted:

- It is not a linked worktree: the checkout's `git worktree list` does not show it, and its branch lives in the copy until it is pushed (pushes go to the same `origin` the checkout uses).
- It borrows the checkout's object store, so deleting that checkout loses history the copy has not republished.
- A new copy has only its own branch: `origin`'s refs (and so the comparison with the default branch, the *In Sync* state and the rebase glow) arrive with the copy's first `git fetch`, from the header menu or the agent.

The checkout's own `git status` stays clean because creating a copy writes `.dsh-worktrees/` into `<repo>/.git/info/exclude`: local to the clone, no tracked file touched. If that entry is ever missing, the header menu offers to write it again.

## Status semantics

| Badge | Meaning |
| --- | --- |
| blue `Progressing` | work is not published yet: no upstream, or commits ahead of it |
| amber `Behind` | the upstream moved on and the branch has nothing of its own |
| green `Up To Date` | exactly in step with its upstream, but not identical to `origin/<default>` |
| green `In Sync` | in step with its upstream **and** identical to `origin/<default>` |
| grey `Missing` | the recorded working-copy directory is gone |

A **yellow glow** is a separate overlay: the branch has its own commits and `origin/<default>` has moved on, so it needs rebasing. Working-tree detail (staged / modified / untracked) is in the hover text, not the colour.

## The registry

`$DSH_HOME/plugins/dsh-better-git-worktree/worktrees.json` is the only record of which session works in which copy. Its format (`"version": 1`) is the one every release of this plugin has written, and it is read unchanged. It is written atomically (temp file in the same directory, then rename), it is never written before it has been read, and records or fields this release does not understand are written back as they were. If the file exists but cannot be read, parsed, or has another version, the plugin says so at boot, **leaves the file alone**, runs with an empty in-memory registry, and refuses to create new copies (it could not record them).

## How it plugs in

Verified against `@deepseek-ai/dsh-client-ui-workspace` 0.2.0-rc.2 (`lib/types/client/contract/slots.d.ts`, `lib/client.js`):

| Seat | Used for |
| --- | --- |
| `sidebar.session.row.leading` | the status badge (rendered only by an idle row; a busy or pending row shows its own state dot instead) |
| `sidebar.session.row.hover` | the status text on the row's hover card |
| `sidebar.workspaces.session.menu.item` | *Copy worktree path*, *Open worktree folder*; and a same-id `archive` entry at priority -1 that shadows the official one |
| `sidebar.workspaces.session.row.action` | the same shadow for the hover archive button |
| `shell.overlay` | the archive dialog |
| `conversation.input.left` | the composer switch |
| `conversation.session.header.actions` | the header pill and menu |

A shadow reuses the official component and locale and the official inject result unchanged except for the `archiveSession` callback, which is wrapped so the dialog can run first. If the shadow ever crashes the renderer retires it and the official entry shows again.

`dsh-better-sidebar` is an optional integration: with it the header menu's *Review branch* opens a right-sidebar tab (and *Git Changes* opens its git lens); without it the review opens in a modal and *Git Changes* does the same.

## Known limits

- The keyboard shortcut for *Archive session* calls the official archive directly and is not intercepted: it archives without the dialog and leaves the working copy on disk (the *Keep* outcome).
- The status badge is drawn only in a row's leading seat, which the official UI renders only for an idle row. There is none on a busy row, a row with a pending interaction, a completed-unread row (its dot), a row with running subagents, an archived row or a blank session, and none in search results. The hover card still shows the status text where the row's hover seat is mounted.
- A working-copy session is a workspace of its own in the sidebar (named after the copy) and is listed in the new-session workspace dropdown; the official UI offers no seat to regroup it under the project it was branched from. The sidebar's "Group by: Workspace Tree" view option nests a copy under a registered repository workspace by path, but that is a per-browser setting the plugin cannot set.
- *Remove* in the archive dialog archives the session first and deletes the copy only if that succeeded, so it does nothing while the session is running (the harness refuses to archive running work): stop the session, then archive it again. The dialog's warnings count uncommitted paths and unpublished commits, including a fresh copy's local commits before it has ever fetched.
- A running session cannot change its checkout (`session.header.cwd` is immutable), so *convert* creates a session in the working copy and continues the conversation there.
- `Open worktree folder` needs a desktop opener on the host (`xdg-open`, `gio`, ... `open` on macOS, `explorer` on Windows); without one the menu says so.

## Session format

This plugin writes no messages of its own into sessions. A continuation session is seeded with the source session's events through its last completed turn (format V4 events, unchanged).

## Checks

```sh
node --test packages/better-git-worktree/test/*.test.mjs
node scripts/verify.mjs --package dsh-better-git-worktree
```

The tests use real temporary git repositories for creation, change-move, status folding and review, and mount the real host on a mock context.

## Compatibility

Requires dsh 0.2.0-rc.2 or later (`engines.dsh` and the `@deepseek-ai/dsh-tools` peer: `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`).

## License

MIT. See [`NOTICE`](NOTICE) for attribution.
