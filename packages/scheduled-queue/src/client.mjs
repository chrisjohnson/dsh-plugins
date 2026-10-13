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
// session window it is mounted in. The dock shows only that session's items.
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

		// The items of one session. Strict: with no session id, nothing.
		function sessionItems(items, sessionId) {
			if (!Array.isArray(items) || typeof sessionId !== "string" || sessionId === "") return [];
			return items.filter(function (item) {
				return item !== null && typeof item === "object" && item.sessionId === sessionId;
			});
		}

		var CSS =
			".sq-root{display:inline-flex;align-items:center}"
			+ ".sq-clockBtn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-primary, #444);cursor:pointer;flex:none;transition:background .15s,color .15s;padding:0}"
			+ ".sq-clockBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, #f0f0f0);color:var(--dsw-interactive-text-on-base, #111)}"
			+ ".sq-clockBtn:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary, #999);outline-offset:2px}"
			+ ".sq-clockBtn:disabled{opacity:.35;cursor:default}"
			+ ".sq-clockIcon{width:16px;height:16px;fill:currentColor}"
			+ ".sq-panel{border:.5px solid var(--dsw-alias-border-l1, #e0e0e0);border-radius:12px;background:var(--dsw-specific-tip, #f7f8fa);overflow:hidden;width:100%}"
			+ ".sq-header{display:flex;align-items:center;gap:8px;width:100%;padding:6px 12px;color:var(--dsw-alias-label-primary, #333);font:500 13px/20px Inter, sans-serif}"
			+ ".sq-list{list-style:none;margin:0;padding:0 8px 6px}"
			+ ".sq-row{display:flex;align-items:center;gap:8px;padding:4px 4px;border-radius:8px;min-height:34px}"
			+ ".sq-row+.sq-row{border-top:.5px solid var(--dsw-alias-border-l1, #e0e0e0)}"
			+ ".sq-preview{min-width:0;flex:1;color:var(--dsw-alias-label-primary-dimmed, #666);font:13px/18px Inter, sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
			+ ".sq-editor{flex:1;min-width:0;border:.5px solid var(--dsw-alias-border-l4, #ccc);background:var(--dsw-alias-bg-base, #fff);border-radius:6px;padding:3px 8px;font:13px/18px Inter, sans-serif;color:var(--dsw-alias-label-primary, #333);outline:none}"
			+ ".sq-editor:focus{border-color:var(--dsw-interactive-text-on-base, #111)}"
			+ ".sq-actions{display:flex;gap:4px;flex:none;align-items:center}"
			+ ".sq-act{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary, #888);cursor:pointer;flex:none;padding:0}"
			+ ".sq-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, #f0f0f0);color:var(--dsw-interactive-text-on-base, #111)}"
			+ ".sq-act:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary, #999);outline-offset:2px}"
			+ ".sq-act:disabled{opacity:.4;cursor:default}"
			+ ".sq-act svg{width:14px;height:14px}"
			+ ".sq-countdown{font:500 11px/14px ui-monospace, monospace;color:var(--dsw-alias-label-tertiary, #888);flex:none}"
			+ ".sq-steer{font:600 9px/12px Inter, sans-serif;color:var(--dsw-alias-label-tertiary, #888);border:.5px solid var(--dsw-alias-border-l2, #d5d5d5);border-radius:4px;padding:1px 4px;flex:none}"
			+ ".sq-modal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:1000;background:rgba(0,0,0,.35)}"
			+ ".sq-modal-box{background:var(--dsw-alias-bg-elevated, #fff);border-radius:14px;padding:20px 24px 16px;min-width:300px;box-shadow:0 8px 32px rgba(0,0,0,.18)}"
			+ ".sq-modal-title{font:600 15px/22px Inter, sans-serif;color:var(--dsw-alias-label-primary, #222);margin:0 0 14px}"
			+ ".sq-field{margin-bottom:12px}"
			+ ".sq-label{display:block;font:500 12px/16px Inter, sans-serif;color:var(--dsw-alias-label-secondary, #555);margin-bottom:4px}"
			+ ".sq-input{width:100%;box-sizing:border-box;height:34px;border:.5px solid var(--dsw-alias-border-l3, #d0d0d0);border-radius:8px;padding:0 10px;font:13px/20px Inter, sans-serif;color:var(--dsw-alias-label-primary, #333);outline:none}"
			+ ".sq-input:focus{border-color:var(--dsw-interactive-text-on-base, #111)}"
			+ ".sq-check{display:flex;align-items:center;gap:8px;font:13px/18px Inter, sans-serif;color:var(--dsw-alias-label-primary, #333);cursor:pointer}"
			+ ".sq-check input{width:16px;height:16px;accent-color:var(--dsw-interactive-text-on-base, #111)}"
			+ ".sq-modal-row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}"
			+ ".sq-btn{height:32px;padding:0 14px;border:none;border-radius:8px;font:500 13px/18px Inter, sans-serif;cursor:pointer}"
			+ ".sq-btn.primary{background:var(--dsw-interactive-text-on-base, #111);color:#fff}"
			+ ".sq-btn.primary:hover:not(:disabled){opacity:.85}"
			+ ".sq-btn.ghost{background:0 0;color:var(--dsw-alias-label-secondary, #555)}"
			+ ".sq-btn:disabled{opacity:.4;cursor:default}";

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
			var tickState = React.useState(0);
			React.useEffect(function () {
				var stopped = false;
				itemsState[1]([]);
				function refresh() {
					if (typeof sessionId !== "string" || sessionId === "") return Promise.resolve();
					return rpcCall("list", { sessionId: sessionId }).then(function (res) {
						if (!stopped && res && res.ok && res.value && Array.isArray(res.value.queue)) itemsState[1](res.value.queue);
					}).catch(function () {});
				}
				refresh();
				var pollId = setInterval(function () { refresh(); }, 10000);
				var clockId = setInterval(function () { tickState[1](function (n) { return n + 1; }); }, 1000);
				return function () {
					stopped = true;
					clearInterval(pollId);
					clearInterval(clockId);
				};
			}, [sessionId]);
			return { items: itemsState[0], setItems: itemsState[1], tick: tickState[0] };
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

			return React.createElement("div", {
				className: "sq-modal",
				onMouseDown: function (e) { if (e.target === e.currentTarget) onCancel(); }
			},
				React.createElement("div", { className: "sq-modal-box" },
					React.createElement("h3", { className: "sq-modal-title" }, "Schedule message"),
					React.createElement("div", { className: "sq-field" },
						React.createElement("label", { className: "sq-label", htmlFor: "sq-minutes" }, "Send in (minutes)"),
						React.createElement("input", {
							id: "sq-minutes",
							className: "sq-input",
							type: "number",
							min: "1",
							value: minutesText,
							autoFocus: true,
							onChange: function (e) { setMinutesText(e.target.value); },
							onKeyDown: function (e) {
								if (e.key === "Enter" && !e.nativeEvent.isComposing) onSave();
								if (e.key === "Escape") onCancel();
							}
						})
					),
					React.createElement("div", { className: "sq-field" },
						React.createElement("label", { className: "sq-check" },
							React.createElement("input", {
								type: "checkbox",
								checked: forceSteer,
								onChange: function (e) { setForceSteer(e.target.checked); }
							}),
							"Force steer (interrupt the current turn when due)"
						)
					),
					React.createElement("div", { className: "sq-modal-row" },
						React.createElement("button", { type: "button", className: "sq-btn ghost", disabled: saving, onClick: onCancel }, "Cancel"),
						React.createElement("button", { type: "button", className: "sq-btn primary", disabled: saving || !minutesOk, onClick: onSave }, saving ? "Saving…" : "Schedule")
					)
				)
			);
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
					if (res && res.ok) close();
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
					className: "sq-input",
					style: { width: "52px", height: "26px", padding: "0 6px" },
					type: "number",
					min: "1",
					value: minutesState[0],
					title: "Minutes",
					onChange: function (e) { minutesState[1](e.target.value); },
					onKeyDown: function (e) { if (e.key === "Enter") saveEdit(); }
				}) : null,
				React.createElement("span", { className: "sq-countdown" }, fmtCountdown(item.dueAt)),
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

			function applyQueue(res) {
				if (res && res.ok && res.value && Array.isArray(res.value.queue)) q.setItems(res.value.queue);
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
						} else if (method === "sendNow" && res && res.value && res.value.delivered === false) {
							noticeState[1]("Could not send now; it stays queued and is retried automatically.");
						}
					},
					function () { noticeState[1]("Could not reach the host."); }
				).then(function () { busyState[1](null); });
			}

			var items = sessionItems(q.items, sessionId);
			if (!items.length) return null;
			var next = items.slice().sort(function (a, b) { return a.dueAt - b.dueAt; })[0];

			return React.createElement("div", { className: "sq-panel" },
				React.createElement("div", { className: "sq-header" },
					React.createElement("span", null, items.length === 1 ? "1 scheduled message" : items.length + " scheduled messages"),
					React.createElement("span", { className: "sq-countdown" }, "next in " + fmtCountdown(next.dueAt))
				),
				noticeState[0] ? React.createElement("div", { className: "sq-header", role: "alert" }, noticeState[0]) : null,
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
		return module.exports;
	}
});
