// dsh-scheduled-queue: the browser half.
//
// Registers two session-scoped list-slot entries:
//
//   - conversation.input.right  : the clock button, between the model dropdown
//     and the send action; enabled while the composer draft has text.
//   - conversation.input.dock   : the panel above the composer card listing THIS
//     session's scheduled messages, with countdown / edit / remove / send-now.
//
// Both slots are session-scoped, so each entry receives the `sessionId` of the
// session window it is mounted in, plus the composer's `inputActions`. The dock
// shows only that session's items, and scheduling clears the draft it just took.
//
// The dialog is the core `Modal` primitive, which portals itself to
// `document.body`. A `position:fixed` element rendered inside the composer seat
// is NOT viewport-fixed: the seat is `position:sticky` with `will-change:transform`
// while docked, which makes it the containing block, so the dialog would be
// confined to the strip above the composer card. The slot contract for
// `conversation.input.dock` / `.right` says the same thing in one line: "fixed
// overlays must portal to the document body because the docked composer contains
// them". Same for the buttons and fields: the core primitives carry the theme,
// the focus ring and the Escape/focus management, so the dialog looks native.
//
// Talks to the Host half over the authenticated /api fence:
// connection.rpc.call("/api", "scheduledQueue/<endpoint>", payload).
//
// This file is a classic script and cannot import a sibling module, so
// `sessionItems` below restates `itemsForSession` from queue.mjs; the tests run
// both over the same cases.

