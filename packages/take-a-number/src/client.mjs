// dsh-take-a-number: browser half.
//
// 1. `conversation.input.dock` — a session-scoped banner that appears the moment
//    this session's model call is queued in its GPU's queue, with its position
//    and a cancel action.
// 2. `sidebar.panellist` + `main` — a box-wide Activity panel: a per-queue
//    badge in the nav, and a main page that iframes the daemon's standard
//    dashboard (served at `dashboardUrl`) instead of re-rendering it here.
//
// Classic script, React from the module loader, same slot rules as every other
// client half: seats are called unconditionally over a module-scope fallback.

window.__ModuleLoader__.load({
	id: "dsh-take-a-number",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var connection = null;
		var openSessionById = null;

		function rpc(method, payload) {
			if (!connection) return Promise.reject(new Error("dsh-take-a-number: connection unavailable"));
			return connection.rpc.call("/api", "takeANumber/" + method, payload || {});
		}

		function fmtMs(ms) {
			if (ms === null || ms === undefined) return "—";
			var s = Math.round(ms / 1000);
			if (s < 60) return s + "s";
			var m = Math.floor(s / 60);
			if (m < 60) return m + "m " + (s % 60) + "s";
			return Math.floor(m / 60) + "h " + (m % 60) + "m";
		}

		var CSS =
			".tn-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:13px/1.45 Inter,system-ui,sans-serif}"
			+ ".tn-frame{flex:1 1 auto;width:100%;min-height:0;border:0}"
			+ ".tn-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,760px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));margin:0 auto 8px;border:.5px solid #e9c47e;border-radius:10px;background:#fffaf0;padding:7px 10px;display:flex;align-items:center;gap:10px;font:12px/18px Inter,sans-serif;color:#6d4a00}"
			+ ".tn-dock .tn-grow{flex:1;min-width:0;white-space:normal}"
			+ ".tn-dim{color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".tn-mono{font:11px/16px ui-monospace,monospace}"
			+ ".tn-notice{padding:7px 10px;border-radius:8px;background:#fff7e6;border:.5px solid #f0d39a;color:#7a5200;font-size:12px;margin:16px auto;max-width:560px}"
			+ ".tn-btn{height:24px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3,#d0d0d0);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:500 10px/14px Inter,sans-serif;cursor:pointer;flex:none;transition:background-color .15s ease,border-color .15s ease}"
			+ ".tn-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}"
			+ ".tn-btn.danger{color:#b42318;border-color:#e7b4ae}"
			+ ".tn-btn:disabled{opacity:.4;cursor:default}"
			+ ".tn-nav-icon-wrap{position:relative;display:inline-flex;align-items:center;flex:none}"
			+ ".tn-nav-badges{position:absolute;left:calc(100% + 58px);top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:2px;white-space:nowrap;z-index:2}"
			+ ".tn-badge{display:inline-flex;align-items:center;justify-content:center;height:14px;padding:0 6px;border-radius:999px;border:1px solid;box-sizing:border-box;font:600 9px/12px ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;letter-spacing:-.02em}"
			+ ".tn-badge.ok{color:#15803d;background:rgba(34,160,74,.12);border-color:rgba(34,160,74,.35)}"
			+ ".tn-badge.full{color:#854d0e;background:rgba(234,179,8,.14);border-color:rgba(161,98,7,.38)}"
			+ ".tn-badge.waiting{color:#b91c1c;background:rgba(185,28,28,.12);border-color:rgba(185,28,28,.35)}";

		function ensureStyles() {
			if (document.getElementById("take-a-number-styles")) return;
			var tag = document.createElement("style");
			tag.id = "take-a-number-styles";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ---------------------------------------------------------------------
		// Live feed: one shared streaming request while a panel is visible.
		// ---------------------------------------------------------------------

		var STREAM_URL = "/api/takeANumber/stream";
		var STALL_MS = 20000;
		var FALLBACK_POLL_MS = 2000;
		var RETRY_BASE_MS = 2000;
		var RETRY_MAX_MS = 30000;

		function createFeed(env) {
			var listeners = new Set();
			var state = { snapshot: null, error: null, mode: "idle" };
			var controller = null;
			var pollTimer = null;
			var retryTimer = null;
			var stallTimer = null;
			var failures = 0;
			var generation = 0;

			function emit() {
				Array.from(listeners).forEach(function (listener) { listener(); });
			}
			function set(patch) {
				state = Object.assign({}, state, patch);
				emit();
			}
			function ingest(snapshot) {
				set({ snapshot: snapshot, error: null });
			}
			function hidden() {
				return !!(env.document && env.document.hidden);
			}
			function clearTimers() {
				if (pollTimer !== null) { env.clearInterval(pollTimer); pollTimer = null; }
				if (retryTimer !== null) { env.clearTimeout(retryTimer); retryTimer = null; }
				if (stallTimer !== null) { env.clearTimeout(stallTimer); stallTimer = null; }
			}
			function stopAll() {
				generation += 1;
				clearTimers();
				if (controller !== null) { try { controller.abort(); } catch (e) { /* already closed */ } controller = null; }
				state = Object.assign({}, state, { mode: "idle" });
			}
			function pollOnce() {
				rpc("snapshot", {}).then(function (res) {
					if (state.mode !== "poll") return;
					if (res && res.ok) ingest(res.value);
					else if (res && res.error) set({ error: res.error.message });
				}, function () { if (state.mode === "poll") set({ error: "Could not reach the Host." }); });
			}
			function fallBack() {
				var mine = generation;
				if (controller !== null) { try { controller.abort(); } catch (e) { /* already closed */ } controller = null; }
				if (stallTimer !== null) { env.clearTimeout(stallTimer); stallTimer = null; }
				failures += 1;
				if (pollTimer === null) {
					state = Object.assign({}, state, { mode: "poll" });
					pollOnce();
					pollTimer = env.setInterval(pollOnce, FALLBACK_POLL_MS);
					emit();
				}
				var delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.min(failures, 5)));
				retryTimer = env.setTimeout(function () {
					retryTimer = null;
					if (mine === generation && listeners.size > 0 && !hidden()) openStream();
				}, delay);
			}
			function armStall() {
				if (stallTimer !== null) env.clearTimeout(stallTimer);
				var mine = generation;
				stallTimer = env.setTimeout(function () {
					stallTimer = null;
					if (mine === generation) fallBack();
				}, STALL_MS);
			}
			function openStream() {
				if (typeof env.fetch !== "function" || typeof env.AbortController !== "function") { fallBack(); return; }
				var mine = generation;
				controller = new env.AbortController();
				var signal = controller.signal;
				armStall();
				env.fetch(STREAM_URL, {
					method: "POST", headers: { "content-type": "application/json" },
					credentials: "same-origin", body: "{}", signal: signal
				}).then(function (response) {
					if (!response.ok || !response.body || typeof response.body.getReader !== "function") throw new Error("stream unavailable");
					var reader = response.body.getReader();
					var decoder = new env.TextDecoder();
					var buffer = "";
					function pump() {
						return reader.read().then(function (chunk) {
							if (mine !== generation) return undefined;
							if (chunk.done) throw new Error("stream closed");
							armStall();
							buffer += decoder.decode(chunk.value, { stream: true });
							var cut;
							while ((cut = buffer.indexOf("\n")) >= 0) {
								var line = buffer.slice(0, cut);
								buffer = buffer.slice(cut + 1);
								if (line === "") continue;
								var frame;
								try { frame = JSON.parse(line); } catch (e) { continue; }
								if (pollTimer !== null) { env.clearInterval(pollTimer); pollTimer = null; }
								if (retryTimer !== null) { env.clearTimeout(retryTimer); retryTimer = null; }
								failures = 0;
								state = Object.assign({}, state, { mode: "stream" });
								ingest(frame);
							}
							return pump();
						});
					}
					return pump();
				}).catch(function () {
					if (mine !== generation || signal.aborted) return;
					fallBack();
				});
			}
			function start() {
				if (listeners.size === 0 || hidden() || state.mode !== "idle") return;
				state = Object.assign({}, state, { mode: "stream" });
				failures = 0;
				openStream();
			}
			function onVisibility() {
				if (hidden()) stopAll();
				else start();
			}
			if (env.document && env.document.addEventListener) env.document.addEventListener("visibilitychange", onVisibility);
			return {
				subscribe: function (listener) {
					listeners.add(listener);
					start();
					return function () {
						listeners.delete(listener);
						if (listeners.size === 0) stopAll();
					};
				},
				get: function () { return state; },
				dispose: function () {
					stopAll();
					if (env.document && env.document.removeEventListener) env.document.removeEventListener("visibilitychange", onVisibility);
				}
			};
		}

		var liveFeed = createFeed({
			document: typeof document !== "undefined" ? document : null,
			fetch: typeof window !== "undefined" && window.fetch ? window.fetch.bind(window) : undefined,
			AbortController: typeof AbortController !== "undefined" ? AbortController : undefined,
			TextDecoder: typeof TextDecoder !== "undefined" ? TextDecoder : undefined,
			setTimeout: function (fn, ms) { return window.setTimeout(fn, ms); },
			clearTimeout: function (id) { window.clearTimeout(id); },
			setInterval: function (id, ms) { return window.setInterval(id, ms); },
			clearInterval: function (id) { window.clearInterval(id); },
			rpc: rpc
		});

		function useFeed() {
			return React.useSyncExternalStore(liveFeed.subscribe, liveFeed.get);
		}
		function useSnapshot() {
			var state = useFeed();
			return [state.snapshot, state.error];
		}

		function act(method, payload) {
			return rpc(method, payload).then(function (res) {
				return res && res.ok ? null : (res && res.error ? res.error.message : "That did not work.");
			}, function () { return "Could not reach the Host."; });
		}

		// React calls a component with its props object, so the queue arrives as
		// props.queue — reading queue.active off the first argument reads props and
		// throws (KAN-105: the whole sidebar.panellist entry crashed, so the Activity
		// row never rendered). Guard the arrays too: one malformed queue must not
		// take the nav entry down again.
		function QueueBadge(props) {
			var queue = (props && props.queue) || {};
			var active = Array.isArray(queue.active) ? queue.active : [];
			var waiters = Array.isArray(queue.waiters) ? queue.waiters : [];
			var demand = active.length + waiters.length;
			var state = waiters.length > 0 ? "waiting" : (!queue.unlimited && demand >= queue.limit ? "full" : "ok");
			var label = demand + "/" + (queue.unlimited ? "∞" : queue.limit);
			return h("span", { className: "tn-badge " + state, title: queue.id + ": " + label + " · " + active.length + " active · " + waiters.length + " queued" }, label);
		}

		function TakeANumberIcon(props) {
			var size = props && props.size ? props.size : 16;
			var pair = useSnapshot();
			var snapshot = pair[0];
			var queues = snapshot && Array.isArray(snapshot.queues) ? snapshot.queues : [];
			var compact = size === 18;
			return h("span", { className: "tn-nav-icon-wrap" },
				h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
					h("rect", { x: 1.5, y: 9, width: 3, height: 5.5, rx: 1, fill: "currentColor", opacity: 0.5 }),
					h("rect", { x: 6.5, y: 5.5, width: 3, height: 9, rx: 1, fill: "currentColor", opacity: 0.7 }),
					h("rect", { x: 11.5, y: 2, width: 3, height: 12.5, rx: 1, fill: "currentColor", opacity: 0.9 })),
				!compact && queues.length > 0 ? h("span", { className: "tn-nav-badges" }, queues.map(function (queue) {
					return h(QueueBadge, { key: queue.id, queue: queue });
				})) : null
			);
		}

		function SessionWaitDock(props) {
			var sessionId = props && props.sessionId;
			var pair = useSnapshot();
			var snapshot = pair[0];
			var b = React.useState(false);
			var busy = b[0], setBusy = b[1];
			var n = React.useState(null);
			var notice = n[0], setNotice = n[1];
			if (!sessionId || !snapshot) return null;
			var mine = [];
			(snapshot.queues || []).forEach(function (queue) {
				(queue.waiters || []).forEach(function (waiter) {
					// Only a main request is "your work waiting"; title/compaction
					// calls can queue while the main call is happily streaming.
					if (waiter.session === sessionId && waiter.kind === "call") mine.push(Object.assign({ queue: queue.id, total: (queue.waiters || []).length }, waiter));
				});
			});
			if (mine.length === 0) return null;
			var first = mine[0];
			return h("div", { className: "tn-dock", role: "status" },
				h("span", { children: "Waiting for model capacity" }),
				h("span", { className: "tn-grow" },
					h("span", { className: "tn-mono", children: first.queue + "/" + (first.model || "?") }),
					" · position " + first.position + " of " + first.total +
					" · waiting " + fmtMs(first.waitedMs) + ". Inference has not started."),
				notice ? h("span", { className: "tn-dim", children: notice }) : null,
				h("button", {
					className: "tn-btn danger", disabled: busy,
					onClick: function () {
						setBusy(true);
						act("cancelWaiter", { waiterId: first.waiterId }).then(function (message) {
							setNotice(message || "Cancelled.");
							setBusy(false);
						});
					},
					children: busy ? "Cancelling…" : "Cancel"
				})
			);
		}

		// The box-wide Activity page. Rather than re-render the queue here (the
		// standard dashboard already does it), iframe the daemon's dashboard,
		// which the host serves at `dashboardUrl`. Empty URL -> a plain notice.
		function ActivityPanel() {
			var c = React.useState("");
			var url = c[0], setUrl = c[1];
			var tried = React.useRef(false);
			React.useEffect(function () {
				if (tried.current) return undefined;
				tried.current = true;
				rpc("config", {}).then(function (res) {
					if (res && res.ok && res.value && typeof res.value.dashboardUrl === "string") setUrl(res.value.dashboardUrl);
				}, function () { /* leave empty -> notice fallback */ });
				return undefined;
			}, []);
			return h("div", { className: "tn-root" },
				url === ""
					? h("div", { className: "tn-notice", children: "The take-a-number dashboard URL is not configured. Set dashboardUrl in the plugin config." })
					: h("iframe", { className: "tn-frame", src: url, title: "take-a-number activity" })
			);
		}

		function apply(ctx) {
			connection = ctx.connection !== undefined ? ctx.connection : ctx.get ? ctx.get("connection") : null;
			openSessionById = function (sessionId) {
				try {
					var uiWorkspace = ctx.get("uiWorkspace");
					if (uiWorkspace && typeof uiWorkspace.openSession === "function") { uiWorkspace.openSession(sessionId); return true; }
				} catch (error) { /* session navigation is best-effort */ }
				return false;
			};
			var slots = ctx.slots !== undefined ? ctx.slots : ctx.get ? ctx.get("slots") : undefined;
			if (!slots) {
				console.error("dsh-take-a-number: slots service missing");
				return;
			}
			ensureStyles();
			ctx.effect(function () {
				return slots.inject("sidebar.panellist", function () {
					return slots.register(
						{ name: "sidebar.panellist", id: "take-a-number", order: 22, label: function () { return "Activity" } },
						TakeANumberIcon
					);
				});
			}, "dsh-take-a-number: sidebar panel");
			ctx.effect(function () {
				return slots.inject("main", function () {
					return slots.register({ name: "main", key: "take-a-number" }, ActivityPanel);
				});
			}, "dsh-take-a-number: panel page");
			ctx.effect(function () {
				return slots.inject("conversation.input.dock", function () {
					return slots.register(
						{ name: "conversation.input.dock", id: "take-a-number-wait", order: 11 },
						SessionWaitDock
					);
				});
			}, "dsh-take-a-number: session wait dock");
		}

		exports.apply = apply;
		exports.inject = ["connection", "slots"];
		return module.exports;
	}
});
