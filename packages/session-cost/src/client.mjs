// dsh-session-cost: Client half (browser bundle) - the composer cost badge.
//
// Registers ONE entry into `conversation.composer.dock` (a list, session-scoped
// slot; the core StatsPills "14.6M tok · Cache hit 97%" pill sits at id "stats",
// order 0). This entry draws a compact `$` total next to those stats, reading the
// session's own `contextTimeline.cost` projection - the per-turn billed token
// buckets dsh-context folds on every settlement - and pricing them with the
// public models.dev rate table. It is hidden while the session's cost is $0, so
// the composer row is unchanged on idle sessions.
//
// The module loader hands this file React as a shared external; it cannot import
// a sibling module, so the rate table + cost formula below are a byte-for-byte
// mirror of src/prices.mjs (the tested source of truth). Keep them in lockstep.

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
			return MODELS_DEV_PROVIDER_IDS[dshProviderId] || dshProviderId;
		}
		function isDeepSeekProvider(dshProviderId) {
			return modelsDevProviderOf(dshProviderId) === "deepseek";
		}
		var MODEL_RATES = {
			"deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
			"deepseek-v4-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
		};
		function rateForModel(model) {
			var r = MODEL_RATES[model];
			if (!r) return null;
			return {
				hit: r.cacheRead != null ? r.cacheRead : r.input,
				miss: r.input,
				write: r.cacheWrite != null ? r.cacheWrite : r.input,
				out: r.output,
			};
		}
		function finite(value) {
			return typeof value === "number" && isFinite(value) ? value : 0;
		}
		function plainObject(value) {
			return value != null && typeof value === "object" && !Array.isArray(value);
		}
		function estimateCostUsd(cost) {
			if (!plainObject(cost)) return 0;
			var total = 0;
			var any = false;
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
					var rate = rateForModel(model);
					if (!rate) continue;
					for (var period of ["peak", "off"]) {
						var b = periods[period];
						if (!plainObject(b)) continue;
						var n = (finite(b.cacheRead) * rate.hit + finite(b.uncached) * rate.miss +
							finite(b.cacheWrite) * rate.write + finite(b.output) * rate.out) / 1e6;
						total += deep && period === "peak" ? n * 2 : n;
						any = true;
					}
				}
			}
			return any ? total : 0;
		}
		function costText(usd) {
			var n = typeof usd === "number" && isFinite(usd) && usd > 0 ? usd : 0;
			if (n < 1000) {
				var s = n.toFixed(2);
				return s === "0.00" ? null : "$" + s;
			}
			return "$" + Math.round(n).toLocaleString("en-US");
		}
		// ---------------------------------------------------------------------

		var CSS =
			".dsc-cost{display:inline-flex;align-items:center;gap:3px;" +
			"font-size:12px;line-height:1;font-weight:500;" +
			"font-variant-numeric:tabular-nums;white-space:nowrap;" +
			"color:var(--dsw-alias-label-secondary,#6b7280);padding:0 2px;user-select:none}";

		// Standard seats arrive as hook-valued props; call the seat over a stable
		// module-scope fallback and branch on the RESULT (Rules-of-Hooks - a
		// conditional `typeof` guard or early return above a hook is the #311 bug).
		var NO_PROJECTION = function () { return null; };
		var CostPill = React.memo(function CostPill(props) {
			var timeline = (props.useProjection || NO_PROJECTION)("contextTimeline");
			var cost = timeline && timeline.cost;
			var usd = cost ? estimateCostUsd(cost) : 0;
			var text = costText(usd);
			if (!text) return null;
			return h(
				"span",
				{
					className: "dsc-cost",
					title: "Estimated session cost: billed tokens × models.dev rates (see dsh-context Context Insights for the breakdown)",
					"data-session-cost": true,
				},
				text
			);
		});

		function apply(ctx) {
			var register = function () {
				var styleId = "dsc-cost-styles";
				var tag = null;
				if (typeof document !== "undefined" && !document.getElementById(styleId)) {
					tag = document.createElement("style");
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