window.__ModuleLoader__.load({
	id: "dsh-scheduled-queue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		// Shared with core through the module loader's externals, so this is the
		// one React and the one set of primitives. Not declared as a dependency: the
		// host supplies the singleton instance (same pattern as
		// dsh-better-git-worktree).
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		var connection = null;

		// A stable stand-in for an absent standard-hook seat, plus a stable identity
		// selector. A seat prop (`useInput`) must be CALLED on every render, including
		// when this scope does not provide it: skipping the call changes the component's
		// hook count, and React then throws "Should have a queue" (prod Minified React
		// error #311) on the first `useState` below it — which the renderer's slot
		// boundary swallows into a blank composer until the page reloads. So the seat is
		// always called, and the RESULT is what gets branched on (`input === null` means
		// there is nothing to schedule).
		var NO_SEAT = function () { return null; };
		var IDENTITY = function (s) { return s; };

		// Dispatched by the clock button after a successful schedule so the dock in the
		// same window can show the item at once instead of waiting for its next poll.
		var CHANGED_EVENT = "dsh-scheduled-queue:changed";

		// The items of one session. Strict: with no session id, nothing.
		function sessionItems(items, sessionId) {
			if (!Array.isArray(items) || typeof sessionId !== "string" || sessionId === "") return [];
			return items.filter(function (item) {
				return item !== null && typeof item === "object" && item.sessionId === sessionId;
			});
		}

		/**
		 * The queue one host response carries for the asking session, or null when it
		 * carries none. Every endpoint that changes the queue answers with it, so the
		 * browser never has to re-list after its own write.
		 */
		function queueFromResult(res) {
			if (!res || res.ok !== true) return null;
			var value = res.value;
			if (!value || typeof value !== "object" || !Array.isArray(value.queue)) return null;
			return { queue: value.queue, warning: value.warning || null };
		}

		/**
		 * What one `dsh-scheduled-queue:changed` event means for the dock of `sessionId`:
		 * `apply` (the event carried this session's queue), `refresh` (an event with no
		 * usable detail — ask the host), or `ignore` (another session scheduled
		 * something; this dock must not change).
		 */
		function dockUpdateFor(event, sessionId) {
			var detail = event && event.detail;
			if (!detail || typeof detail !== "object") return { action: "refresh" };
			if (typeof detail.sessionId === "string" && detail.sessionId !== sessionId) return { action: "ignore" };
			if (!Array.isArray(detail.queue)) return { action: "refresh" };
			return { action: "apply", queue: detail.queue, warning: detail.warning || null };
		}

		var CSS =
			// The clock button, in the composer's own tool row.
			".sq-root{display:inline-flex;align-items:center}"
			+ ".sq-clockBtn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-primary, #444);cursor:pointer;flex:none;transition:background .15s,color .15s;padding:0}"
			+ ".sq-clockBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, #f0f0f0);color:var(--dsw-interactive-text-on-base, #111)}"
			+ ".sq-clockBtn:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary, #999);outline-offset:2px}"
			+ ".sq-clockBtn:disabled{opacity:.35;cursor:default}"
			+ ".sq-clockIcon{width:16px;height:16px;fill:currentColor}"
			// The dock. Geometry and skin are the core queue dock's, in the same slot:
			// the composer card is narrowed by --dsh-composer-card-max-width and the
			// seat's side clearance, so a plain width:100% panel overshoots it.
			+ ".sq-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);padding:0 var(--dsh-composer-dock-inset);flex:none}"
			+ ".sq-panel{isolation:isolate;border-radius:var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);width:100%;padding:2px 0;position:relative;overflow:hidden}"
			+ ".sq-panel:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:\"\";pointer-events:none;position:absolute;inset:0}"
			+ ".sq-panel:after{border:.5px solid var(--dsw-alias-border-l1);border-radius:inherit;content:\"\";pointer-events:none;border-bottom:none;position:absolute;inset:0}"
			+ ".sq-header{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:100%;min-height:36px;color:var(--dsw-alias-label-primary);align-items:center;gap:10px;padding:4px 12px;display:flex}"
			+ ".sq-count{min-width:0;font-family:Inter, var(--dsw-font-family);flex:auto;font-size:13px;font-weight:500;line-height:24px}"
			+ ".sq-status{flex:none;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;white-space:nowrap;font-variant-numeric:tabular-nums}"
			+ ".sq-notice{box-sizing:border-box;width:100%;padding:4px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}"
			+ ".sq-list{max-height:180px;margin:0;padding:0 0 2px;list-style:none;overflow-y:auto}"
			+ ".sq-row{box-sizing:border-box;border-radius:var(--dsw-radius-md);align-items:center;gap:10px;width:100%;min-height:36px;padding:4px 5px 4px 12px;display:flex}"
			+ ".sq-row+.sq-row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}"
			+ ".sq-preview{min-width:0;flex:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Inter, var(--dsw-font-family);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary-dimmed)}"
			+ ".sq-editor{flex:auto;min-width:0;box-sizing:border-box;height:28px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);padding:0 8px;font:13px/20px Inter, sans-serif;color:var(--dsw-alias-label-primary);outline:none}"
			+ ".sq-editor:focus{border-color:var(--dsw-alias-state-business-primary)}"
			+ ".sq-minutes{flex:none;width:64px}"
			+ ".sq-actions{flex:none;align-items:center;gap:10px;display:flex}"
			+ ".sq-act{corner-shape:round;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}"
			+ "@media (hover:hover){.sq-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}"
			+ ".sq-act:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:-2px}"
			+ ".sq-act:disabled{cursor:default;opacity:.45}"
			+ ".sq-act svg{width:16px;height:16px}"
			+ ".sq-steer{font:600 9px/12px Inter, sans-serif;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);padding:1px 4px;flex:none}"
			// The dialog: only what the core primitives do not already own.
			+ ".sq-field{display:flex;flex-direction:column;gap:6px;min-width:0}"
			+ ".sq-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}"
			+ ".sq-minput{width:100%}";

		function rpcCall(endpoint, payload) {
			if (!connection) return Promise.reject(new Error("dsh-scheduled-queue: connection service unavailable"));
			return connection.rpc.call("/api", "scheduledQueue/" + endpoint, payload || {});
		}

		// The browser's zone, sent so a scheduled send reaches the session with the
		// same time-zone context a composer send would carry.
		function browserTimeZone() {
			try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch (e) { return undefined; }
		}

		function fmtCountdown(dueAt) {
			var ms = Math.max(0, dueAt - Date.now());
			var m = Math.floor(ms / 60000);
			var s = Math.floor((ms % 60000) / 1000);
			return m + "m " + (s < 10 ? "0" : "") + s + "s";
		}

		function ClockIcon() {
			return React.createElement("svg", {
				className: "sq-clockIcon", viewBox: "0 0 16 16", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
			},
				React.createElement("path", { d: "M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 1.5A6.5 6.5 0 1 1 8 14.5 6.5 6.5 0 0 1 8 1.5z" }),
				React.createElement("path", { d: "M7.4 4v4.4h4.4v1.2H6.2V4h1.2z" })
			);
		}

		function EditIcon() {
			return React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
				React.createElement("path", { d: "M11 3l2 2-9 9H3V12l9-9z", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round", strokeLinejoin: "round" })
			);
		}

		function TrashIcon() {
			return React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
				React.createElement("path", { d: "M3 4h10M6 4V3h4v1M4.5 4l.8 9h5.4l.8-9M6.5 6.5v5M9.5 6.5v5", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round", strokeLinejoin: "round" })
			);
		}

		function SendIcon() {
			return React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
				React.createElement("path", { d: "M2.5 8L13.5 2.5 10.5 13.5l-2.8-4.4L2.5 8z", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round", strokeLinejoin: "round" }),
				React.createElement("path", { d: "M7.7 9.1l5.8-6.6", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round" })
			);
		}

		function CheckIcon() {
			return React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
				React.createElement("path", { d: "M3 8.5l3.5 3.5 6.5-8", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" })
			);
		}

		function CloseIcon() {
			return React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
				React.createElement("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" })
			);
		}

		function useQueue(sessionId) {
			var itemsState = React.useState([]);
			var warningState = React.useState(null);
			var tickState = React.useState(0);
			React.useEffect(function () {
				var stopped = false;
				itemsState[1]([]);
				function refresh() {
					if (typeof sessionId !== "string" || sessionId === "") return Promise.resolve();
					return rpcCall("list", { sessionId: sessionId }).then(function (res) {
						var update = queueFromResult(res);
						if (!stopped && update) {
							itemsState[1](update.queue);
							warningState[1](update.warning);
						}
					}).catch(function () {});
				}
				// The clock button announces a successful schedule on this window; the
				// dock applies it immediately rather than waiting for the next poll.
				function onChanged(event) {
					var update = dockUpdateFor(event, sessionId);
					if (update.action === "ignore") return;
					if (update.action === "refresh") { refresh(); return; }
					itemsState[1](update.queue);
					warningState[1](update.warning);
				}
				refresh();
				var pollId = setInterval(function () { refresh(); }, 10000);
				var clockId = setInterval(function () { tickState[1](function (n) { return n + 1; }); }, 1000);
				if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
					window.addEventListener(CHANGED_EVENT, onChanged);
				}
				return function () {
					stopped = true;
					clearInterval(pollId);
					clearInterval(clockId);
					if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
						window.removeEventListener(CHANGED_EVENT, onChanged);
					}
				};
			}, [sessionId]);
			return { items: itemsState[0], setItems: itemsState[1], warning: warningState[0], setWarning: warningState[1], tick: tickState[0] };
		}

		function ScheduleModal(props) {
			var minutesText = props.minutesText;
			var setMinutesText = props.setMinutesText;
			var forceSteer = props.forceSteer;
			var setForceSteer = props.setForceSteer;
			var saving = props.saving;
			var onSave = props.onSave;
			var onCancel = props.onCancel;
			var minutesOk = parseInt(minutesText, 10) >= 1;

			// The core Modal: portaled to the body, full-viewport blurred mask, themed
			// card, Escape and focus management included. `data-modal-autofocus` (not
			// React's autoFocus) is how a dialog control asks for initial focus so the
			// close restores it to the clock button.
			return React.createElement(primitives.Modal, {
				open: true,
				onClose: onCancel,
				title: "Schedule message",
				closeLabel: "Close",
				footer: React.createElement(React.Fragment, null,
					React.createElement(primitives.Button, {
						type: "button", variant: "ghost", disabled: saving, onClick: onCancel
					}, "Cancel"),
					React.createElement(primitives.Button, {
						type: "button", variant: "primary", disabled: saving || !minutesOk, onClick: onSave
					}, saving ? "Saving…" : "Schedule")
				)
			},
				React.createElement("div", { className: "sq-field" },
					React.createElement("label", { className: "sq-label", htmlFor: "sq-minutes" }, "Send in (minutes)"),
					React.createElement(primitives.Input, {
						id: "sq-minutes",
						className: "sq-minput",
						type: "number",
						min: "1",
						value: minutesText,
						disabled: saving,
						"data-modal-autofocus": true,
						onChange: function (e) { setMinutesText(e.target.value); },
						onKeyDown: function (e) {
							if (e.key === "Enter" && !e.nativeEvent.isComposing) onSave();
						}
					})
				),
				React.createElement(primitives.Checkbox, {
					checked: forceSteer,
					disabled: saving,
					onChange: setForceSteer,
					label: "Force steer (interrupt the current turn when due)"
				})
			);
		}

		/** Clear the composer draft through the seat's actions, if this scope has them. */
		function clearDraft(actions) {
			var source = actions || {};
			if (typeof source.setDraft === "function") source.setDraft("");
		}

		/** Tell every dock in this window what a successful schedule returned. */
		function announceSchedule(sessionId, res) {
			if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
			var update = queueFromResult(res);
			var detail = { sessionId: sessionId, queue: null, warning: null };
			if (update) {
				detail.queue = update.queue;
				detail.warning = update.warning;
			}
			window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: detail }));
		}

		function ClockButton(props) {
			var sessionId = props.sessionId;
			var input = (props.useInput || NO_SEAT)(IDENTITY);
			var openState = React.useState(false);
			var minutesState = React.useState("5");
			var steerState = React.useState(false);
			var savingState = React.useState(false);

			var hasText = !!input && input.phase === "plain" && typeof input.draft === "string" && input.draft.trim().length > 0;
			var enabled = hasText && !!sessionId;

			function openModal() {
				minutesState[1]("5");
				steerState[1](false);
				openState[1](true);
			}
			function close() { openState[1](false); }
			function save() {
				if (!enabled || !input) return;
				savingState[1](true);
				rpcCall("schedule", {
					sessionId: sessionId,
					text: input.draft,
					minutes: minutesState[0],
					forceSteer: steerState[0],
					timeZone: browserTimeZone()
				}).then(function (res) {
					savingState[1](false);
					if (!res || res.ok !== true) return;
					// Three things the user needs to see that the schedule happened: the
					// dialog closes, the draft it came from is gone, and the dock already
					// lists the item — no 10 s wait, no mystery empty composer.
					clearDraft(props.inputActions);
					announceSchedule(sessionId, res);
					close();
				}).catch(function () { savingState[1](false); });
			}

			return React.createElement("span", { className: "sq-root" },
				React.createElement("button", {
					type: "button",
					className: "sq-clockBtn",
					disabled: !enabled,
					title: hasText ? "Schedule this message" : "Type a message to schedule it",
					onClick: openModal
				}, ClockIcon()),
				openState[0] ? React.createElement(ScheduleModal, {
					minutesText: minutesState[0],
					setMinutesText: minutesState[1],
					forceSteer: steerState[0],
					setForceSteer: steerState[1],
					saving: savingState[0],
					onSave: save,
					onCancel: close
				}) : null
			);
		}

		function QueueRow(props) {
			var item = props.item;
			var busy = props.busy;
			var onRemove = props.onRemove;
			var onSendNow = props.onSendNow;
			var onEdit = props.onEdit;
			var editingState = React.useState(false);
			var textState = React.useState(item.text);
			var minutesState = React.useState(String(item.minutes));
			var steerState = React.useState(item.forceSteer);

			function startEdit() {
				textState[1](item.text);
				minutesState[1](String(item.minutes));
				steerState[1](item.forceSteer);
				editingState[1](true);
			}
			function saveEdit() {
				if (textState[0].trim().length === 0) return;
				editingState[1](false);
				var minutes = parseInt(minutesState[0], 10);
				onEdit(item.id, {
					text: textState[0],
					minutes: minutes >= 1 ? String(minutes) : String(item.minutes),
					forceSteer: steerState[0]
				});
			}

			return React.createElement("li", { className: "sq-row" },
				item.forceSteer ? React.createElement("span", { className: "sq-steer", title: "Force steer" }, "FS") : null,
				editingState[0] ? React.createElement("input", {
					className: "sq-editor",
					value: textState[0],
					autoFocus: true,
					onChange: function (e) { textState[1](e.target.value); },
					onKeyDown: function (e) {
						if (e.key === "Enter" && !e.nativeEvent.isComposing) saveEdit();
						if (e.key === "Escape") editingState[1](false);
					}
				}) : React.createElement("span", { className: "sq-preview", title: item.text }, item.text),
				editingState[0] ? React.createElement("input", {
					className: "sq-editor sq-minutes",
					type: "number",
					min: "1",
					value: minutesState[0],
					title: "Minutes",
					onChange: function (e) { minutesState[1](e.target.value); },
					onKeyDown: function (e) { if (e.key === "Enter") saveEdit(); }
				}) : null,
				React.createElement("span", { className: "sq-status" }, fmtCountdown(item.dueAt)),
				React.createElement("span", { className: "sq-actions" },
					editingState[0] ? React.createElement("button", { type: "button", className: "sq-act", title: "Save", disabled: busy || textState[0].trim().length === 0, onClick: saveEdit }, CheckIcon()) : null,
					editingState[0] ? React.createElement("button", { type: "button", className: "sq-act", title: "Cancel", disabled: busy, onClick: function () { editingState[1](false); } }, CloseIcon()) : null,
					editingState[0] ? null : React.createElement("button", { type: "button", className: "sq-act", title: "Edit", disabled: busy, onClick: startEdit }, EditIcon()),
					editingState[0] ? null : React.createElement("button", { type: "button", className: "sq-act", title: "Remove", disabled: busy, onClick: function () { onRemove(item.id); } }, TrashIcon()),
					React.createElement("button", { type: "button", className: "sq-act", title: "Send now", disabled: busy, onClick: function () { onSendNow(item.id); } }, SendIcon())
				)
			);
		}

		function QueueDock(props) {
			var sessionId = props.sessionId;
			var q = useQueue(sessionId);
			var busyState = React.useState(null);
			var noticeState = React.useState(null);
			React.useEffect(function () {
				if (!noticeState[0]) return undefined;
				var t = setTimeout(function () { noticeState[1](null); }, 15000);
				return function () { clearTimeout(t); };
			}, [noticeState[0]]);

			function applyQueue(res) {
				var update = queueFromResult(res);
				if (!update) return;
				q.setItems(update.queue);
				q.setWarning(update.warning);
			}
			function call(method, id, extra) {
				busyState[1](id);
				noticeState[1](null);
				var args = Object.assign({ id: id, sessionId: sessionId }, extra || {});
				rpcCall(method, args).then(
					function (res) {
						applyQueue(res);
						if (res && !res.ok) {
							noticeState[1](res.error && res.error.message ? res.error.message : "That did not work.");
						} else if (method === "sendNow" && res && res.value && res.value.outcome === "retry") {
							noticeState[1]("Could not send now; it stays queued and is retried automatically.");
						} else if (method === "sendNow" && res && res.value && res.value.outcome === "dropped") {
							noticeState[1]("That message could not be delivered and was removed. Its text is in the host log.");
						}
					},
					function () { noticeState[1]("Could not reach the host."); }
				).then(function () { busyState[1](null); });
			}

			var items = sessionItems(q.items, sessionId);
			var notice = noticeState[0] || q.warning;
			if (!items.length && !notice) return null;
			var next = items.length ? items.slice().sort(function (a, b) { return a.dueAt - b.dueAt; })[0] : null;

			return React.createElement("div", { className: "sq-dock", "data-sq-dock": "" },
				React.createElement("div", { className: "sq-panel" },
					items.length ? React.createElement("div", { className: "sq-header" },
						React.createElement("span", { className: "sq-count" }, items.length === 1 ? "1 scheduled message" : items.length + " scheduled messages"),
						React.createElement("span", { className: "sq-status" }, "next in " + fmtCountdown(next.dueAt))
					) : null,
					notice ? React.createElement("div", { className: "sq-notice", role: "alert" }, notice) : null,
					React.createElement("ul", { className: "sq-list" },
						items.map(function (item) {
							return React.createElement(QueueRow, {
								key: item.id,
								item: item,
								busy: busyState[0] === item.id,
								onRemove: function (id) { call("remove", id); },
								onSendNow: function (id) { call("sendNow", id); },
								onEdit: function (id, patch) { call("edit", id, patch); }
							});
						})
					)
				)
			);
		}

		function apply(ctx) {
			connection = ctx.connection !== undefined ? ctx.connection : ctx.get ? ctx.get("connection") : null;
			var slots = ctx.slots !== undefined ? ctx.slots : ctx.get ? ctx.get("slots") : undefined;
			if (slots === undefined || slots === null) {
				console.error("dsh-scheduled-queue: slots service missing - the clock button and dock stay off");
				return;
			}

			// Page-level style tag, shared across sessions in this page.
			var styleId = "sq-styles";
			if (!document.getElementById(styleId)) {
				var tag = document.createElement("style");
				tag.id = styleId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}

			ctx.effect(function () {
				return slots.inject("conversation.input.right", function () {
					return slots.register(
						{ name: "conversation.input.right", id: "sq-clock", order: 5 },
						function ClockSlot(props) { return React.createElement(ClockButton, props); }
					);
				});
			}, "dsh-scheduled-queue: clock button");

			ctx.effect(function () {
				return slots.inject("conversation.input.dock", function () {
					return slots.register(
						{ name: "conversation.input.dock", id: "sq-dock", order: 25 },
						function DockSlot(props) { return React.createElement(QueueDock, props); }
					);
				});
			}, "dsh-scheduled-queue: queue dock");
		}

		exports.apply = apply;
		exports.inject = ["connection", "slots"];
		// Tests only: the loader reads `apply`/`inject` and ignores the rest.
		exports.sessionItems = sessionItems;
		exports.queueFromResult = queueFromResult;
		exports.dockUpdateFor = dockUpdateFor;
		return module.exports;
	}
});
