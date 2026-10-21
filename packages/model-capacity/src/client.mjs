// dsh-model-capacity: browser half.
//
// 1. `conversation.input.dock` — a session-scoped banner that appears the moment
//    this session's model call is queued, with its position and a cancel action.
// 2. `sidebar.panellist` + `main` — a global Capacity panel showing active
//    leases, FIFO waiters and subagent reservations, with controls.
//
// Classic script, React from the module loader, same slot rules as every other
// client half: seats are called unconditionally over a module-scope fallback.

window.__ModuleLoader__.load({
	id: "dsh-model-capacity",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var connection = null;

		function rpc(method, payload) {
			if (!connection) return Promise.reject(new Error("dsh-model-capacity: connection unavailable"));
			return connection.rpc.call("/api", "modelCapacity/" + method, payload || {});
		}

		function fmtMs(ms) {
			if (ms === null || ms === undefined) return "—";
			var s = Math.round(ms / 1000);
			if (s < 60) return s + "s";
			var m = Math.floor(s / 60);
			if (m < 60) return m + "m " + (s % 60) + "s";
			return Math.floor(m / 60) + "h " + (m % 60) + "m";
		}

		function shortId(id) {
			return typeof id === "string" && id.length > 14 ? id.slice(-8) : (id || "no session");
		}

		function sessionLabel(entry) {
			return (entry && entry.sessionTitle) || shortId(entry && entry.sessionId);
		}

		function fmtTime(ms) {
			if (!ms) return "—";
			try { return new Date(ms).toLocaleTimeString(); } catch (e) { return "—"; }
		}

		var CSS =
			".mc-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:13px/1.45 Inter,system-ui,sans-serif}"
			+ ".mc-bar{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:.5px solid var(--dsw-alias-border-l1,#e4e4e4);flex:none;flex-wrap:wrap}"
			+ ".mc-title{font:600 16px/22px Inter,sans-serif;margin:0}"
			+ ".mc-sub{color:var(--dsw-alias-label-tertiary,#888);font-size:12px}"
			+ ".mc-spacer{flex:1}"
			+ ".mc-body{flex:1;overflow:auto;padding:14px 18px 28px;display:flex;flex-direction:column;gap:12px;max-width:1100px}"
			+ ".mc-card{border:.5px solid var(--dsw-alias-border-l1,#e4e4e4);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);padding:12px 14px}"
			+ ".mc-cardhead{display:flex;align-items:center;gap:8px;margin-bottom:8px}"
			+ ".mc-cardtitle{font:600 13px/18px Inter,sans-serif}"
			+ ".mc-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#d8d8d8);font:500 10px/16px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#555);white-space:nowrap}"
			+ ".mc-chip.on{background:var(--dsw-alias-bg-layer-2,#eef1f5);border-color:transparent;color:var(--dsw-alias-label-primary,#111)}"
			+ ".mc-chip.warn{background:#fff4e5;border-color:#f0c987;color:#8a5300}"
			+ ".mc-chip.err{background:#fdecea;border-color:#f3b3ac;color:#9b1c1c}"
			+ ".mc-chip.ok{background:#e8f6ec;border-color:#a8d8b5;color:#1d6b32}"
			+ ".mc-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-top:.5px solid var(--dsw-alias-border-l1,#f0f0f0);font-size:12px}"
			+ ".mc-row:first-of-type{border-top:none}"
			+ ".mc-key{font:600 11px/16px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888);min-width:64px}"
			+ ".mc-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
			+ ".mc-dim{color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".mc-btn{height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,#d0d0d0);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:500 11px/16px Inter,sans-serif;cursor:pointer;flex:none}"
			+ ".mc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}"
			+ ".mc-btn.danger{color:#b42318;border-color:#e7b4ae}"
			+ ".mc-btn:disabled{opacity:.4;cursor:default}"
			+ ".mc-empty{padding:10px 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}"
			+ ".mc-dock{margin:0 0 8px;border:.5px solid #e9c47e;border-radius:10px;background:#fffaf0;padding:7px 10px;display:flex;align-items:center;gap:10px;font:12px/18px Inter,sans-serif;color:#6d4a00}"
			+ ".mc-dock .mc-grow{white-space:normal}"
			+ ".mc-dock-title{font-weight:600}"
			+ ".mc-notice{padding:7px 10px;border-radius:8px;background:#fff7e6;border:.5px solid #f0d39a;color:#7a5200;font-size:12px;margin-bottom:10px}"
			+ ".mc-mono{font:11px/16px ui-monospace,monospace}"
			+ ".mc-session{font-weight:600;color:var(--dsw-alias-label-primary,#111)}"
			+ "@media (max-width:700px){.mc-root{font-size:12px}}";

		function ensureStyles() {
			if (document.getElementById("model-capacity-styles")) return;
			var tag = document.createElement("style");
			tag.id = "model-capacity-styles";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		function CapacityIcon(props) {
			var size = props && props.size ? props.size : 16;
			return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("rect", { x: 1.5, y: 9, width: 3, height: 5.5, rx: 1, fill: "currentColor", opacity: 0.5 }),
				h("rect", { x: 6.5, y: 5.5, width: 3, height: 9, rx: 1, fill: "currentColor", opacity: 0.7 }),
				h("rect", { x: 11.5, y: 2, width: 3, height: 12.5, rx: 1, fill: "currentColor", opacity: 0.9 })
			);
		}

		function useSnapshot(intervalMs) {
			var s = React.useState(null);
			var snapshot = s[0], setSnapshot = s[1];
			var e = React.useState(null);
			var error = e[0], setError = e[1];
			React.useEffect(function () {
				var alive = true;
				function load() {
					rpc("snapshot", {}).then(function (res) {
						if (!alive) return;
						if (res && res.ok) { setSnapshot(res.value); setError(null); }
						else if (res && res.error) setError(res.error.message);
					}, function () { if (alive) setError("Could not reach the Host."); });
				}
				load();
				var timer = setInterval(load, intervalMs || 1500);
				return function () { alive = false; clearInterval(timer); };
			}, []);
			return [snapshot, error];
		}

		function act(method, payload) {
			return rpc(method, payload).then(function (res) {
				return res && res.ok ? null : (res && res.error ? res.error.message : "That did not work.");
			}, function () { return "Could not reach the Host."; });
		}

		function SessionWaitDock(props) {
			var sessionId = props && props.sessionId;
			var pair = useSnapshot(1200);
			var snapshot = pair[0], error = pair[1];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			var n = React.useState(null);
			var notice = n[0], setNotice = n[1];
			if (!sessionId || !snapshot) return null;
			var mine = [];
			(snapshot.providers || []).forEach(function (provider) {
				(provider.waiters || []).forEach(function (waiter) {
					// Only a main request is "your work waiting"; title/compaction calls
					// can queue while the main call is happily streaming.
					if (waiter.sessionId === sessionId && waiter.kind === "call") mine.push(Object.assign({ provider: provider.name, limit: provider.limit, total: (provider.waiters || []).length }, waiter));
				});
			});
			if (mine.length === 0) return null;
			var first = mine[0];
			return h("div", { className: "mc-dock", role: "status" },
				h("span", { className: "mc-dock-title", children: "Waiting for model capacity" }),
				h("span", { className: "mc-grow" },
					h("span", { className: "mc-mono", children: first.provider + "/" + (first.model || "?") }),
					" · position " + first.position + " of " + first.total +
					" · waiting " + fmtMs(first.waitedMs) + ". Inference has not started."),
				notice ? h("span", { className: "mc-dim", children: notice }) : null,
				h("button", {
					className: "mc-btn danger", disabled: busy,
					onClick: function () {
						setBusy(true);
						act("cancelSession", { sessionId: sessionId }).then(function (message) {
							setNotice(message || "Cancel requested.");
							setBusy(false);
						});
					},
					children: busy ? "Cancelling…" : "Cancel turn"
				}),
				error ? h("span", { className: "mc-dim", children: error }) : null
			);
		}

		function ProviderCard(props) {
			var p = props.provider;
			var busy = props.busyId;
			return h("div", { className: "mc-card" },
				h("div", { className: "mc-cardhead" },
					h("span", { className: "mc-cardtitle", children: p.name }),
					h("span", { className: "mc-chip" + (p.used >= p.limit ? " warn" : " ok"), children: p.used + "/" + p.limit + " in use" }),
					h("span", { className: "mc-chip", children: p.active.length + " active" }),
					h("span", { className: "mc-chip", children: p.waiters.length + " waiting" }),
					h("span", { className: "mc-chip", children: p.reservations.length + " reserved" })
				),
				h("div", { className: "mc-dim", style: { fontSize: 11, marginBottom: 4 }, children: "Active leases" }),
				p.active.length === 0 ? h("div", { className: "mc-empty", children: "none" }) :
					p.active.map(function (lease) {
						return h("div", { className: "mc-row", key: lease.leaseId },
							h("span", { className: "mc-key", children: lease.kind }),
							h("span", { className: "mc-grow", title: lease.sessionId || "" },
								h("b", { className: "mc-session", children: sessionLabel(lease) }),
								h("span", { className: "mc-dim", children: " · " + (lease.workspace || "no workspace") + " · " + (lease.model || "?") })),
							h("span", { className: "mc-dim mc-mono", children: fmtMs(lease.elapsedMs) }),
							h("button", { className: "mc-btn", disabled: busy === lease.leaseId, onClick: function () { props.onCancelSession(lease.sessionId); }, children: "Cancel turn" }),
							h("button", {
								className: "mc-btn danger", disabled: busy === lease.leaseId,
								onClick: function () {
									if (!window.confirm("Force-release this lease? The underlying model call may still be running; this can exceed the provider limit.")) return;
									props.onForceRelease(lease.leaseId);
								},
								children: "Force release"
							})
						);
					}),
				h("div", { className: "mc-dim", style: { fontSize: 11, margin: "8px 0 4px" }, children: "FIFO queue" }),
				p.waiters.length === 0 ? h("div", { className: "mc-empty", children: "empty" }) :
					p.waiters.map(function (waiter) {
						return h("div", { className: "mc-row", key: waiter.waiterId },
							h("span", { className: "mc-key", children: "#" + waiter.position }),
							h("span", { className: "mc-chip", children: waiter.kind || "call" }),
							h("span", { className: "mc-grow", title: waiter.sessionId || "" },
								h("b", { className: "mc-session", children: sessionLabel(waiter) }),
								h("span", { className: "mc-dim", children: " · " + (waiter.workspace || "no workspace") + " · " + (waiter.model || "?") })),
							h("span", { className: "mc-dim mc-mono", children: fmtMs(waiter.waitedMs) }),
							h("button", { className: "mc-btn", disabled: !waiter.sessionId, onClick: function () { props.onCancelSession(waiter.sessionId); }, children: "Cancel" })
						);
					}),
				h("div", { className: "mc-dim", style: { fontSize: 11, margin: "8px 0 4px" }, children: "Subagent reservations" }),
				p.reservations.length === 0 ? h("div", { className: "mc-empty", children: "none" }) :
					p.reservations.map(function (reservation) {
						return h("div", { className: "mc-row", key: reservation.reservationId },
							h("span", { className: "mc-key", children: reservation.tool || "reservation" }),
							h("span", { className: "mc-grow", title: reservation.parentSession || "" },
								h("b", { className: "mc-session", children: (reservation.parent && reservation.parent.sessionTitle) || shortId(reservation.parentSession) }),
								h("span", { className: "mc-dim", children: " · " + ((reservation.parent && reservation.parent.workspace) || "no workspace") + " · " + (reservation.state || "pending") + (reservation.childSession ? " → " + ((reservation.child && reservation.child.sessionTitle) || shortId(reservation.childSession)) : "") })),
							h("span", { className: "mc-dim mc-mono", children: fmtMs(reservation.ageMs) }),
							h("button", { className: "mc-btn danger", disabled: busy === reservation.reservationId, onClick: function () { props.onDismissReservation(reservation.reservationId); }, children: "Dismiss" })
						);
					})
			);
		}

		function CapacityPanel() {
			var pair = useSnapshot(1500);
			var snapshot = pair[0], error = pair[1];
			var n = React.useState(null);
			var notice = n[0], setNotice = n[1];
			var b = React.useState(null);
			var busy = b[0], setBusy = b[1];
			var totals = snapshot ? snapshot.totals : { active: 0, waiting: 0, reservations: 0 };
			function run(method, payload, key) {
				setBusy(key);
				act(method, payload).then(function (message) {
					setNotice(message);
					setBusy(null);
				});
			}
			return h("div", { className: "mc-root" },
				h("div", { className: "mc-bar" },
					h("h1", { className: "mc-title", children: "Model capacity" }),
					h("span", { className: "mc-sub", children: snapshot ? (snapshot.enabled ? "enforcing" : "disabled") + " · " + totals.active + " active · " + totals.waiting + " waiting · " + totals.reservations + " reserved" : "loading" }),
					h("span", { className: "mc-spacer" }),
					h("span", { className: "mc-sub", children: "FIFO per provider; no queue timeout" })
				),
				h("div", { className: "mc-body" },
					notice ? h("div", { className: "mc-notice", children: notice }) : null,
					error ? h("div", { className: "mc-notice", children: error }) : null,
					snapshot === null ? h("div", { className: "mc-empty", children: "Loading capacity state…" }) :
						snapshot.providers.length === 0 ? h("div", { className: "mc-empty", children: "No provider has been used yet." }) :
							snapshot.providers.map(function (provider) {
								return h(ProviderCard, {
									key: provider.name, provider: provider, busyId: busy,
									onCancelSession: function (sessionId) { if (sessionId) run("cancelSession", { sessionId: sessionId }, sessionId); },
									onDismissReservation: function (id) { run("dismissReservation", { reservationId: id }, id); },
									onForceRelease: function (id) { run("forceRelease", { leaseId: id }, id); }
								});
							})
				)
			);
		}

		function apply(ctx) {
			connection = ctx.connection !== undefined ? ctx.connection : ctx.get ? ctx.get("connection") : null;
			var slots = ctx.slots !== undefined ? ctx.slots : ctx.get ? ctx.get("slots") : undefined;
			if (!slots) {
				console.error("dsh-model-capacity: slots service missing");
				return;
			}
			ensureStyles();
			ctx.effect(function () {
				return slots.inject("sidebar.panellist", function () {
					return slots.register(
						{ name: "sidebar.panellist", id: "model-capacity", order: 21, label: function () { return "Capacity"; } },
						CapacityIcon
					);
				});
			}, "dsh-model-capacity: sidebar panel");
			ctx.effect(function () {
				return slots.inject("main", function () {
					return slots.register({ name: "main", key: "model-capacity" }, CapacityPanel);
				});
			}, "dsh-model-capacity: panel page");
			ctx.effect(function () {
				return slots.inject("conversation.input.dock", function () {
					return slots.register(
						{ name: "conversation.input.dock", id: "model-capacity-wait", order: 12 },
						SessionWaitDock
					);
				});
			}, "dsh-model-capacity: session wait dock");
		}

		exports.apply = apply;
		exports.inject = ["connection", "slots"];
		return module.exports;
	}
});
