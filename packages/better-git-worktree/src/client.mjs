// dsh-better-git-worktree: Client half (browser bundle).
//
// The official Workspace UI stays in charge of the sidebar. This half adds to it
// only through the seats that UI declares (dsh 0.2.0, @deepseek-ai/dsh-client-ui-workspace):
//
//   sidebar.session.row.leading           the status badge in a session row
//   sidebar.session.row.hover             the full status line on the row's hover card
//   sidebar.workspaces.session.menu.item  "Copy worktree path" / "Open worktree folder"
//   sidebar.workspaces.session.menu.item  (id `archive`) and
//   sidebar.workspaces.session.row.action (id `archive`)
//                                         the official archive actions, shadowed so a
//                                         worktree session asks what to do with its
//                                         working copy before the archive call goes through
//   shell.overlay                         the archive dialog
//
// and through the conversation seats:
//
//   conversation.input.left               the composer's Worktree switch (blank sessions)
//   conversation.session.header.actions   the header pill and its menu
//
// A right-sidebar "Branch" review tab is registered through dsh-better-sidebar
// when that plugin is present; without it the same content opens in a modal.
//
// Everything about a checkout's status is computed on the Host half and read here
// over the plugin-owned route (POST /betterGitWorktree/<endpoint>); this file only
// draws it.
//
// The module loader hands this file React and the primitives as shared externals;
// it cannot import a sibling module, so everything it needs is in this file.

