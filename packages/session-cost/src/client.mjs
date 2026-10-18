// dsh-session-cost: Client half (browser bundle) - the composer cost badge.
//
// Registers ONE entry into `conversation.composer.dock` (a list, session-scoped
// slot; the core StatsPills "14.6M tok · Cache hit 97%" pill sits at id "stats",
// order 0). This entry draws a compact `$` total in that stats row.
//
// The figure is the AGENT NETWORK total: the current session plus every
// descendant subagent session's billed cost, summed. It is computed the same
// way dsh-context computes the Context tab's "Agent Network" card - walk the
// parent->child session tree (each session item in the `useSessions` store
// carries its parent link and its `contextTimeline.cost` projection) and sum
// each node's billed token buckets, pricing them against the live models.dev
// catalog (the SAME source and formula dsh-context uses), so the badge covers
// every model the Context page prices and shows the same number. On a
// subagent-less session this is just the session's own cost; it is hidden while
// that total is $0, so the composer row is unchanged on idle or all-local work.
//
// The pill is a real <button> styled with the core StatsPills look (same
// tertiary label color, inherited font, tabular numerals, pill shape) plus the
// core's interactive hover (background + secondary label), and clicking it opens
// the session's Context tab (where the full Agent Network breakdown lives).
//
// The module loader hands this file React as a shared external; it cannot import
// a sibling module, so the cost math below is a byte-for-byte mirror of
// src/prices.mjs (the tested source of truth). Keep them in lockstep.

