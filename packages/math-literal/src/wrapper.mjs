// dsh-math-literal: the head script injected on every index response.
//
// src/host.mjs pushes this source as a `webserver/index-inject` row
// (kind "script", placement "head"). dsh-host-webserver splices it into
// index.html right after the opening head tag, so it runs during HTML parse —
// before the shell's deferred module script — and intercepts
// window.__ModuleLoader__.create, the single choke point between the boot
// queue facade and the shell's static module table. It swaps the
// @deepseek-ai/dsh-client-ui-primitives seed entry's MarkdownText for a
// SafeMarkdownText that runs text through
// globalThis.__DSH_MATH_LITERAL_ESCAPE__ (installed by the Client half's
// parser chunk) before the real component renders.
//
// Ordering-robust and idempotent: if the queue facade exists when this script
// runs it is wrapped in place; otherwise the assignment of
// window.__ModuleLoader__ is trapped and the facade is wrapped as it arrives.
// Every assumption is feature-detected and every failure path degrades to the
// untouched boot (a console.warn), so this script can never break the page.
//
// NOTE: the webserver splices this text raw into <script>…</script>, so it
// must not contain a "</script" sequence. Kept dependency-free and ES2015;
// test/wrapper.test.mjs executes it in a Node vm against both orderings.

export const wrapperSource = String.raw`(function () {
	"use strict";
	var PRIM = "@deepseek-ai/dsh-client-ui-primitives";
	var MARKED = "__dshMathLiteralWrapped";

	function warn(message, err) {
		try {
			console.warn("dsh-math-literal: " + message, err);
		} catch (ignored) {
			// The page must never die because of a missing console.
		}
	}

	function safeText(text) {
		var esc = globalThis.__DSH_MATH_LITERAL_ESCAPE__;
		if (typeof esc !== "function" || typeof text !== "string") return text;
		try {
			var next = esc(text);
			return typeof next === "string" ? next : text;
		} catch (err) {
			return text;
		}
	}

	// The real MarkdownText is a React.memo exotic object (an OBJECT with
	// $$typeof Symbol.for("react.memo"), not a function), so a
	// typeof === "function" check silently misses it.
	function isComponent(value) {
		if (typeof value === "function") return true;
		if (value === null || typeof value !== "object") return false;
		return value.$$typeof === Symbol.for("react.memo") || value.$$typeof === Symbol.for("react.forward_ref");
	}

	function swapSeed(options) {
		if (options === null || typeof options !== "object") return;
		var table = options.staticModules;
		if (table === null || typeof table !== "object") return;
		var prim = table[PRIM];
		if (prim === null || typeof prim !== "object" || !isComponent(prim.MarkdownText)) return;
		var jsxRuntime = table["react/jsx-runtime"];
		if (jsxRuntime === null || typeof jsxRuntime !== "object" || typeof jsxRuntime.jsx !== "function") return;
		var realMarkdownText = prim.MarkdownText;
		var jsx = jsxRuntime.jsx;

		function SafeMarkdownText(props) {
			var next = Object.assign({}, props);
			next.text = safeText(props.text);
			return jsx(realMarkdownText, next);
		}

		// The seed entry is a FROZEN namespace object, so a Proxy cannot
		// intercept its non-configurable properties (invariant violation on
		// first access). Instead build a plain copy: every own property is
		// re-declared verbatim, and MarkdownText becomes the safe component.
		var copy = Object.create(null);
		var names = Object.getOwnPropertyNames(prim);
		for (var i = 0; i < names.length; i += 1) {
			if (names[i] === "MarkdownText") continue;
			Object.defineProperty(copy, names[i], Object.getOwnPropertyDescriptor(prim, names[i]));
		}
		var symbols = Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(prim) : [];
		for (var s = 0; s < symbols.length; s += 1) {
			Object.defineProperty(copy, symbols[s], Object.getOwnPropertyDescriptor(prim, symbols[s]));
		}
		copy.MarkdownText = SafeMarkdownText;
		table[PRIM] = copy;
	}

	function wrap(loader) {
		if (loader === null || typeof loader !== "object" || typeof loader.create !== "function") return loader;
		if (loader[MARKED] === true) return loader;
		var originalCreate = loader.create;
		var wrapped = function (options) {
			try {
				swapSeed(options);
			} catch (err) {
				warn("seed swap skipped", err);
			}
			return originalCreate.call(loader, options);
		};
		try {
			loader.create = wrapped;
			loader[MARKED] = true;
		} catch (err) {
			warn("could not wrap __ModuleLoader__.create", err);
		}
		return loader;
	}

	function install() {
		var current = globalThis.__ModuleLoader__;
		if (current !== null && typeof current === "object" && typeof current.create === "function") {
			wrap(current);
			return;
		}
		var trapped = current;
		try {
			Object.defineProperty(globalThis, "__ModuleLoader__", {
				configurable: true,
				enumerable: true,
				get: function () {
					return trapped;
				},
				set: function (value) {
					trapped = wrap(value);
				}
			});
		} catch (err) {
			warn("could not trap __ModuleLoader__ assignment", err);
		}
	}

	install();
})();`;