window.__ModuleLoader__.load({
	id: "dsh-better-git-worktree",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var h = React.createElement;

		// ================================================================
		// styles
		// ================================================================
		var RPC_PATH = "/betterGitWorktree";
		var SHADOW_PRIORITY = -1;
		var CSS =
			":root{--bgw-progressing:#1d4ed8;--bgw-progressing-bg:rgba(59,130,246,.12);--bgw-progressing-line:rgba(59,130,246,.35);"
			+ "--bgw-done:#15803d;--bgw-done-bg:rgba(34,160,74,.12);--bgw-done-line:rgba(34,160,74,.35);"
			+ "--bgw-behind:#b45309;--bgw-behind-bg:rgba(180,83,9,.12);--bgw-behind-line:rgba(180,83,9,.35)}"
			// The row badge fills the row's 16px leading cell: an icon in the status colour.
			+ ".bgw-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;border-radius:5px;box-sizing:border-box;border:1px solid transparent}"
			+ ".bgw-badge[data-bgw-state=progressing]{color:var(--bgw-progressing);background:var(--bgw-progressing-bg);border-color:var(--bgw-progressing-line)}"
			+ ".bgw-badge[data-bgw-state=up_to_date],.bgw-badge[data-bgw-state=in_sync]{color:var(--bgw-done);background:var(--bgw-done-bg);border-color:var(--bgw-done-line)}"
			+ ".bgw-badge[data-bgw-state=behind]{color:var(--bgw-behind);background:var(--bgw-behind-bg);border-color:var(--bgw-behind-line)}"
			+ ".bgw-badge[data-bgw-state=unknown]{color:var(--dsw-alias-label-secondary,#666);background:rgba(120,120,120,.12);border-color:rgba(120,120,120,.3)}"
			+ ".bgw-badge[data-bgw-rebase=true]{box-shadow:0 0 0 2px rgba(234,179,8,.55),0 0 9px 2px rgba(234,179,8,.45);animation:bgw-rebase-pulse 2.2s ease-in-out infinite}"
			+ "@keyframes bgw-rebase-pulse{0%,100%{box-shadow:0 0 0 2px rgba(234,179,8,.5),0 0 5px 1px rgba(234,179,8,.35)}50%{box-shadow:0 0 0 3px rgba(234,179,8,.7),0 0 12px 3px rgba(234,179,8,.55)}}"
			+ "@media (prefers-color-scheme:dark){.bgw-badge[data-bgw-state=progressing]{color:#93c5fd}.bgw-badge[data-bgw-state=up_to_date],.bgw-badge[data-bgw-state=in_sync]{color:#86efac}.bgw-badge[data-bgw-state=behind]{color:#fcd34d}}"
			// Hide the git worktree status on narrow (mobile) viewports: the header
			// pill crowds the session toolbar (and gets clipped) while the row badge
			// eats horizontal room in the sidebar; both are decorative at this width.
			// Breakpoint pairs with dsh-better-sidebar's NARROW_MAX_WIDTH (768).
			+ "@media (max-width: 767px){.bgw-badge,.bgw-header-action{display:none}}"
			// The header pill carries the same fill, border and text colour as the row
			// badge, including on hover (the harness button's grey hover would
			// otherwise wash the status colour out).
			+ ".bgw-header-action{border:1px solid transparent}"
			+ ".bgw-header-action:hover:not(:disabled){filter:brightness(.96)}"
			+ ".bgw-header-action[data-bgw-state=progressing]{color:var(--bgw-progressing);background:var(--bgw-progressing-bg);border-color:var(--bgw-progressing-line)}"
			+ ".bgw-header-action[data-bgw-state=up_to_date],.bgw-header-action[data-bgw-state=in_sync]{color:var(--bgw-done);background:var(--bgw-done-bg);border-color:var(--bgw-done-line)}"
			+ ".bgw-header-action[data-bgw-state=behind]{color:var(--bgw-behind);background:var(--bgw-behind-bg);border-color:var(--bgw-behind-line)}"
			+ ".bgw-header-action[data-bgw-state=unknown]{color:var(--dsw-alias-label-primary,#333);background:rgba(120,120,120,.12);border-color:rgba(120,120,120,.3)}"
			+ ".bgw-header-action:hover:not(:disabled)[data-bgw-state=progressing]{background:var(--bgw-progressing-bg)}"
			+ ".bgw-header-action:hover:not(:disabled)[data-bgw-state=up_to_date],.bgw-header-action:hover:not(:disabled)[data-bgw-state=in_sync]{background:var(--bgw-done-bg)}"
			+ ".bgw-header-action:hover:not(:disabled)[data-bgw-state=behind]{background:var(--bgw-behind-bg)}"
			+ ".bgw-header-action .bgw-pill-name{font-weight:600}"
			+ ".bgw-presession{display:inline-flex;align-items:center;gap:6px;flex:none}"
			+ ".bgw-presession-label{font:500 12px/16px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#666);cursor:default;user-select:none}"
			+ ".bgw-modal-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}"
			+ ".bgw-menu-summary{display:flex;flex-direction:column;gap:2px;max-width:280px;white-space:normal;font:400 11px/15px Inter,sans-serif;color:var(--dsw-alias-label-primary,#333)}"
			+ ".bgw-menu-summary span{opacity:.85}"
			+ ".bgw-menu-summary strong{font:600 12px/16px Inter,sans-serif;color:var(--dsw-alias-label-primary,#222)}"
			+ ".bgw-menu-error{color:var(--dsw-alias-state-error-primary,#c00)}"
			+ ".bgw-menu-notice{color:var(--bgw-done)}"
			+ ".bgw-menu-warn{color:var(--bgw-behind)}"
			// The hover-card line is a sentence, not a label: keep the line breaks the
			// Host writes, and give the card more width when it can be found.
			+ ".bgw-hover{display:flex;align-items:flex-start;gap:8px;color:#adb2b8;font-size:12px;line-height:18px}"
			+ ".bgw-hover svg{flex:none;margin-top:2px}"
			+ ".bgw-hover-status{white-space:pre-line}"
			+ "[class*='_card']:has(.bgw-hover-status){width:366px;max-width:366px}"
			+ "button[role=menuitem]:disabled:has(.bgw-menu-summary){opacity:1;cursor:default}"
			+ ".bgw-panel{display:flex;flex-direction:column;gap:10px;padding:10px 12px;height:100%;overflow:auto;font:400 12px/18px Inter,sans-serif;color:var(--dsw-alias-label-primary,#333)}"
			+ ".bgw-panel h4{margin:0;font:600 12px/18px Inter,sans-serif;color:var(--dsw-alias-label-primary,#222)}"
			+ ".bgw-panel .bgw-note{color:var(--dsw-alias-label-secondary,#666)}"
			+ ".bgw-panel .bgw-warn{color:#a16207;font-weight:600}"
			+ ".bgw-panel pre{margin:0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f6f6);overflow:auto;font:400 11px/16px ui-monospace,monospace}"
			+ ".bgw-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}"
			+ ".bgw-row{display:flex;gap:6px;align-items:baseline;font:400 11px/16px ui-monospace,monospace}"
			+ ".bgw-row .bgw-code{color:var(--dsw-alias-label-secondary,#777);flex:none}";

		function installStyles() {
			var style = document.createElement("style");
			style.dataset.dshBetterGitWorktree = "true";
			style.textContent = CSS;
			document.head.append(style);
			return function () {
				style.remove();
			};
		}

		// ================================================================
		// host transport + status store
		// ================================================================
		function rpc(endpoint, payload) {
			return fetch(RPC_PATH + "/" + encodeURIComponent(endpoint), {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify(payload === undefined ? {} : payload),
			}).then(function (response) {
				if (!response.ok) throw new Error("HTTP " + response.status + " from " + endpoint);
				return response.json();
			});
		}

		function failureOf(result, fallback) {
			return (result && result.error && result.error.message) || fallback;
		}

		/**
		 * A polled projection of the Host's registry. `entries` are the managed
		 * working copies; `current` holds a status read for the session on screen,
		 * which need not be a worktree session at all (the header pill describes any
		 * checkout). Decorations keep their identity while their content does not,
		 * so a row re-renders only when its own badge changes.
		 */
		function createStatusStore() {
			var listeners = new Set();
			var state = { decorations: {}, entries: [], current: {}, capabilities: {}, at: 0, error: null, ready: false };
			var tracked = null;
			var started = 0;
			var applied = 0;
			function emit() {
				for (var listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						console.error("[better-git-worktree] status listener failed", error);
					}
				}
			}
			function stableDecoration(previous, next) {
				if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) return previous;
				return next;
			}
			return {
				get: function () {
					return state;
				},
				/** The registry entry for a session: the copy itself, or the session continuing in it. */
				entryFor: function (sessionId) {
					for (var entry of state.entries) {
						if (entry && (entry.sessionId === sessionId || entry.targetSessionId === sessionId)) return entry;
					}
					return state.current[sessionId];
				},
				decorationFor: function (sessionId) {
					return state.decorations[sessionId];
				},
				/** Ask for this session's checkout status on every refresh. */
				track: function (sessionId) {
					if (tracked === sessionId) return;
					tracked = typeof sessionId === "string" ? sessionId : null;
					if (tracked !== null) void this.refresh(true);
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () {
						listeners.delete(listener);
					};
				},
				/** A refresh that bypasses the host's status cache (the archive dialog needs the present, not ~14 s ago). */
				refreshFresh: function () {
					return this.refresh(true, true);
				},
				/**
				 * Poll the host. Resolves `{ ok, error }` for THIS request, never rejects:
				 * a caller that needs the present (the archive dialog) must look at `ok`,
				 * because a failed read leaves the previous entries in place. Requests are
				 * sequenced by start order, so a slow older poll that finishes after a
				 * fresher one cannot overwrite it.
				 */
				refresh: function (force, fresh) {
					var seq = ++started;
					var outcome = { ok: false, error: null };
					var current = tracked === null ? Promise.resolve() : rpc("status", { sessionId: tracked, force: force === true })
						.then(function (result) {
							if (result && result.ok === true && result.value && result.value.status) {
								if (tracked !== null) state.current[tracked] = result.value.status;
							}
						})
						.catch(function () {});
					var snapshot = rpc("snapshot", fresh === true ? { force: true } : {})
						.then(function (result) {
							if (result && result.ok === true) {
								outcome.ok = true;
								if (seq < applied) return;
								applied = seq;
								var decorations = {};
								var entries = result.value.worktrees || [];
								for (var entry of entries) {
									if (!entry || typeof entry.sessionId !== "string" || !entry.decoration) continue;
									var decoration = stableDecoration(state.decorations[entry.sessionId], entry.decoration);
									decorations[entry.sessionId] = decoration;
									// A converted session keeps its record under the source
									// id; the session actually living in the working copy is
									// `targetSessionId`.
									if (typeof entry.targetSessionId === "string") decorations[entry.targetSessionId] = decoration;
								}
								state = Object.assign({}, state, {
									decorations: decorations,
									entries: entries,
									capabilities: result.value.capabilities || {},
									at: result.value.at,
									error: null,
									ready: true,
								});
							} else {
								outcome.error = failureOf(result, "snapshot failed");
								if (seq > applied) state = Object.assign({}, state, { error: outcome.error, ready: true });
							}
						})
						.catch(function (error) {
							outcome.error = String((error && error.message) || error);
							if (seq > applied) state = Object.assign({}, state, { error: outcome.error, ready: true });
						});
					return Promise.all([current, snapshot]).then(emit).then(function () {
						return outcome;
					});
				},
			};
		}

		var statusStore = createStatusStore();

		/** Re-render on every status emission (for the few components that read whole entries). */
		function useStatusVersion() {
			var pair = React.useState(0);
			var setVersion = pair[1];
			React.useEffect(function () {
				return statusStore.subscribe(function () {
					setVersion(function (value) {
						return value + 1;
					});
				});
			}, []);
			return pair[0];
		}

		/** One session's decoration; the component re-renders only when it changes. */
		function useDecoration(sessionId) {
			return React.useSyncExternalStore(statusStore.subscribe, function () {
				return statusStore.decorationFor(sessionId);
			});
		}

		// ================================================================
		// archive: decide the working copy's fate before the archive call
		// ================================================================
		var archivePrompt = {
			pending: null,
			listeners: new Set(),
			subscribe: function (listener) {
				this.listeners.add(listener);
				var self = this;
				return function () {
					self.listeners.delete(listener);
				};
			},
			emit: function () {
				for (var listener of Array.from(this.listeners)) listener();
			},
			open: function (sessionId, proceed) {
				this.pending = { sessionId: sessionId, proceed: proceed };
				this.emit();
			},
			close: function () {
				this.pending = null;
				this.emit();
			},
		};

		/**
		 * Wrap the official archive callback. A session with a managed working copy
		 * opens the dialog, and the original callback (with whatever it was injected
		 * with) runs once the user has chosen; everything else goes straight through.
		 */
		function interceptArchive(original) {
			return function (sessionId) {
				var entry = typeof sessionId === "string" ? statusStore.entryFor(sessionId) : undefined;
				var plan = entry && entry.archive;
				if (!plan || plan.prompt !== true) return original.apply(this, arguments);
				var args = arguments;
				var self = this;
				archivePrompt.open(sessionId, function () {
					return original.apply(self, args);
				});
				// The plan on screen may be seconds old: read the present state now
				// (the dialog re-renders when it arrives).
				void statusStore.refreshFresh();
				return undefined;
			};
		}

		function useArchivePromptVersion() {
			var pair = React.useState(0);
			var setVersion = pair[1];
			React.useEffect(function () {
				return archivePrompt.subscribe(function () {
					setVersion(function (value) {
						return value + 1;
					});
				});
			}, []);
			return pair[0];
		}

		/** A short message for something a menu row could not do (a row has no room of its own). */
		var notice = {
			message: null,
			listeners: new Set(),
			subscribe: function (listener) {
				this.listeners.add(listener);
				var self = this;
				return function () {
					self.listeners.delete(listener);
				};
			},
			show: function (message) {
				this.message = message;
				for (var listener of Array.from(this.listeners)) listener();
			},
		};

		function useNoticeVersion() {
			var pair = React.useState(0);
			var setVersion = pair[1];
			React.useEffect(function () {
				return notice.subscribe(function () {
					setVersion(function (value) {
						return value + 1;
					});
				});
			}, []);
			return pair[0];
		}

		/** Archive through the official service, which refuses a session that is still running. */
		function archiveNow(services, sessionId) {
			if (services.uiWorkspace && typeof services.uiWorkspace.archiveSession === "function") {
				return Promise.resolve(services.uiWorkspace.archiveSession(sessionId));
			}
			return Promise.resolve(services.workspaces.archiveSession(sessionId));
		}

		/** The shell overlay: the archive dialog, and a notice for what a menu row could not do. */
		function WorktreeOverlay(props) {
			return h(React.Fragment, null, h(ArchiveWorktreePrompt, props), h(NoticeDialog, null));
		}

		function NoticeDialog() {
			useNoticeVersion();
			if (notice.message === null) return null;
			return h(primitives.Modal, {
				open: true,
				onClose: function () {
					notice.show(null);
				},
				title: "Worktree",
				closeLabel: "Close",
			}, h("p", { className: "bgw-menu-error" }, notice.message));
		}

		var NO_PLAN = { prompt: true, dirty: 0, unpushed: 0, stashes: 0, unknown: false, reasons: [], ignored: null, operations: [] };

		/** What the dialog warns about for one session, with every field present. */
		function planFor(entry) {
			return Object.assign({}, NO_PLAN, (entry && entry.archive) || {});
		}

		/** Whether the harness lists a session as archived (an archived session no longer works in its directory). */
		function isArchived(services, sessionId) {
			try {
				var snapshot = services.workspaces.list.getSnapshot();
				return Array.isArray(snapshot.archivedSessionIds) && snapshot.archivedSessionIds.indexOf(sessionId) !== -1;
			} catch (error) {
				return false;
			}
		}

		/**
		 * Whether the copy of `sessionId` is still the working directory of a
		 * different session that is not archived. A converted copy's record belongs
		 * to the source session and names the continuation as `targetSessionId`;
		 * once that continuation is archived the source may remove the copy.
		 */
		function liveElsewhere(entry, sessionId, services) {
			return Boolean(entry) && typeof entry.targetSessionId === "string" && entry.targetSessionId !== sessionId
				&& !isArchived(services, entry.targetSessionId);
		}

		/** Whether more is at stake now than the dialog showed, or the copy can no longer be verified. */
		function planGotWorse(shown, now) {
			return (now.unknown && !shown.unknown) || now.dirty > shown.dirty || now.unpushed > shown.unpushed || now.stashes > shown.stashes;
		}

		function ArchiveWorktreePrompt(props) {
			var services = props.services;
			useArchivePromptVersion();
			useStatusVersion();
			var pair = React.useState({ busy: null, error: null, archived: false });
			var state = pair[0];
			var setState = pair[1];
			var pending = archivePrompt.pending;
			if (pending === null) return null;
			var entry = statusStore.entryFor(pending.sessionId) || {};
			var plan = planFor(entry);
			var otherLive = liveElsewhere(entry, pending.sessionId, services);
			var blocked = plan.unknown || otherLive;

			var close = function () {
				if (state.busy !== null) return;
				setState({ busy: null, error: null, archived: false });
				archivePrompt.close();
			};
			var archiveOnly = function () {
				var request = pending;
				setState({ busy: null, error: null, archived: false });
				archivePrompt.close();
				void request.proceed(request.sessionId);
			};
			var verify = async function (sessionId, holder) {
				var refreshed;
				try {
					refreshed = await statusStore.refreshFresh();
				} catch (error) {
					refreshed = { ok: false, error: String((error && error.message) || error) };
				}
				// A failed read leaves the old entries in place; comparing them with
				// themselves would pass. A failed re-check is a refusal.
				if (!refreshed || refreshed.ok !== true) {
					return "The working copy could not be re-checked (" + String((refreshed && refreshed.error) || "no answer") + "), so it was not removed.";
				}
				var latest = statusStore.entryFor(sessionId);
				var now = planFor(latest);
				if (!latest || !latest.archive || latest.archive.prompt !== true) return "The working copy could not be re-checked, so it was not removed.";
				if (now.unknown) return "Could not verify that this copy has no unsaved work, so it was not removed.";
				if (liveElsewhere(latest, sessionId, services)) return "Another session still works in this copy, so it was not removed.";
				if (planGotWorse(plan, now)) return "The working copy changed while this dialog was open (now " + String(now.dirty) + " uncommitted path(s), " + String(now.unpushed) + " unpushed commit(s), " + String(now.stashes) + " stash entr" + (now.stashes === 1 ? "y" : "ies") + "). Review the warnings above and try again.";
				holder.plan = now;
				return null;
			};
			/**
			 * Read the present state of the copy and compare it with what the dialog
			 * showed: the dialog's own data is up to ~14 s old (the poll plus the host's
			 * cache), and work done in that window must not be deleted unseen.
			 * @returns an error text, or null when removal may go ahead.
			 */
			var removeThenArchive = async function () {
				var request = pending;
				if (blocked) return;
				setState({ busy: "remove", error: null, archived: state.archived });
				var holder = { plan: plan };
				var problem = await verify(request.sessionId, holder);
				if (problem !== null) {
					setState({ busy: null, error: problem, archived: state.archived });
					return;
				}
				// Archive first, delete second. The harness refuses to archive a session
				// with running work, and a session left running in a deleted directory is
				// the one outcome that cannot be undone, so nothing is removed until the
				// archive has actually succeeded.
				if (!state.archived) {
					try {
						await archiveNow(services, request.sessionId);
					} catch (error) {
						setState({
							busy: null,
							archived: false,
							error: "The session could not be archived, so the worktree was not touched: "
								+ String((error && error.message) || error)
								+ " If it is still running, stop it first and archive it again.",
						});
						return;
					}
					problem = await verify(request.sessionId, holder);
					if (problem !== null) {
						setState({ busy: null, archived: true, error: "The session was archived. " + problem });
						return;
					}
				}
				try {
					var result = await rpc("remove", {
						sessionId: request.sessionId,
						// What was verified a moment ago; the host re-reads and refuses unless it is exactly this.
						confirmedPlan: { dirty: holder.plan.dirty, unpushed: holder.plan.unpushed, stashes: holder.plan.stashes },
					});
					if (!result || result.ok !== true) throw new Error(failureOf(result, "the worktree could not be removed"));
					// The Host retires the dead Workspace registration with the copy.
					await statusStore.refresh(true);
					setState({ busy: null, error: null, archived: false });
					archivePrompt.close();
				} catch (error) {
					setState({
						busy: null,
						archived: true,
						error: "The session was archived but its worktree could not be removed: " + String((error && error.message) || error)
							+ " The working copy is still at " + (entry.managedRoot || "(unknown)") + "; press Remove to try again.",
					});
				}
			};

			return h(primitives.Modal, {
				open: true,
				onClose: close,
				title: "Remove this session's worktree?",
				closeLabel: "Cancel",
				description: "This session works in a git worktree. Archiving it hides the session; the working copy on disk is a separate decision.",
				footer: h("span", { className: "bgw-modal-actions" },
					h(primitives.Button, { variant: "ghost", disabled: state.busy !== null, onClick: close }, "Cancel"),
					h(primitives.Button, { variant: "outline", disabled: state.busy !== null || state.archived, onClick: archiveOnly }, "Keep"),
					h(primitives.Button, {
						variant: "primary",
						disabled: state.busy !== null || blocked,
						onClick: function () {
							void removeThenArchive();
						},
					}, state.busy === "remove" ? "Removing…" : "Remove")),
			},
				h("div", { className: "bgw-panel", style: { padding: 0, height: "auto", gap: "6px" } },
					h("div", null, h("strong", null, "Worktree: "), entry.managedRoot || "(unknown)"),
					entry.branch ? h("div", null, h("strong", null, "Branch: "), entry.branch) : null,
					plan.unknown
						? h("div", { className: "bgw-warn" }, "Could not verify that this copy has no unsaved work; removing it may lose work. Remove is unavailable; Keep still archives the session and leaves the copy.")
						: plan.dirty > 0
							? h("div", { className: "bgw-warn" }, String(plan.dirty) + " uncommitted path(s) will be lost with it.")
							: h("div", { className: "bgw-note" }, "The working copy is clean."),
					plan.unknown && plan.reasons.length > 0 ? h("div", { className: "bgw-note" }, plan.reasons.join("; ")) : null,
					!plan.unknown && plan.unpushed > 0
						? h("div", { className: "bgw-warn" }, String(plan.unpushed) + " unpushed commit(s) (on no remote and not in the source repository); removing the copy discards them.")
						: null,
					!plan.unknown && plan.stashes > 0
						? h("div", { className: "bgw-warn" }, String(plan.stashes) + " stash entr" + (plan.stashes === 1 ? "y" : "ies") + " inside the copy; removing the copy discards them.")
						: null,
					!plan.unknown && plan.operations.length > 0
						? h("div", { className: "bgw-warn" }, "In progress: " + plan.operations.join("; ") + ".")
						: null,
					plan.ignored !== null && plan.ignored.count > 0
						? h("div", { className: "bgw-note" }, String(plan.ignored.count) + " ignored file(s) or folder(s) will be deleted too, e.g. " + plan.ignored.examples.join(", ") + (plan.ignored.count > plan.ignored.examples.length ? ", ..." : "") + ".")
						: null,
					otherLive
						? h("div", { className: "bgw-warn" }, "Session " + String(entry.targetSessionId) + " still works in this copy. Remove is unavailable until that session is archived.")
						: null,
					h("div", { className: "bgw-note" }, "Remove archives the session first, so it does nothing while the session is still running: stop it, then archive again."),
					state.error !== null ? h("div", { className: "bgw-menu-error" }, state.error) : null));
		}


		/**
		 * Shadow one of the official workspace UI's archive entries.
		 *
		 * The official `archive` entry in `slotName` is looked up on the slot's ledger
		 * and a second entry with the same id is registered at a lower priority (the
		 * lowest renders). It reuses the official component and locale and the
		 * official inject result untouched, except that the archive callback inside it
		 * goes through interceptArchive. If this entry ever crashes the renderer
		 * retires it and the official one shows again.
		 */
		function shadowOfficialArchive(ctx, slotName) {
			var slots = ctx.slots;
			var registered = null;
			var shadowing = null;
			function official() {
				return slots.entries(slotName).find(function (entry) {
					return entry.options && entry.options.id === "archive" && (entry.options.priority === undefined || entry.options.priority === 0);
				});
			}
			function release() {
				if (registered !== null) registered();
				registered = null;
				shadowing = null;
			}
			function sync() {
				var found = official();
				if (found === shadowing) return;
				release();
				if (found === undefined || typeof found.inject !== "function") return;
				shadowing = found;
				var options = {
					name: slotName,
					id: "archive",
					order: found.options.order,
					priority: SHADOW_PRIORITY,
					inject: function () {
						var injected = found.inject.apply(null, arguments) || {};
						if (typeof injected.archiveSession !== "function") return injected;
						return Object.assign({}, injected, { archiveSession: interceptArchive(injected.archiveSession) });
					},
				};
				if (found.locale !== undefined) options.locale = found.locale;
				registered = slots.register(options, found.component);
			}
			return slots.inject(slotName, function () {
				var unsubscribe = slots.subscribe(slotName, sync);
				sync();
				return function () {
					unsubscribe();
					release();
				};
			});
		}

		// ================================================================
		// client plumbing
		// ================================================================
		/**
		 * Service handles for this plugin, resolved lazily and cached on first
		 * success: the conversation service belongs to a sibling subtree, which is
		 * why it is reached through a session scope below rather than from here.
		 */
		function servicesOf(ctx) {
			var found = {};
			function read(name) {
				if (found[name] === undefined) {
					var value = typeof ctx.get === "function" ? ctx.get(name) : undefined;
					if (value !== undefined) found[name] = value;
				}
				return found[name];
			}
			return {
				get workspaces() { return read("workspaces"); },
				get sessions() { return read("sessions"); },
				get conversation() { return read("conversation"); },
				get uiWorkspace() { return read("uiWorkspace"); },
				get betterSidebar() { return read("betterSidebar"); },
			};
		}

		/** The conversation input facade for one session, reached the way the harness itself reaches it. */
		function inputFacadeFor(services, sessionId, binding) {
			var agentCtx = binding !== undefined && binding.ctx !== undefined
				? binding.ctx
				: services.sessions !== undefined && typeof services.sessions.scope === "function"
					? services.sessions.scope(sessionId)
					: undefined;
			if (agentCtx === undefined) return undefined;
			var conversation = typeof agentCtx.get === "function" ? agentCtx.get("conversation") : undefined;
			var facade = conversation !== undefined ? conversation : services.conversation;
			if (facade === undefined || facade.input === undefined) return undefined;
			try {
				return facade.input.for(agentCtx);
			} catch (error) {
				console.warn("[better-git-worktree] could not reach the target composer", error);
				return undefined;
			}
		}

		function navigateToSession(services, sessionId) {
			if (services.uiWorkspace && typeof services.uiWorkspace.openSession === "function") {
				services.uiWorkspace.openSession(sessionId);
				return;
			}
			throw new Error("this harness build exposes no session navigation surface");
		}

		function readDraft(input) {
			if (input === undefined || input === null) return { draft: "", attachmentIds: [], phase: "plain" };
			return {
				draft: typeof input.draft === "string" ? input.draft : "",
				attachmentIds: input.attachmentIds || [],
				phase: typeof input.phase === "string" ? input.phase : "plain",
			};
		}

		function inputActionsOf(actions) {
			var source = actions || {};
			return {
				setDraft: function (text) {
					if (typeof source.setDraft === "function") source.setDraft(text);
				},
				addAttachments: function (ids) {
					return typeof source.addAttachments === "function" ? source.addAttachments(ids) === true : false;
				},
				removeAttachment: function (id) {
					if (typeof source.removeAttachment === "function") source.removeAttachment(id);
				},
			};
		}

		function openSidebarTab(services, seed, sessionId) {
			var sidebar = services.betterSidebar;
			if (sidebar === undefined || typeof sidebar.openTab !== "function") return false;
			try {
				sidebar.openTab(seed, { sessionId: sessionId });
				return true;
			} catch (error) {
				console.warn("[better-git-worktree] could not open the sidebar tab", error);
				return false;
			}
		}

		// Delays before each archive attempt of a converted session's source. After
		// the agent's own `worktree_convert` the source turn is still running when
		// the continuation opens, and the harness refuses to archive running work,
		// so the first attempt fails and a later one succeeds once the turn ends.
		var ARCHIVE_RETRY_MS = [0, 3000, 8000, 20000, 45000, 90000];

		// Timers of retry chains still waiting, so a reload or dispose can end them.
		var retryTimers = new Set();
		var retiring = false;

		function cancelArchiveRetries() {
			retiring = true;
			for (var timer of Array.from(retryTimers)) clearTimeout(timer);
			retryTimers.clear();
		}

		/** An archive refusal that waiting cannot fix (the session is gone), as opposed to "still running". */
		function isPermanentArchiveError(error) {
			var code = error && error.rpcError && error.rpcError.code;
			return /not-found|unknown-session/i.test(String(code || "")) || (error && error.name === "WorkspaceUnknownSessionError");
		}

		function archiveSourceWithRetry(services, sessionId) {
			if (services.workspaces === undefined || typeof services.workspaces.archiveSession !== "function") return;
			var attempt = 0;

			function schedule(delay) {
				if (retiring) return;
				var timer = setTimeout(function () {
					retryTimers.delete(timer);
					next();
				}, delay);
				retryTimers.add(timer);
			}
			function next() {
				var outcome;
				try {
					outcome = Promise.resolve(services.workspaces.archiveSession(sessionId));
				} catch (error) {
					outcome = Promise.reject(error);
				}
				outcome.then(function () {}, function (error) {
					attempt += 1;
					if (isPermanentArchiveError(error)) {
						console.warn(
							"[better-git-worktree] not archiving the source session " + sessionId + ": " + String((error && error.message) || error),
						);
						return;
					}
					if (attempt >= ARCHIVE_RETRY_MS.length) {
						console.warn(
							"[better-git-worktree] gave up archiving the source session " + sessionId + " after "
							+ String(attempt) + " attempts: " + String((error && error.message) || error),
						);
						return;
					}
					schedule(ARCHIVE_RETRY_MS[attempt]);
				});
			}
			schedule(ARCHIVE_RETRY_MS[0]);
		}


		/**
		 * Create the working-copy-rooted Session for a prepared working copy and hand
		 * the current draft over to it. Mirrors the harness's own new-session flow:
		 * register the managed root as a Workspace, create the Session there, move the
		 * draft, navigate, then retire the blank source Session.
		 */
		async function activateWorktreeSession(services, options) {
			var managedRoot = options.managedRoot;
			var targetSessionId = options.targetSessionId;
			var draft = options.draft;
			var workspace = await services.workspaces.create({ path: managedRoot });
			if (workspace.path !== managedRoot) {
				throw new Error("the harness registered the worktree at " + workspace.path + " instead of " + managedRoot);
			}
			var created = await services.sessions.create({ workspaceId: workspace.workspaceId, sessionId: targetSessionId });
			if (created !== targetSessionId) {
				throw new Error("the harness created session " + created + " instead of " + targetSessionId);
			}
			var handoff = function (binding) {
				var facade = inputFacadeFor(services, targetSessionId, binding);
				if (facade === undefined) {
					// Nothing was moved: leave the original draft exactly where it
					// is rather than clearing the prompt the user just wrote.
					throw new Error(
						"the session was created, but its composer could not be reached, so the draft stayed in the original session",
					);
				}
				var targetInput = inputActionsOf(facade);
				targetInput.setDraft(draft.draft);
				if (draft.attachmentIds.length > 0) targetInput.addAttachments(draft.attachmentIds);
				navigateToSession(services, targetSessionId);
				if (options.clearSourceInput !== undefined) {
					// Only now that the target holds the draft.
					options.clearSourceInput.setDraft("");
					for (var id of draft.attachmentIds) options.clearSourceInput.removeAttachment(id);
				}
			};
			await services.sessions.using(targetSessionId, { source: "controllerOperation" }, function (reference) {
				handoff(reference.binding);
			});
			if (options.archiveSourceSessionId !== undefined && services.workspaces !== undefined
				&& typeof services.workspaces.archiveSession === "function") {
				// The target handoff already owns the draft, so archiving the source is
				// housekeeping, and it must not block (or fail) the activation.
				archiveSourceWithRetry(services, options.archiveSourceSessionId);
			}
			// The registry record is keyed by the session it was created for, which
			// is the target only in the pre-session flow; a converted session keeps
			// its own id as the key.
			void rpc("activate", { sessionId: options.recordSessionId || targetSessionId });
			return { workspaceId: workspace.workspaceId, sessionId: targetSessionId };
		}

		function newSessionId() {
			var uuid =
				typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
					? crypto.randomUUID()
					: String(Date.now()) + "-" + Math.random().toString(16).slice(2);
			return "session-" + uuid;
		}

		// ================================================================
		// sidebar row seats
		// ================================================================
		function icon(name, size) {
			var Icon = primitives[name];
			return typeof Icon === "function" ? h(Icon, { size: size }) : null;
		}

		/** `sidebar.session.row.leading`: the status badge, in the cell before the row title. */
		function RowBadge(props) {
			var decoration = useDecoration(props.sessionId);
			if (decoration === undefined) return null;
			return h("span", {
				className: "bgw-badge",
				role: "img",
				"data-bgw-state": decoration.state,
				"data-bgw-rebase": decoration.needsRebase === true ? "true" : "false",
				"aria-label": "Worktree " + decoration.label + (decoration.needsRebase === true ? ", needs rebasing" : ""),
			}, icon("IconBranchOutlineRegular", 12));
		}

		/** `sidebar.session.row.hover`: the full status text on the row's hover card. */
		function RowHover(props) {
			var decoration = useDecoration(props.sessionId);
			if (decoration === undefined) return null;
			return h("div", { className: "bgw-hover" },
				icon("IconBranchOutlineRegular", 14),
				h("span", { className: "bgw-hover-status" }, decoration.tooltip));
		}

		/** A "..." menu row that exists only for a session with a managed working copy. */
		function makeRowMenuItem(label, iconName, run, supported) {
			return function RowMenuItem(props) {
				var menuOpen = props.useMenuOpenState();
				useStatusVersion();
				var entry = statusStore.entryFor(props.sessionId);
				if (entry === undefined || entry.missing === true || typeof entry.managedRoot !== "string") return null;
				if (supported !== undefined && !supported(statusStore.get())) return null;
				return h(primitives.MenuItemButton, {
					icon: icon(iconName, 14),
					onSelect: function () {
						menuOpen[1](false);
						run(entry, props.sessionId);
					},
				}, label);
			};
		}

		var CopyPathMenuItem = makeRowMenuItem("Copy worktree path", "IconCopyOutlineRegular", function (entry) {
			if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
				notice.show("Clipboard access is unavailable here.");
				return;
			}
			navigator.clipboard.writeText(entry.managedRoot).catch(function (error) {
				notice.show("Could not copy the path: " + String((error && error.message) || error));
			});
		});

		// Only offered when the host reports a folder opener, as in the header menu.
		var OpenFolderMenuItem = makeRowMenuItem("Open worktree folder", "IconFolderOpenOutlineRegular", function (_entry, sessionId) {
			rpc("open", { sessionId: sessionId }).then(function (result) {
				if (!result || result.ok !== true) notice.show(failureOf(result, "the folder could not be opened"));
			}).catch(function (error) {
				notice.show("Could not open the folder: " + String((error && error.message) || error));
			});
		}, function (store) {
			return Boolean(store.capabilities && store.capabilities.folderOpener);
		});

		// ================================================================
		// composer Worktree switch (blank sessions)
		// ================================================================
		function WorktreeSwitch(props) {
			var services = props.services;
			var sessionId = props.sessionId;
			useStatusVersion();
			var session = props.useSession(function (state) {
				return state;
			});
			var hasActiveTarget = props.useConversation(function (state) {
				return state.activeTargets !== undefined && state.activeTargets.size > 0;
			});
			var input = readDraft(props.useInput(function (state) {
				return state;
			}));
			var pair = React.useState({ open: false, busy: false, error: null });
			var state = pair[0];
			var setState = pair[1];

			var blank =
				session !== undefined &&
				!hasActiveTarget &&
				(!session.blank && !session.awaitingFirstTurn ? false : session.running !== true && session.promptAttempted !== true);
			// Once the session lives in a working copy the switch is a statement of
			// fact, not an action: it reads ON and refuses input.
			var entry = statusStore.entryFor(sessionId);
			var inWorktree = entry !== undefined && entry.missing !== true && typeof entry.managedRoot === "string";

			if (session === undefined || !blank) return null;

			var open = function () {
				setState({ open: true, busy: false, error: null });
			};
			var close = function () {
				setState({ open: false, busy: false, error: null });
			};
			var confirm = async function () {
				setState({ open: true, busy: true, error: null });
				var targetSessionId = newSessionId();
				try {
					var prepared = await rpc("prepare", { sourceSessionId: sessionId, targetSessionId: targetSessionId });
					if (!prepared || prepared.ok !== true) throw new Error(failureOf(prepared, "the worktree could not be created"));
					var worktree = prepared.value.worktree;
					await activateWorktreeSession(services, {
						managedRoot: worktree.managedRoot,
						targetSessionId: targetSessionId,
						draft: input,
						clearSourceInput: inputActionsOf(props.inputActions),
						archiveSourceSessionId: sessionId,
					});
					void statusStore.refresh(true);
					setState({ open: false, busy: false, error: null });
				} catch (error) {
					setState({ open: true, busy: false, error: String((error && error.message) || error) });
				}
			};

			return h("span", { className: "bgw-presession" },
				h(primitives.Switch, {
					checked: inWorktree,
					disabled: inWorktree || state.busy,
					label: "Worktree",
					title: inWorktree
						? "This session works in a git worktree" + (entry && entry.managedRoot ? ": " + entry.managedRoot : "")
						: "Start this session in a new git worktree",
					onChange: open,
				}),
				h("span", { className: "bgw-presession-label" }, "Worktree"),
				h(primitives.Modal, {
					open: state.open,
					onClose: close,
					title: "Start in a git worktree",
					closeLabel: "Cancel",
					description:
						"A new branch and worktree are created for this repository, and this session continues there permanently. The original checkout is left untouched.",
					footer: h("span", { className: "bgw-modal-actions" },
						h(primitives.Button, { variant: "outline", disabled: state.busy, onClick: close }, "Cancel"),
						h(primitives.Button, {
							variant: "primary",
							disabled: state.busy,
							onClick: function () {
								void confirm();
							},
						}, state.busy ? "Creating…" : "Create worktree and switch")),
				},
					state.error !== null
						? h("p", { className: "bgw-menu-error" }, state.error)
						: h("p", { className: "bgw-note" },
							input.draft.trim() === "" && input.attachmentIds.length === 0
								? "Your draft moves to the worktree session."
								: "The current draft and attachments move to the worktree session.")));
		}

		// ================================================================
		// branch-vs-default-branch review panel
		// ================================================================
		function BranchReviewPanel(props) {
			var sessionId = props.sessionId;
			var pair = React.useState({ loading: true, data: null, error: null });
			var state = pair[0];
			var setState = pair[1];
			var revisionPair = React.useState(0);
			var revision = revisionPair[0];
			var setRevision = revisionPair[1];
			React.useEffect(function () {
				var alive = true;
				setState(function (current) { return Object.assign({}, current, { loading: true, error: null }); });
				rpc("branchReview", { sessionId: sessionId })
					.then(function (result) {
						if (!alive) return;
						if (result && result.ok === true) setState({ loading: false, data: result.value, error: null });
						else setState({ loading: false, data: null, error: failureOf(result, "review failed") });
					})
					.catch(function (error) {
						if (alive) setState({ loading: false, data: null, error: String((error && error.message) || error) });
					});
				return function () {
					alive = false;
				};
			}, [sessionId, revision]);

			var head = h("div", { className: "bgw-panel-head" },
				h("h4", null, "Branch review"),
				h(primitives.Button, {
					variant: "ghost",
					size: "sm",
					icon: icon("IconRefreshOutlineRegular", 16),
					disabled: state.loading,
					onClick: function () {
						setRevision(function (value) { return value + 1; });
					},
				}, state.loading ? "Refreshing…" : "Refresh"));

			if (state.loading && state.data === null) {
				return h("div", { className: "bgw-panel" }, head, "Loading branch comparison…");
			}
			if (state.error !== null) {
				return h("div", { className: "bgw-panel" }, head, h("div", { className: "bgw-menu-error" }, state.error));
			}
			var data = state.data || {};
			var review = data.review || {};
			var status = data.status || {};
			var behind = status.behindBase || 0;
			return h("div", { className: "bgw-panel" },
				head,
				h("div", null,
					h("h4", null, "Comparing against " + (review.baseRef || "the default branch")),
					h("div", { className: "bgw-note" },
						"Branch " + (status.branch || "(detached)") + " · "
						+ String(status.aheadBase === undefined ? 0 : status.aheadBase) + " commit(s) ahead · "
						+ String(behind) + " behind")),
				behind > 0
					? h("div", { className: "bgw-warn" },
						"Needs rebasing: " + (review.baseRef || "the default branch") + " has " + String(behind) + " commit(s) this branch does not have.")
					: h("div", { className: "bgw-note" }, review.note || ""),
				h("h4", null, "Commits on this branch"),
				(review.commits || []).length === 0
					? h("div", { className: "bgw-note" }, "No commits beyond the merge base.")
					: h("div", null, (review.commits || []).map(function (commit) {
						return h("div", { className: "bgw-row", key: commit.oid },
							h("span", { className: "bgw-code" }, commit.oid), h("span", null, commit.subject));
					})),
				h("h4", null, "Changed files"),
				(review.files || []).length === 0
					? h("div", { className: "bgw-note" }, "No file changes against the merge base.")
					: h("div", null, (review.files || []).map(function (file) {
						return h("div", { className: "bgw-row", key: file.status + ":" + file.path },
							h("span", { className: "bgw-code" }, file.status), h("span", null, file.path));
					})),
				h("h4", null, "Diffstat"),
				h("pre", null, review.diffstat || "(empty)"));
		}

		// ================================================================
		// session-header Worktree pill and menu
		// ================================================================
		function WorktreeActionsMenu(props) {
			var services = props.services;
			var sessionId = props.sessionId;
			useStatusVersion();
			// The pill describes whichever checkout this session runs in; the
			// status store is asked for that session's status on every refresh.
			React.useEffect(function () {
				statusStore.track(sessionId);
			}, [sessionId]);
			var pair = React.useState({ open: false, busy: null, error: null, notice: null, reviewOpen: false });
			var state = pair[0];
			var setState = pair[1];
			var entry = statusStore.entryFor(sessionId);
			var isWorktree = entry !== undefined && typeof entry.managedRoot === "string";
			var decoration = entry === undefined ? undefined : entry.decoration;
			var stateName = decoration !== undefined ? decoration.state : "unknown";
			var title = decoration !== undefined ? decoration.title : "No repository - Unknown";

			var patch = function (fields) {
				setState(function (current) {
					return Object.assign({}, current, fields);
				});
			};

			var run = async function (id, task) {
				patch({ busy: id, error: null, notice: null });
				try {
					await task();
					await statusStore.refresh(true);
					patch({ busy: null, error: null });
				} catch (error) {
					patch({ busy: null, error: String((error && error.message) || error) });
				}
			};

			var gitChanges = function () {
				patch({ open: false });
				if (!openSidebarTab(services, { type: "git" }, sessionId)) {
					patch({ reviewOpen: true, error: null });
				}
			};

			var branchReview = function () {
				patch({ open: false });
				// The tab seat is narrow (it clips "Branch review"), so the tab is
				// "Branch" while the panel's own header carries the full title.
				if (!openSidebarTab(services, { type: "git-worktree-review", title: "Branch" }, sessionId)) {
					patch({ reviewOpen: true, error: null });
				}
			};

			var convertNow = function () {
				void run("convert", async function () {
					var result = await rpc("convert", { sessionId: sessionId });
					if (!result || result.ok !== true) throw new Error(failureOf(result, "the conversion failed"));
					await activateWorktreeSession(services, {
						managedRoot: result.value.worktree.managedRoot,
						targetSessionId: result.value.targetSessionId,
						draft: { draft: "", attachmentIds: [] },
						archiveSourceSessionId: result.value.conversationCarried ? sessionId : undefined,
					});
					void statusStore.refresh(true);
				});
			};

			var needsIgnore = isWorktree && entry.nested === true && entry.ignored === false;
			var items = [];
			items.push({
				id: "summary",
				disabled: true,
				label: h("span", { className: "bgw-menu-summary" },
					h("strong", null, title),
					entry === undefined
						? h("span", null, "No git checkout is attached to this session yet.")
						: h("span", null, entry.path || entry.managedRoot || ""),
					entry !== undefined && entry.branch !== undefined
						? h("span", null, "Branch " + entry.branch + (entry.baseRef ? " vs " + entry.baseRef : ""))
						: null,
					needsIgnore && entry.repoRoot !== undefined
						? h("span", { className: "bgw-menu-warn" }, "This checkout does not ignore " + entry.managedRoot.replace(entry.repoRoot + "/", "") + " yet; use the action below.")
						: null,
					state.notice !== null ? h("span", { className: "bgw-menu-notice" }, state.notice) : null,
					state.error !== null ? h("span", { className: "bgw-menu-error" }, state.error) : null),
			});
			items.push({ type: "separator", id: "summary-separator" });
			items.push({ id: "changes", label: "Git Changes", icon: icon("IconSearchOutlineRegular", 16) });
			items.push({
				id: "branch",
				label: entry !== undefined && entry.baseRef !== undefined ? "Review branch vs " + entry.baseRef : "Review branch vs origin",
				icon: icon("IconBranchOutlineRegular", 16),
			});
			items.push({
				id: "fetch",
				label: state.busy === "fetch" ? "Running git fetch…" : "git fetch",
				icon: icon("IconRefreshOutlineRegular", 16),
				disabled: state.busy !== null,
			});
			if (isWorktree) {
				items.push({
					id: "copyPath",
					label: "Copy worktree path",
					icon: icon("IconCopyOutlineRegular", 16),
					disabled: state.busy !== null,
				});
				if (needsIgnore) {
					items.push({
						id: "ignore",
						label: "Ignore worktrees in this checkout",
						icon: icon("IconFolderOpenOutlineRegular", 16),
						disabled: state.busy !== null,
					});
				}
				if (statusStore.get().capabilities.folderOpener) {
					items.push({
						id: "open",
						label: "Open worktree folder",
						icon: icon("IconFolderOpenOutlineRegular", 16),
						disabled: state.busy !== null,
					});
				}
			} else {
				items.push({
					id: "convert",
					label: state.busy === "convert" ? "Moving into a worktree…" : "Move this session into a worktree",
					icon: icon("IconBranchOutlineRegular", 16),
					disabled: state.busy !== null,
				});
			}

			return h(React.Fragment, null,
				h(primitives.Menu, {
					open: state.open,
					align: "end",
					portal: true,
					compact: true,
					items: items,
					onClose: function () {
						patch({ open: false });
					},
					onSelect: function (id) {
						if (id === "changes") gitChanges();
						if (id === "branch") branchReview();
						if (id === "fetch") void run("fetch", async function () { await rpc("fetch", { sessionId: sessionId }); });
						if (id === "copyPath") {
							patch({ open: false, notice: null, error: null });
							var target = entry !== undefined ? entry.managedRoot : undefined;
							if (typeof target === "string" && typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
								navigator.clipboard.writeText(target).then(
									function () { patch({ notice: "Path copied" }); },
									function (error) { patch({ error: "Could not copy the path: " + String((error && error.message) || error) }); },
								);
							} else {
								patch({ error: "Clipboard access is unavailable here." });
							}
						}
						if (id === "ignore") {
							void run("ignore", async function () {
								var result = await rpc("ignore", { sessionId: sessionId });
								if (!result || result.ok !== true) throw new Error(failureOf(result, "the exclude entry could not be written"));
								patch({ open: false, notice: "Nested worktrees are now ignored by this checkout" });
							});
						}
						if (id === "open") {
							void run("open", async function () {
								var result = await rpc("open", { sessionId: sessionId });
								if (!result || result.ok !== true) throw new Error(failureOf(result, "the folder could not be opened"));
							});
						}
						if (id === "convert") {
							patch({ open: false });
							convertNow();
						}
					},
					anchor: h(primitives.Button, {
						variant: "toolbar",
						size: "sm",
						className: "bgw-header-action",
						icon: icon("IconBranchOutlineRegular", 16),
						"data-bgw-state": stateName,
						"aria-haspopup": "menu",
						"aria-expanded": state.open,
						"aria-label": "Checkout actions: " + title,
						title: decoration !== undefined ? decoration.tooltip : "Git actions for this session's checkout",
						onClick: function () {
							patch({ open: !state.open });
						},
					},
						h("span", { className: "bgw-pill-name" }, title),
						icon("IconChevronDownOutlineRegular", 14)),
				}),
				h(primitives.Modal, {
					open: state.reviewOpen,
					onClose: function () {
						patch({ reviewOpen: false });
					},
					title: "Branch review",
					closeLabel: "Close",
				}, h(BranchReviewPanel, { sessionId: sessionId })));
		}

		// ================================================================
		// activation of Host-created worktree sessions
		// ================================================================
		/**
		 * The `worktree_convert` tool creates the working copy AND the continuation
		 * session Host-side (only the Host can seed a session). Opening it is a
		 * client action, so the store performs the activation exactly once per
		 * record and then marks it done.
		 */
		function activationWatcher(ctx) {
			var services = servicesOf(ctx);
			var inFlight = new Set();
			return statusStore.subscribe(function () {
				for (var entry of statusStore.get().entries) {
					if (entry === undefined || entry.activated !== false) continue;
					if (typeof entry.targetSessionId !== "string" || typeof entry.managedRoot !== "string") continue;
					if (inFlight.has(entry.targetSessionId)) continue;
					inFlight.add(entry.targetSessionId);
					activateWorktreeSession(services, {
						managedRoot: entry.managedRoot,
						targetSessionId: entry.targetSessionId,
						recordSessionId: entry.sessionId,
						draft: { draft: "", attachmentIds: [] },
						archiveSourceSessionId: entry.conversationCarried === true ? entry.sessionId : undefined,
					})
						.then(function () {
							void statusStore.refresh(true);
						})
						.catch(function (error) {
							console.warn("[better-git-worktree] could not open the worktree session", error && error.message ? error.message : error);
							inFlight.delete(entry.targetSessionId);
						});
				}
			});
		}

		// ================================================================
		// plugin face
		// ================================================================
		// Services this half needs to exist before it runs. dsh-better-sidebar is
		// deliberately not here: it is picked up by `ctx.inject(["betterSidebar"])`
		// below, so its absence costs the Branch tab and nothing else.
		var inject = ["slots", "sessions", "workspaces"];

		function apply(ctx) {
			var slots = ctx.slots;
			var services = servicesOf(ctx);
			ctx.effect(function () { return installStyles(); }, "dsh-better-git-worktree: styles");

			void statusStore.refresh(true);
			var pollTimer = setInterval(function () {
				void statusStore.refresh(true);
			}, 10000);
			ctx.effect(function () {
				return function () {
					clearInterval(pollTimer);
				};
			}, "dsh-better-git-worktree: status polling");
			ctx.effect(function () { return activationWatcher(ctx); }, "dsh-better-git-worktree: activation watcher");
			ctx.effect(function () { return cancelArchiveRetries; }, "dsh-better-git-worktree: archive retries");

			function seat(slotName, id, order, component, label) {
				ctx.effect(function () {
					return slots.inject(slotName, function () {
						return slots.register({ name: slotName, id: id, order: order }, component);
					});
				}, "dsh-better-git-worktree: " + label);
			}

			seat("sidebar.session.row.leading", "better-git-worktree.status", 40, RowBadge, "row badge");
			seat("sidebar.session.row.hover", "better-git-worktree.hover", 40, RowHover, "row hover");
			seat("sidebar.workspaces.session.menu.item", "better-git-worktree.copy-path", 450, CopyPathMenuItem, "copy path menu item");
			seat("sidebar.workspaces.session.menu.item", "better-git-worktree.open-folder", 460, OpenFolderMenuItem, "open folder menu item");
			seat("conversation.input.left", "better-git-worktree.switch", 40, function WorktreeSwitchSlot(props) {
				return h(WorktreeSwitch, Object.assign({}, props, { services: services }));
			}, "composer switch");
			seat("conversation.session.header.actions", "better-git-worktree.actions", 30, function WorktreeActionsSlot(props) {
				return h(WorktreeActionsMenu, Object.assign({}, props, { services: services }));
			}, "header menu");
			seat("shell.overlay", "better-git-worktree.archive-prompt", 5, function WorktreeOverlaySlot() {
				return h(WorktreeOverlay, { services: services });
			}, "archive dialog");

			ctx.effect(function () { return shadowOfficialArchive(ctx, "sidebar.workspaces.session.row.action"); }, "dsh-better-git-worktree: archive button");
			ctx.effect(function () { return shadowOfficialArchive(ctx, "sidebar.workspaces.session.menu.item"); }, "dsh-better-git-worktree: archive menu item");

			// Optional: a real sidebar panel via dsh-better-sidebar. Without it the
			// same content renders in the header menu's modal instead.
			ctx.inject(["betterSidebar"], function (scope) {
				scope.effect(function () {
					return scope.betterSidebar.registerTab({
						id: "git-worktree-review",
						title: "Worktree branch",
						description: "Commits and files on this worktree branch compared with the default branch on origin",
						icon: function (size) { return icon("IconBranchOutlineRegular", size || 14); },
						order: 45,
						single: true,
						component: function WorktreeReviewTab(tabProps) {
							var sessionId = tabProps.scope && tabProps.scope.sessionId;
							if (typeof sessionId !== "string") return null;
							return h(BranchReviewPanel, { sessionId: sessionId });
						},
					});
				}, "dsh-better-git-worktree: sidebar tab");
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
