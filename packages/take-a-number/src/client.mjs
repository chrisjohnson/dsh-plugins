// dsh-take-a-number: browser half.
//
// 1. `conversation.input.dock` — a session-scoped banner that appears the moment
//    this session's model call is queued in its GPU's queue, with its position
//    and a cancel action.
// 2. `sidebar.panellist` + `main` — a box-wide Activity panel: every queue the
//    machine's take-a-number daemon owns, with active leases and FIFO waiters
//    from every harness (dsh instances, opencode, …).
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

		// One queue's busy history over the last minute: the same polyline
		// technique the model-capacity graph used — no y scale, no value labels;
		// the shape is the read: when this GPU was busy, and how hard.
		var GRAPH_POINTS = 60;
		var GRAPH_W = 600;
		var GRAPH_H = 44;
		var GRAPH_PAD = 3;
		var GRAPH_AXIS = [
			{ key: "t60", label: "-60s", at: "0%", edge: "start" },
			{ key: "t45", label: "-45s", at: "25%", edge: "middle" },
			{ key: "t30", label: "-30s", at: "50%", edge: "middle" },
			{ key: "t15", label: "-15s", at: "75%", edge: "middle" },
			{ key: "tnow", label: "now", at: "100%", edge: "end" }
		];

		function graphPoints(values) {
			var step = GRAPH_W / (GRAPH_POINTS - 1);
			var baseline = GRAPH_H - GRAPH_PAD;
			var span = GRAPH_H - 2 * GRAPH_PAD;
			var max = 1;
			var i;
			for (i = 0; i < values.length; i += 1) { if (values[i] > max) max = values[i]; }
			var pairs = [];
			for (i = 0; i < values.length; i += 1) {
				var value = values[i] > 0 ? values[i] : 0;
				pairs.push({ x: GRAPH_W - (values.length - 1 - i) * step, y: baseline - (value / max) * span });
			}
			if (pairs.length === 1) pairs.unshift({ x: GRAPH_W - step, y: pairs[0].y });
			if (pairs.length === 0) pairs = [{ x: 0, y: baseline }, { x: GRAPH_W, y: baseline }];
			return pairs.map(function (p) { return p.x.toFixed(1) + "," + p.y.toFixed(1); }).join(" ");
		}

		function QueueGraph(props) {
			var values = props.values || [];
			if (values.length > GRAPH_POINTS) values = values.slice(values.length - GRAPH_POINTS);
			return h("div", { className: "tn-graph" },
				h("svg", { className: "tn-graph-plot", viewBox: "0 0 " + GRAPH_W + " " + GRAPH_H, preserveAspectRatio: "none", "aria-hidden": "true" },
					h("polyline", {
						points: graphPoints(values), fill: "none", stroke: "currentColor",
						strokeWidth: 1.5, strokeLinejoin: "round", strokeLinecap: "round", vectorEffect: "non-scaling-stroke"
					})),
				h("div", { className: "tn-graph-axis" }, GRAPH_AXIS.map(function (tick) {
					var style = tick.edge === "start" ? { left: 0 } : tick.edge === "end" ? { right: 0 } : { left: tick.at, transform: "translateX(-50%)" };
					return h("span", { key: tick.key, className: "tn-graph-tick is-" + tick.edge, style: style, children: tick.label });
				}))
			);
		}

		function cardTitle(entry) {
			return entry.sessionTitle || entry.identity || "unknown";
		}

		var CSS =
			".tn-root{height:100%;min-height:0;overflow-y:auto;background:radial-gradient(900px 420px at 8% -8%,color-mix(in srgb,#3b82f6 7%,transparent),transparent 62%),radial-gradient(760px 380px at 100% 0%,color-mix(in srgb,#8b5cf6 6%,transparent),transparent 58%),var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:13px/1.45 Inter,system-ui,sans-serif;scrollbar-gutter:stable}"
			+ ".tn-page{box-sizing:border-box;max-width:1180px;margin:0 auto;padding:28px clamp(20px,4vw,48px) 56px}"
			+ ".tn-pagehead{display:flex;align-items:flex-start;gap:16px;margin-bottom:20px;flex-wrap:wrap}"
			+ ".tn-pagehead-main{flex:1;min-width:0}"
			+ ".tn-title{margin:0;font:500 20px/28px Inter,sans-serif;letter-spacing:-.01em}"
			+ ".tn-page-sub{margin-top:4px;color:var(--dsw-alias-label-tertiary,#888);font-size:12px}"
			+ ".tn-status{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;border:1px solid color-mix(in srgb,#22c55e 35%,var(--dsw-alias-border-l2,#ddd));background:color-mix(in srgb,#22c55e 10%,transparent);color:#15803d;font:600 10px/16px Inter,sans-serif;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}"
			+ ".tn-status i{width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.5);animation:tn-pulse 1.9s ease-out infinite}"
			+ ".tn-status.off{color:#6b7280;border-color:var(--dsw-alias-border-l2,#ddd);background:var(--dsw-alias-bg-layer-2,#f3f4f6)}.tn-status.off i{background:#9ca3af;animation:none;box-shadow:none}"
			+ ".tn-status.warn{color:#92400e;border-color:color-mix(in srgb,#f59e0b 40%,var(--dsw-alias-border-l2,#ddd));background:color-mix(in srgb,#f59e0b 10%,transparent)}.tn-status.warn i{background:#f59e0b}"
			+ ".tn-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:18px}"
			+ ".tn-kpi{position:relative;overflow:hidden;padding:12px 14px;border-radius:12px;border:1px solid color-mix(in srgb,var(--tn-accent) 22%,var(--dsw-alias-border-l2,#e5e7eb));background:linear-gradient(135deg,color-mix(in srgb,var(--tn-accent) 9%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff))}"
			+ ".tn-kpi::after{content:'';position:absolute;right:-18px;top:-24px;width:76px;height:76px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--tn-accent) 18%,transparent),transparent 68%)}"
			+ ".tn-kpi-value{font:650 24px/28px Inter,sans-serif;font-variant-numeric:tabular-nums;color:var(--tn-accent)}"
			+ ".tn-kpi-label{margin-top:2px;font-weight:600;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#555)}"
			+ ".tn-kpi-hint{margin-top:2px;font-size:10px;color:var(--dsw-alias-label-tertiary,#999)}"
			+ ".tn-graph{margin:11px 0 12px;position:relative;z-index:1}"
			+ ".tn-graph-plot{display:block;width:100%;height:44px;color:var(--tn-accent);opacity:.9}"
			+ ".tn-graph-axis{position:relative;height:11px;margin-top:3px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 16%,transparent)}"
			+ ".tn-graph-tick{position:absolute;top:3px;font:500 9px/11px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}"
			+ ".tn-graph-tick::before{content:'';position:absolute;top:-4px;width:1px;height:3px;background:currentColor;opacity:.55}"
			+ ".tn-graph-tick.is-start::before{left:0}"
			+ ".tn-graph-tick.is-middle::before{left:50%}"
			+ ".tn-graph-tick.is-end::before{right:0}"
			+ ".tn-tone-blue{--tn-accent:#3b82f6;--tn-accent-2:#06b6d4}"
			+ ".tn-tone-violet{--tn-accent:#8b5cf6;--tn-accent-2:#d946ef}"
			+ ".tn-tone-teal{--tn-accent:#0d9488;--tn-accent-2:#22c55e}"
			+ ".tn-tone-amber{--tn-accent:#d97706;--tn-accent-2:#f59e0b}"
			+ ".tn-queue-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start}"
			+ ".tn-queue{--tn-accent:#3b82f6;--tn-accent-2:#06b6d4;position:relative;overflow:hidden;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--tn-accent) 20%,var(--dsw-alias-border-l2,#e5e7eb));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);padding:14px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 10px 30px rgba(15,23,42,.04)}"
			+ ".tn-queue::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--tn-accent),var(--tn-accent-2))}"
			+ ".tn-queue.tn-tone-0{--tn-accent:#3b82f6;--tn-accent-2:#06b6d4}"
			+ ".tn-queue.tn-tone-1{--tn-accent:#8b5cf6;--tn-accent-2:#d946ef}"
			+ ".tn-queue.tn-tone-2{--tn-accent:#0d9488;--tn-accent-2:#22c55e}"
			+ ".tn-queue.tn-tone-3{--tn-accent:#d97706;--tn-accent-2:#f59e0b}"
			+ ".tn-queue::after{content:'';position:absolute;right:-40px;top:-50px;width:150px;height:150px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--tn-accent) 10%,transparent),transparent 70%);pointer-events:none}"
			+ ".tn-queue.is-waiting{border-color:color-mix(in srgb,var(--tn-accent) 34%,var(--dsw-alias-border-l2,#e5e7eb));box-shadow:0 1px 2px rgba(15,23,42,.04),0 12px 34px color-mix(in srgb,var(--tn-accent) 10%,transparent)}"
			+ ".tn-queue-head{display:flex;align-items:flex-start;gap:12px;position:relative;z-index:1}"
			+ ".tn-queue-name{font:600 14px/20px Inter,sans-serif;color:var(--dsw-alias-label-primary,#111);overflow-wrap:anywhere}"
			+ ".tn-queue-sub{margin-top:2px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}"
			+ ".tn-util{text-align:right;flex:none;margin-left:auto}"
			+ ".tn-util strong{font:650 21px/24px Inter,sans-serif;font-variant-numeric:tabular-nums;color:var(--tn-accent)}"
			+ ".tn-util span{color:var(--dsw-alias-label-tertiary,#999);font-size:12px}"
			+ ".tn-util small{display:block;margin-top:1px;color:var(--dsw-alias-label-tertiary,#999);font-size:9px;letter-spacing:.05em;text-transform:uppercase}"
			+ ".tn-capbar{height:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary,#888) 14%,transparent);overflow:hidden;margin:11px 0 14px;position:relative;z-index:1}"
			+ ".tn-capbar>span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--tn-accent),var(--tn-accent-2));transition:width .55s cubic-bezier(.2,.8,.2,1)}"
			+ ".tn-capbar.is-waiting>span{background:linear-gradient(90deg,#f59e0b,#ef4444)}"
			+ ".tn-section+.tn-section{margin-top:14px}"
			+ ".tn-section-head{display:flex;align-items:center;gap:7px;margin:0 0 7px;color:var(--dsw-alias-label-secondary,#666);font:600 10px/14px Inter,sans-serif;letter-spacing:.08em;text-transform:uppercase}"
			+ ".tn-count{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:15px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f1f3f6);color:var(--dsw-alias-label-secondary,#555);font:600 10px/14px ui-monospace,monospace;letter-spacing:0}"
			+ ".tn-empty-card{padding:12px;border:1px dashed var(--dsw-alias-border-l2,#dfe3e8);border-radius:10px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;text-align:center;background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 60%,transparent)}"
			+ ".tn-card{position:relative;display:flex;flex-direction:column;gap:6px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2,#e2e6ea);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;outline:none;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease;overflow:hidden}"
			+ ".tn-card+.tn-card{margin-top:7px}"
			+ ".tn-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--tn-accent) 48%,var(--dsw-alias-border-l2,#e2e6ea));box-shadow:0 8px 22px color-mix(in srgb,var(--tn-accent) 14%,transparent)}"
			+ ".tn-card:focus-visible{outline:2px solid var(--tn-accent);outline-offset:2px}"
			+ ".tn-card.tn-live{border-color:color-mix(in srgb,#22c55e 42%,var(--dsw-alias-border-l2,#e2e6ea));background:linear-gradient(135deg,color-mix(in srgb,#22c55e 5%,var(--dsw-alias-bg-layer-1,#fff)),var(--dsw-alias-bg-layer-1,#fff));animation:tn-glow 2s ease-in-out infinite}"
			+ ".tn-card.tn-live::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,#22c55e,#06b6d4)}"
			+ ".tn-card.tn-enter{animation:tn-enter .4s ease-out both}"
			+ ".tn-card.tn-live.tn-enter{animation:tn-enter .4s ease-out both,tn-glow 2s ease-in-out infinite}"
			+ ".tn-card.tn-ghost{pointer-events:none;border-color:color-mix(in srgb,#22c55e 30%,var(--dsw-alias-border-l2,#e2e6ea));animation:tn-poof .35s ease-out both}"
			+ ".tn-top{display:flex;align-items:center;justify-content:space-between;gap:8px}"
			+ ".tn-state{display:inline-flex;align-items:center;gap:5px;padding:1px 6px;border-radius:999px;font:600 9px/14px Inter,sans-serif;letter-spacing:.04em;text-transform:uppercase}"
			+ ".tn-state i{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none}"
			+ ".tn-state.live{color:#15803d;background:color-mix(in srgb,#22c55e 13%,transparent)}.tn-state.live i{background:#22c55e;animation:tn-pulse 1.8s ease-out infinite}"
			+ ".tn-state.queued{color:#b45309;background:color-mix(in srgb,#f59e0b 14%,transparent)}.tn-state.queued i{background:#f59e0b}"
			+ ".tn-time{font:600 10px/14px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums;white-space:nowrap}"
			+ ".tn-card-title{font:600 12.5px/17px Inter,sans-serif;color:var(--dsw-alias-label-primary,#111);overflow-wrap:anywhere}"
			+ ".tn-card-desc{font:400 11px/15px Inter,sans-serif;color:var(--dsw-alias-label-secondary,#555);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
			+ ".tn-card-meta{display:flex;flex-wrap:wrap;gap:4px;min-width:0}"
			+ ".tn-tag{display:inline-flex;align-items:center;max-width:100%;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#e8e8e8);background:var(--dsw-alias-bg-layer-2,#f6f7f9);color:var(--dsw-alias-label-tertiary,#777);font:500 9px/15px ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".tn-tag.model{color:color-mix(in srgb,var(--tn-accent) 78%,var(--dsw-alias-label-primary,#111));border-color:color-mix(in srgb,var(--tn-accent) 25%,transparent);background:color-mix(in srgb,var(--tn-accent) 8%,transparent)}"
			+ ".tn-card-actions{display:flex;align-items:center;gap:6px;margin-top:2px}"
			+ ".tn-btn{height:24px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3,#d0d0d0);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:500 10px/14px Inter,sans-serif;cursor:pointer;flex:none;transition:background-color .15s ease,border-color .15s ease}"
			+ ".tn-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}"
			+ ".tn-btn.danger{color:#b42318;border-color:#e7b4ae}"
			+ ".tn-btn:disabled{opacity:.4;cursor:default}"
			+ ".tn-empty{padding:10px 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px}"
			+ ".tn-page-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}"
			+ ".tn-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,760px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));margin:0 auto 8px;border:.5px solid #e9c47e;border-radius:10px;background:#fffaf0;padding:7px 10px;display:flex;align-items:center;gap:10px;font:12px/18px Inter,sans-serif;color:#6d4a00}"
			+ ".tn-dock .tn-grow{flex:1;min-width:0;white-space:normal}"
			+ ".tn-dim{color:var(--dsw-alias-label-tertiary,#888)}"
			+ ".tn-mono{font:11px/16px ui-monospace,monospace}"
			+ ".tn-notice{padding:7px 10px;border-radius:8px;background:#fff7e6;border:.5px solid #f0d39a;color:#7a5200;font-size:12px;margin-bottom:10px}"
			+ ".tn-nav-icon-wrap{position:relative;display:inline-flex;align-items:center;flex:none}"
			+ ".tn-nav-badges{position:absolute;left:calc(100% + 58px);top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:2px;white-space:nowrap;z-index:2}"
			+ ".tn-badge{display:inline-flex;align-items:center;justify-content:center;height:14px;padding:0 6px;border-radius:999px;border:1px solid;box-sizing:border-box;font:600 9px/12px ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;letter-spacing:-.02em}"
			+ ".tn-badge.ok{color:#15803d;background:rgba(34,160,74,.12);border-color:rgba(34,160,74,.35)}"
			+ ".tn-badge.full{color:#854d0e;background:rgba(234,179,8,.14);border-color:rgba(161,98,7,.38)}"
			+ ".tn-badge.waiting{color:#b91c1c;background:rgba(185,28,28,.12);border-color:rgba(185,28,28,.35)}"
			+ "@keyframes tn-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}70%{box-shadow:0 0 0 6px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}"
			+ "@keyframes tn-glow{0%,100%{box-shadow:0 0 0 1px rgba(34,197,94,.10),0 4px 18px rgba(34,197,94,.06);scale:1}50%{box-shadow:0 0 0 2px rgba(34,197,94,.40),0 12px 34px rgba(34,197,94,.22);scale:1.012}}"
			+ "@keyframes tn-enter{0%{transform:translateY(-10px);opacity:0}100%{transform:translateY(0);opacity:1}}"
			+ "@keyframes tn-poof{0%{transform:scale(1);opacity:1}100%{transform:scale(1.08);opacity:0}}"
			+ "@media (prefers-reduced-motion:reduce){.tn-card.tn-live,.tn-card.tn-enter,.tn-card.tn-live.tn-enter,.tn-state.live i,.tn-status i{animation:none}.tn-card.tn-ghost{display:none}.tn-card{transition:none}.tn-capbar>span{transition:none}}"
			+ "@media (max-width:720px){.tn-kpis{grid-template-columns:1fr}.tn-queue-grid{grid-template-columns:1fr}}";

		function ensureStyles() {
			if (document.getElementById("take-a-number-styles")) return;
			var tag = document.createElement("style");
			tag.id = "take-a-number-styles";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ---------------------------------------------------------------------
		// Activity animations (ported from dsh-model-capacity): ghosts, entering,
		// and the in-section FLIP. Skipped entirely under reduced motion.
		// ---------------------------------------------------------------------

		var GHOST_TTL_MS = 900;
		var ENTER_TTL_MS = 700;

		function reducedMotion() {
			try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
		}

		function byId(list, key) {
			var seen = {};
			(list || []).forEach(function (entry) { if (entry && entry[key] !== undefined && entry[key] !== null) seen[entry[key]] = true; });
			return seen;
		}

		function diffQueue(prev, next) {
			var out = { ghosts: [], entering: [] };
			if (!prev || !next) return out;
			var prevActive = prev.active || [];
			var prevWaiters = prev.waiters || [];
			var nowActive = next.active || [];
			var nowWaiters = next.waiters || [];
			var nowLeases = byId(nowActive, "leaseId");
			var nowWaiterIds = byId(nowWaiters, "waiterId");
			var nowActiveKeys = {};
			nowActive.forEach(function (lease) { if (lease.identityId) nowActiveKeys[lease.identityId + "::" + lease.model] = true; });
			var wasWaitingKeys = {};
			prevWaiters.forEach(function (waiter) { if (waiter.identityId) wasWaitingKeys[waiter.identityId + "::" + waiter.model] = true; });
			var wasActiveKeys = {};
			prevActive.forEach(function (lease) { if (lease.identityId) wasActiveKeys[lease.identityId + "::" + lease.model] = true; });
			prevActive.forEach(function (lease, index) {
				if (nowLeases[lease.leaseId]) return;
				out.ghosts.push({ section: "active", entry: lease, state: "active", index: Math.min(index, nowActive.length) });
			});
			prevWaiters.forEach(function (waiter, index) {
				if (nowWaiterIds[waiter.waiterId]) return;
				if (waiter.identityId && nowActiveKeys[waiter.identityId + "::" + waiter.model]) return; // promoted upstairs
				out.ghosts.push({ section: "queue", entry: waiter, state: "queued", position: waiter.position, index: Math.min(index, nowWaiters.length) });
			});
			nowActive.forEach(function (lease) {
				if (!lease.identityId) return;
				var key = lease.identityId + "::" + lease.model;
				if (wasWaitingKeys[key] && !wasActiveKeys[key]) out.entering.push(lease.leaseId);
			});
			return out;
		}

		function pruneAnim(cur, now) {
			var ghosts = cur.ghosts.filter(function (g) { return now - g.at < GHOST_TTL_MS; });
			var entering = cur.entering.filter(function (x) { return now - x.at < ENTER_TTL_MS; });
			if (ghosts.length === cur.ghosts.length && entering.length === cur.entering.length) return cur;
			return { ghosts: ghosts, entering: entering };
		}

		function withGhosts(items, ghosts) {
			var rows = items.map(function (item) { return { item: item, ghost: null }; });
			if (!ghosts.length) return rows;
			ghosts.slice().sort(function (a, b) { return b.index - a.index; }).forEach(function (ghost) {
				rows.splice(Math.min(ghost.index, rows.length), 0, { item: null, ghost: ghost });
			});
			return rows;
		}

		function flipSection(el, tops, prefix) {
			if (!el || reducedMotion()) return;
			var nodes = el.querySelectorAll("[data-tn-flip]");
			var seen = {};
			var moved = [];
			for (var i = 0; i < nodes.length; i += 1) {
				var node = nodes[i];
				var key = prefix + node.getAttribute("data-tn-flip");
				var top = node.offsetTop;
				seen[key] = top;
				var before = tops[key];
				if (before !== undefined && before !== top) moved.push([node, before - top]);
			}
			Object.keys(tops).forEach(function (key) { if (key.indexOf(prefix) === 0 && seen[key] === undefined) delete tops[key]; });
			Object.assign(tops, seen);
			if (!moved.length) return;
			moved.forEach(function (m) {
				m[0].style.transition = "none";
				m[0].style.transform = "translateY(" + m[1] + "px)";
			});
			void el.offsetHeight;
			window.requestAnimationFrame(function () {
				moved.forEach(function (m) {
					var card = m[0];
					if (!card.isConnected) return;
					card.style.transition = "transform .3s cubic-bezier(.2,.8,.2,1)";
					card.style.transform = "";
					window.setTimeout(function () { card.style.transition = ""; card.style.transform = ""; }, 340);
				});
			});
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

		function QueueBadge(queue) {
			var demand = queue.active.length + queue.waiters.length;
			var state = queue.waiters.length > 0 ? "waiting" : (!queue.unlimited && demand >= queue.limit ? "full" : "ok");
			var label = demand + "/" + (queue.unlimited ? "∞" : queue.limit);
			return h("span", { className: "tn-badge " + state, title: queue.id + ": " + label + " · " + queue.active.length + " active · " + queue.waiters.length + " queued" }, label);
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

		function Kpi(props) {
			return h("div", { className: "tn-kpi " + props.tone },
				h("div", { className: "tn-kpi-value", children: props.value }),
				h("div", { className: "tn-kpi-label", children: props.label }),
				h("div", { className: "tn-kpi-hint", children: props.hint })
			);
		}

		function Card(props) {
			var e = props.entry;
			var active = props.state === "active";
			var ghost = props.ghost === true;
			var busy = props.busy === (active ? e.leaseId : e.waiterId);
			var className = ghost ? "tn-card tn-ghost"
				: "tn-card " + (active ? "tn-live" : "tn-queued") + (props.entering ? " tn-enter" : "");
			var attrs = ghost
				? { className: className, "aria-hidden": "true", onAnimationEnd: props.onGhostEnd }
				: {
					className: className,
					"data-tn-flip": props.flipKey,
					role: "button",
					tabIndex: 0,
					"aria-label": cardTitle(e)
				};
			var tags =
				h("span", { className: "tn-tag", children: e.identity || "unknown" }) +
				h("span", { className: "tn-tag model", children: e.model || "?" }) +
				h("span", { className: "tn-tag", children: e.kind || "call" }) +
				(e.modality ? h("span", { className: "tn-tag", children: e.modality }) : null);
			function stop(event) { event.stopPropagation(); }
			return h("div", attrs,
				h("div", { className: "tn-top" },
					h("span", { className: "tn-state " + (active ? "live" : "queued") },
						h("i"), active ? "live" : ("queued #" + props.position)),
					h("span", { className: "tn-time", children: active ? fmtMs(e.elapsedMs) : fmtMs(e.waitedMs) })
				),
				h("div", { className: "tn-card-title", children: cardTitle(e) }),
				e.description ? h("div", { className: "tn-card-desc", title: e.description, children: "“" + e.description + "”" }) : null,
				h("div", { className: "tn-card-meta" }, tags),
				h("div", { className: "tn-card-actions" },
					active ? h("button", {
						className: "tn-btn danger", disabled: busy || ghost,
						onClick: function (event) {
							stop(event);
							if (!window.confirm("Force-release this lease? The underlying model call may still be running; this can exceed the queue limit.")) return;
							props.onForce(e.leaseId);
						},
						children: "Force release"
					}) : h("button", {
						className: "tn-btn", disabled: busy || ghost,
						onClick: function (event) { stop(event); props.onCancel(e.waiterId); },
						children: "Cancel"
					})
				)
			);
		}

		function QueueCard(props) {
			var q = props.queue;
			var a = React.useState({ ghosts: [], entering: [] });
			var anim = a[0], setAnim = a[1];
			var prevRef = React.useRef(null);
			var seqRef = React.useRef(0);
			var activeRef = React.useRef(null);
			var queueRef = React.useRef(null);
			var topsRef = React.useRef({});
			if (prevRef.current !== q) {
				var prevQueue = prevRef.current;
				prevRef.current = q;
				var diff = reducedMotion() ? null : diffQueue(prevQueue, q);
				if (diff && (diff.ghosts.length || diff.entering.length)) {
					var stamp = Date.now();
					var freshGhosts = diff.ghosts.map(function (ghost) {
						seqRef.current += 1;
						ghost.id = "tng" + seqRef.current;
						ghost.at = stamp;
						return ghost;
					});
					var freshEntering = diff.entering.map(function (leaseId) { return { id: leaseId, at: stamp }; });
					setAnim({
						ghosts: anim.ghosts.concat(freshGhosts),
						entering: anim.entering.concat(freshEntering)
					});
				}
			}
			React.useEffect(function () {
				if (!anim.ghosts.length && !anim.entering.length) return undefined;
				var timer = window.setTimeout(function () {
					setAnim(function (cur) { return pruneAnim(cur, Date.now()); });
				}, GHOST_TTL_MS);
				return function () { window.clearTimeout(timer); };
			}, [anim]);
			React.useLayoutEffect(function () {
				flipSection(activeRef.current, topsRef.current, "a:");
				flipSection(queueRef.current, topsRef.current, "q:");
			});
			function dropGhost(id) {
				setAnim(function (cur) {
					var kept = cur.ghosts.filter(function (ghost) { return ghost.id !== id; });
					return kept.length === cur.ghosts.length ? cur : { ghosts: kept, entering: cur.entering };
				});
			}
			function ghostHandler(ghost) {
				return function (event) {
					if (event && event.animationName && event.animationName !== "tn-poof") return;
					dropGhost(ghost.id);
				};
			}
			var demand = q.active.length + q.waiters.length;
			var pct = q.unlimited ? 100 : Math.min(100, Math.round((demand / Math.max(1, q.limit)) * 100));
			var entering = {};
			anim.entering.forEach(function (x) { entering[x.id] = true; });
			var activeRows = withGhosts(q.active, anim.ghosts.filter(function (g) { return g.section === "active"; }));
			var queueRows = withGhosts(q.waiters, anim.ghosts.filter(function (g) { return g.section === "queue"; }));
			return h("section", { className: "tn-queue tn-tone-" + props.tone + (q.waiters.length > 0 ? " is-waiting" : "") },
				h("div", { className: "tn-queue-head" },
					h("div", { style: { minWidth: 0 } },
						h("div", { className: "tn-queue-name", children: q.id }),
						h("div", { className: "tn-queue-sub", children: q.unlimited ? "unlimited concurrency · never queues" : q.limit + " concurrent model call" + (q.limit === 1 ? "" : "s") })
					),
					h("div", { className: "tn-util" },
						h("strong", { children: demand }),
						h("span", { children: "/" + (q.unlimited ? "∞" : q.limit) }),
						h("small", { children: "active + queued" })
					)
				),
				h(QueueGraph, { values: q.history60 }),
				h("div", { className: "tn-capbar" + (q.waiters.length > 0 ? " is-waiting" : "") },
					h("span", { style: { width: pct + "%" } })
				),
				h("div", { className: "tn-section", ref: activeRef },
					h("div", { className: "tn-section-head" }, "Active", h("span", { className: "tn-count", children: q.active.length })),
					activeRows.length === 0 ? h("div", { className: "tn-empty-card", children: "No active calls" }) :
						activeRows.map(function (row) {
							if (row.ghost) {
								return h(Card, { key: row.ghost.id, entry: row.ghost.entry, state: "active", ghost: true, onGhostEnd: ghostHandler(row.ghost) });
							}
							return h(Card, {
								key: row.item.leaseId, entry: row.item, state: "active", busy: props.busy,
								flipKey: row.item.leaseId, entering: entering[row.item.leaseId] === true,
								onForce: props.onForceRelease, onCancel: props.onCancelWaiter
							});
						})
				),
				h("div", { className: "tn-section", ref: queueRef },
					h("div", { className: "tn-section-head" }, "Queue", h("span", { className: "tn-count", children: q.waiters.length })),
					queueRows.length === 0 ? h("div", { className: "tn-empty-card", children: "Queue empty" }) :
						queueRows.map(function (row) {
							if (row.ghost) {
								return h(Card, { key: row.ghost.id, entry: row.ghost.entry, state: "queued", position: row.ghost.position, ghost: true, onGhostEnd: ghostHandler(row.ghost) });
							}
							return h(Card, {
								key: row.item.waiterId, entry: row.item, state: "queued", position: row.item.position, busy: props.busy,
								flipKey: row.item.waiterId,
								onForce: props.onForceRelease, onCancel: props.onCancelWaiter
							});
						})
				)
			);
		}

		function ActivityPanel() {
			var feedState = useFeed();
			var snapshot = feedState.snapshot, error = feedState.error;
			var n = React.useState(null);
			var notice = n[0], setNotice = n[1];
			var b = React.useState(null);
			var busy = b[0], setBusy = b[1];
			var totals = snapshot ? snapshot.totals : { active: 0, waiting: 0 };
			var identities = snapshot && Array.isArray(snapshot.identities) ? snapshot.identities : [];
			function run(method, payload, key) {
				setBusy(key);
				act(method, payload).then(function (message) {
					setNotice(message);
					setBusy(null);
				});
			}
			var degraded = snapshot === null || snapshot.degraded === true;
			return h("div", { className: "tn-root" },
				h("div", { className: "tn-page" },
					h("div", { className: "tn-pagehead" },
						h("div", { className: "tn-pagehead-main" },
							h("h1", { className: "tn-title", children: "Activity" }),
							h("div", { className: "tn-page-sub", children: "Box-wide model activity · one FIFO queue per GPU · every harness · click a card to see who is waiting" })
						),
						h("div", { className: "tn-page-actions" },
							h("span", { className: "tn-status" + (degraded ? " off" : "") }, h("i"), snapshot === null ? "loading" : degraded ? "passing through" : "live")
						)
					),
					notice ? h("div", { className: "tn-notice", children: notice }) : null,
					error ? h("div", { className: "tn-notice", children: error }) : null,
					snapshot === null ? h("div", { className: "tn-empty", children: "Loading activity…" }) :
						snapshot.queues.length === 0 ? h("div", { className: "tn-empty", children: "The daemon reports no queues." }) :
							h(React.Fragment, null,
								h("div", { className: "tn-kpis" },
									h(Kpi, { tone: "tn-tone-blue", value: totals.active, label: "Active calls", hint: "leases holding a GPU slot" }),
									h(Kpi, { tone: "tn-tone-amber", value: totals.waiting, label: "Waiting", hint: "in the FIFO queues" }),
									h(Kpi, { tone: "tn-tone-teal", value: identities.length, label: "Identities", hint: "connected harness processes" })
								),
								h("div", { className: "tn-queue-grid" }, snapshot.queues.map(function (queue, index) {
									return h(QueueCard, {
										key: queue.id, queue: queue, tone: index % 4, busy: busy,
										onCancelWaiter: function (waiterId) { run("cancelWaiter", { waiterId: waiterId }, waiterId); },
										onForceRelease: function (leaseId) { run("forceRelease", { leaseId: leaseId }, leaseId); }
									});
								}))
							)
				)
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