window.__ModuleLoader__.load({
	id: "dsh-session-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");
		var h = React.createElement;

		// ---- mirror of src/prices.mjs (keep in lockstep) -------------------
		var MODELS_DEV_PROVIDER_IDS = {
			"deepseek-official": "deepseek",
			"deepseek-account": "deepseek",
			"kimi-coding": "moonshotai",
			"minimax-cn": "minimax",
			"zai-coding-cn": "zhipuai",
		};
		function modelsDevProviderOf(dshProviderId) {
			return MODELS_DEV_PROVIDER_IDS[dshProviderId] ?? dshProviderId;
		}
		function isDeepSeekProvider(dshProviderId) {
			return modelsDevProviderOf(dshProviderId) === "deepseek";
		}
		function plainObject(value) {
			return value != null && typeof value === "object" && !Array.isArray(value);
		}
		function numOrNull(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
		}
		function numOr0(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		}
		function rateEq(a, b) {
			return a.hit === b.hit && a.miss === b.miss && a.write === b.write && a.out === b.out;
		}
		function buildPriceBook(catalog) {
			var prices = {};
			var byModel = new Map();
			function addCandidate(key, entry) {
				var arr = byModel.get(key);
				if (arr === undefined) { arr = []; byModel.set(key, arr); }
				else if (arr.some(function (e) { return e.pid === entry.pid && rateEq(e.rate, entry.rate); })) return;
				arr.push(entry);
			}
			var pids = Object.keys(catalog ?? {});
			for (var pi = 0; pi < pids.length; pi++) {
				var pid = pids[pi];
				var entry = catalog[pid];
				if (!plainObject(entry)) continue;
				var models = entry.models;
				if (!plainObject(models)) continue;
				var npm = entry.npm;
				var isPrimary = typeof npm === "string" && npm.startsWith("@ai-sdk/") && npm.slice(8) === pid;
				var providerRates = {};
				var mids = Object.keys(models);
				for (var mi = 0; mi < mids.length; mi++) {
					var modelId = mids[mi];
					var m = models[modelId];
					var cost = plainObject(m) ? m.cost : null;
					if (!plainObject(cost)) continue;
					var input = numOrNull(cost.input);
					var output = numOrNull(cost.output);
					if (input === null || output === null) continue;
					var rate = {
						hit: numOrNull(cost.cache_read) ?? input,
						miss: input,
						write: numOrNull(cost.cache_write) ?? input,
						out: output,
					};
					providerRates[modelId] = rate;
					var lower = modelId.toLowerCase();
					var rec = { pid: pid, mid: modelId, rate: rate, primary: isPrimary };
					addCandidate(lower, rec);
					var parts = lower.split("-");
					for (var k = 1; k < parts.length; k++) addCandidate(parts.slice(k).join("-"), rec);
				}
				if (Object.keys(providerRates).length > 0) prices[pid] = providerRates;
			}
			return { prices: prices, byModel: byModel };
		}
		function modelInProvider(providerRates, model) {
			if (Object.prototype.hasOwnProperty.call(providerRates, model)) {
				return { mid: model, rate: providerRates[model] };
			}
			var n = String(model).toLowerCase();
			var found = null, key = null;
			var keys = Object.keys(providerRates);
			for (var i = 0; i < keys.length; i++) {
				var mid = keys[i];
				var a = mid.toLowerCase();
				if (a === n || a.endsWith("-" + n)) {
					if (key !== null && key !== a) return null;
					key = a;
					found = { mid: mid, rate: providerRates[mid] };
				}
			}
			return found;
		}
		function pickCandidate(cands, hintPid) {
			if (hintPid) for (var i = 0; i < cands.length; i++) if (cands[i].pid === hintPid) return cands[i];
			for (var j = 0; j < cands.length; j++) if (cands[j].primary) return cands[j];
			return cands[0] ?? null;
		}
		function resolveRate(book, dshProvider, model) {
			if (!book || !book.prices) return null;
			var prices = book.prices, byModel = book.byModel;
			var pid = modelsDevProviderOf(dshProvider ?? "");
			var direct = prices[pid];
			if (direct) {
				var m = modelInProvider(direct, model);
				return m ? { pid: pid, mid: m.mid, rate: m.rate } : null;
			}
			if (String(model).toLowerCase().startsWith("deepseek-")) {
				var ds = prices["deepseek"];
				if (ds) {
					var dsm = modelInProvider(ds, model);
					if (dsm) return { pid: "deepseek", mid: dsm.mid, rate: dsm.rate };
				}
			}
			var n = String(model).toLowerCase();
			var slash = n.lastIndexOf("/");
			var hint = slash > 0 ? n.slice(0, slash) : null;
			var keys = slash > 0 ? [n, n.slice(slash + 1)] : [n];
			for (var ki = 0; ki < keys.length; ki++) {
				var cands = byModel.get(keys[ki]);
				if (!cands) continue;
				var c = pickCandidate(cands, hint);
				if (c) return { pid: c.pid, mid: c.mid, rate: c.rate };
			}
			return null;
		}
		function estimateCostUsd(cost, book) {
			if (!plainObject(cost)) return 0;
			var total = 0, any = false;
			var providers = Object.keys(cost);
			for (var pi = 0; pi < providers.length; pi++) {
				var provider = providers[pi];
				var models = cost[provider];
				if (!plainObject(models)) continue;
				var deep = isDeepSeekProvider(provider);
				var modelNames = Object.keys(models);
				for (var mi = 0; mi < modelNames.length; mi++) {
					var model = modelNames[mi];
					var periods = models[model];
					if (!plainObject(periods)) continue;
					var resolved = resolveRate(book, provider, model);
					if (!resolved) continue;
					var rate = resolved.rate;
					for (var period of ["peak", "off"]) {
						var b = periods[period];
						if (!plainObject(b)) continue;
						var n = (numOr0(b.cacheRead) * rate.hit + numOr0(b.uncached) * rate.miss +
							numOr0(b.cacheWrite) * rate.write + numOr0(b.output) * rate.out) / 1e6;
						total += deep && period === "peak" ? n * 2 : n;
						any = true;
					}
				}
			}
			return any ? total : 0;
		}
		var FALLBACK_CATALOG = {
			deepseek: {
				npm: "@ai-sdk/openai-compatible",
				models: {
					"deepseek-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
					"deepseek-v4-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
				},
			},
		};
		function costText(usd) {
			var n = typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : null;
			if (n === null) return null;
			return "$" + (n >= 1 ? n.toFixed(2) : n.toPrecision(2));
		}
		// ---------------------------------------------------------------------

		// ---- live models.dev catalog (same source + formula as dsh-context) --
		// Fetched once per page load and cached in module scope; a re-render is
		// requested of every mounted badge when it lands. On failure we fall back
		// to the tiny inline catalog so the common DeepSeek case still prices.
		var CATALOG_URL = "https://models.dev/api.json";
		var catalog = { book: null, listeners: new Set() };
		var catalogPromise = null;
		function notifyCatalog() {
			catalog.listeners.forEach(function (l) { try { l(); } catch (_) { /* ignore */ } });
		}
		function loadCatalog() {
			if (catalogPromise) return catalogPromise;
			catalogPromise = (async function () {
				try {
					var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
					var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 12000);
					var res = await fetch(CATALOG_URL, { signal: ctrl ? ctrl.signal : undefined });
					if (timer) clearTimeout(timer);
					if (!res.ok) throw new Error("status " + res.status);
					var data = await res.json();
					var book = buildPriceBook(data);
					if (Object.keys(book.prices).length === 0) throw new Error("empty catalog");
					catalog.book = book;
				} catch (err) {
					catalog.book = buildPriceBook(FALLBACK_CATALOG);
				}
				notifyCatalog();
				return catalog.book;
			})();
			return catalogPromise;
		}
		if (typeof fetch === "function") loadCatalog();

		// ---- Agent Network cost: walk the session subtree --------------------
		// A `useSessions` store item carries its parent link (parentSessionId,
		// aliased parentId in the byId view) and its projection values
		// (projectionValues.contextTimeline, possibly wrapped as {ver,seq,val}).
		// We build a parent->children index once per render, then BFS from the
		// current session, summing each node's billed cost. Pricing is linear in
		// the buckets, so summing per-node USD equals pricing the summed total.
		function costOf(item) {
			if (!plainObject(item)) return null;
			var pv = item.projectionValues;
			if (!plainObject(pv)) return null;
			var ct = pv.contextTimeline;
			if (!ct) return null;
			var val = (plainObject(ct) && "val" in ct && plainObject(ct.val)) ? ct.val : ct;
			return plainObject(val) && plainObject(val.cost) ? val.cost : null;
		}
		function parentOf(item) {
			if (!plainObject(item)) return null;
			if (typeof item.parentId === "string" && item.parentId) return item.parentId;
			if (typeof item.parentSessionId === "string" && item.parentSessionId) return item.parentSessionId;
			return null;
		}
		function agentNetworkUsd(byId, currentId, book) {
			if (!plainObject(byId) || !currentId) return null;
			var children = Object.create(null);
			var ids = Object.keys(byId);
			for (var i = 0; i < ids.length; i++) {
				var pid = parentOf(byId[ids[i]]);
				if (pid) (children[pid] || (children[pid] = [])).push(ids[i]);
			}
			var usd = 0;
			var seen = Object.create(null);
			seen[currentId] = true;
			var queue = [currentId];
			for (var q = 0; q < queue.length; q++) {
				var cid = queue[q];
				var c = costOf(byId[cid]);
				if (c) usd += estimateCostUsd(c, book);
				var kids = children[cid];
				if (kids) for (var k = 0; k < kids.length; k++) {
					if (!seen[kids[k]]) { seen[kids[k]] = true; queue.push(kids[k]); }
				}
			}
			return usd;
		}

		// Click -> open the session's Context tab. There is no plugin-facing API
		// to switch the session view, so we drive the tab bar the user would:
		// find the conversation tab list and click its "Context" tab (a real DOM
		// click, which React's delegated handler turns into the view switch).
		// Degrades to a no-op if the tab isn't found (e.g. a non-English label).
		function openContextTab() {
			if (typeof document === "undefined") return;
			var lists = document.querySelectorAll("[data-conversation-tabs]");
			if (!lists.length) lists = document.querySelectorAll('[role="tablist"]');
			for (var li = 0; li < lists.length; li++) {
				var tabs = lists[li].querySelectorAll('button[role="tab"]');
				for (var t = 0; t < tabs.length; t++) {
					var label = (tabs[t].textContent || "").trim();
					if (/^context$/i.test(label)) { tabs[t].click(); return; }
				}
			}
		}

		// Native StatsPills look as an interactive pill: same tertiary label
		// color, inherited font and tabular numerals as the core pills, plus the
		// core's button hover (interactive-bg + secondary label) and pointer.
		var CSS =
			".dsc-pill{box-sizing:border-box;corner-shape:round;max-width:100%;display:inline-flex;align-items:center;gap:6px;" +
			"color:var(--dsw-alias-label-tertiary);font:inherit;" +
			"font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);" +
			"font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;user-select:none;" +
			"background:transparent;border:none;border-radius:999px;padding:1px 8px;cursor:pointer}" +
			".dsc-pill:hover,.dsc-pill[aria-expanded=true]{" +
			"background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}";

		// Standard seats arrive as hook-valued props; call each seat over a stable
		// module-scope fallback and branch on the RESULT (Rules-of-Hooks - a
		// conditional guard or early return above a hook is the #311 bug). All
		// hooks (the projection + sessions seats, useState, useEffect) run
		// unconditionally on every render.
		var NO_PROJECTION = function () { return null; };
		var NO_SESSIONS = function () { return null; };
		var CostPill = React.memo(function CostPill(props) {
			var timeline = (props.useProjection || NO_PROJECTION)("contextTimeline");
			var store = (props.useSessions || NO_SESSIONS)(function (s) { return s; });
			var currentId = typeof props.sessionId === "string" && props.sessionId
				? props.sessionId
				: (store && typeof store.current === "string" ? store.current : null);
			var byId = plainObject(store) && plainObject(store.byId) ? store.byId : null;
			var [, force] = React.useState(0);
			React.useEffect(function () {
				var fn = function () { force(function (t) { return t + 1; }); };
				catalog.listeners.add(fn);
				return function () { catalog.listeners.delete(fn); };
			}, []);
			// Prefer the subtree total (Agent Network). If the store isn't in the
			// expected shape, fall back to the current session's own cost only.
			var usd = agentNetworkUsd(byId, currentId, catalog.book);
			if (usd === null) {
				var own = timeline && timeline.cost;
				usd = own ? estimateCostUsd(own, catalog.book) : 0;
			}
			var text = costText(usd);
			if (!text) return null;
			return h(
				"button",
				{
					type: "button",
					className: "dsc-pill",
					title: "Estimated cost for this agent and every descendant subagent (the Context tab's Agent Network). Billed tokens \u00d7 live models.dev rates, same basis as dsh-context; for reference. Click to open the Context tab.",
					"data-session-cost": true,
					onClick: openContextTab,
				},
				text
			);
		});

		function apply(ctx) {
			var register = function () {
				var styleId = "dsc-cost-styles";
				if (typeof document !== "undefined" && !document.getElementById(styleId)) {
					var tag = document.createElement("style");
					tag.id = styleId;
					tag.textContent = CSS;
					document.head.appendChild(tag);
				}
				var dispose = ctx.slots.inject("conversation.composer.dock", function () {
					return ctx.slots.register(
						{ name: "conversation.composer.dock", id: "session-cost.cost", order: 10 },
						CostPill
					);
				});
				return function () {
					if (typeof dispose === "function") dispose();
					if (typeof document !== "undefined") {
						var el = document.getElementById(styleId);
						if (el && el.parentNode) el.parentNode.removeChild(el);
					}
				};
			};

			// Tie registration to this plugin's fiber so a reload unregisters the
			// entry and removes the style instead of leaving them bound to a dead plugin.
			if (typeof ctx.effect === "function") ctx.effect(register, "dsh-session-cost: cost badge");
			else register();
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
