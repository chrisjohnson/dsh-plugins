// dsh-session-cost: Client half (browser bundle) - the composer cost badge.
//
// Registers ONE entry into `conversation.composer.dock` (a list, session-scoped
// slot; the core StatsPills "14.6M tok · Cache hit 97%" pill sits at id "stats",
// order 0). This entry draws a compact `$` total in that stats row, reading the
// session's own `contextTimeline.cost` projection - the per-turn billed token
// buckets dsh-context folds on every settlement - and pricing them against the
// live models.dev catalog, the SAME source and formula dsh-context uses, so the
// badge covers every model the Context page prices and shows the same number.
// It is hidden while the session's cost is $0, so the composer row is unchanged
// on idle or all-local sessions.
//
// The module loader hands this file React as a shared external; it cannot import
// a sibling module, so the cost math below is a byte-for-byte mirror of
// src/prices.mjs (the tested source of truth). Keep them in lockstep.
//
// The pill reuses the core StatsPills look (same `--dsw-alias-label-tertiary`
// color, inherited font, tabular numerals, pill shape) so it reads as a peer
// metric in the row rather than a foreign element.

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

		// Native StatsPills look: same tertiary label color, inherited font and
		// tabular numerals as the core pills, so the badge reads as a peer metric.
		var CSS =
			".dsc-pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;" +
			"color:var(--dsw-alias-label-tertiary);font:inherit;" +
			"font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);" +
			"font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;" +
			"background:transparent;border:none;border-radius:999px;padding:1px 8px;user-select:none}";

		// Standard seats arrive as hook-valued props; call the seat over a stable
		// module-scope fallback and branch on the RESULT (Rules-of-Hooks - a
		// conditional guard or early return above a hook is the #311 bug). All
		// hooks (the projection seat, useState, useEffect) run unconditionally.
		var NO_PROJECTION = function () { return null; };
		var CostPill = React.memo(function CostPill(props) {
			var timeline = (props.useProjection || NO_PROJECTION)("contextTimeline");
			var cost = timeline && timeline.cost;
			var [, force] = React.useState(0);
			React.useEffect(function () {
				var fn = function () { force(function (t) { return t + 1; }); };
				catalog.listeners.add(fn);
				return function () { catalog.listeners.delete(fn); };
			}, []);
			var usd = cost ? estimateCostUsd(cost, catalog.book) : 0;
			var text = costText(usd);
			if (!text) return null;
			return h(
				"span",
				{
					className: "dsc-pill",
					title: "Estimated session cost: billed tokens \u00d7 live models.dev rates (same basis as dsh-context Context Insights; for reference)",
					"data-session-cost": true,
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
