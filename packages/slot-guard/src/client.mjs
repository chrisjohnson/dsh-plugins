// dsh-slot-guard: Client half (browser).
//
// A diagnostic. It never renders UI of its own and registers no slots; it watches
// the crash surfaces the harness renderer already has and makes them impossible
// to miss.
//
// WHY THIS EXISTS
//
// A plugin's browser half mounts into the same React root as core. When one of
// those entries throws during render, `SlotErrorBoundary` in
// `@deepseek-ai/dsh-client-ui-renderer` catches it, logs
// `slot entry crashed in '<slotKey>':` and renders `<div data-slot-error="<slotKey>">`
// — an empty div with no size. The region goes invisibly blank. When the crash
// escapes every boundary, the whole root unmounts and the page is simply white.
// The usual cause is a hook-count change in a mounted entry (production React
// error #311, #310 when a list grew, #300 for an early return above a hook), and
// in a production build the message is a number nobody can read without opening
// devtools and following a link.
//
// WHAT IT DOES
//
//   1. Decodes. Wraps `console.error` (read-only: the original call always runs
//      first and unchanged) and listens on `window` for `error` and
//      `unhandledrejection`. A React minified-error code becomes a timestamped,
//      plain-English line naming the slot key when it is known.
//   2. Shows the crash face. Injects CSS that turns `div[data-slot-error]` and
//      `div[data-factory-error]` into a visible red banner carrying the slot key
//      and a reload hint, so a crashed region is a red box, not a blank one.
//   3. Refuses the white page. Watches the React root: once the page has rendered
//      and then goes empty and stays empty, it paints a full-screen overlay with
//      the decoded reason and a reload button. A page that was never healthy (a
//      boot failure, a wrong URL) gets no overlay — that is not this crash.
//
// It is deliberately hook-free plain DOM: no React, no slots, no `dsh.client`
// seats, so it cannot itself become the thing it is watching for. Everything it
// touches is additive and disappears with the bundle.
//
// The pure decoding half is exported on the module face so test/decode.test.mjs
// can exercise the shipped source without a browser.

window.__ModuleLoader__.load({
	id: "dsh-slot-guard",
	factory: function () {
		var module = { exports: {} };
		var exports = module.exports;

		var VERSION = "0.1.1";
		var STYLE_ID = "dsh-slot-guard-style";
		var OVERLAY_ID = "dsh-slot-guard-overlay";
		var ROOT_ID = "root";
		// How long the root must stay empty before the overlay paints. A normal
		// client-side navigation never empties #root; a reload does, and it is
		// back within this window.
		var EMPTY_GRACE_MS = 1200;
		// Identical decoded lines inside this window are logged once.
		var REPEAT_MS = 5000;

		// ------------------------------------------------------------------
		// Pure decoding (no DOM, no globals): tested directly.
		// ------------------------------------------------------------------

		// The React production error codes this plugin can explain. The texts are
		// React's own (scripts/error-codes/codes.json), so the decoded line reads
		// like the development build would have.
		var REACT_MESSAGES = {
			300: "Rendered fewer hooks than expected. This may be caused by an accidental early return statement.",
			310: "Rendered more hooks than during the previous render.",
			311: "Should have a queue. You are likely calling Hooks conditionally, which is not allowed.",
			312: "Rendered more hooks than during the previous render."
		};
		var HOOK_ORDER_CODES = [300, 310, 311, 312];

		var SLOT_KEY_RE = /slot (?:entry|factory occurrence) crashed in '([^']*)'/;
		var REACT_CODE_RE = /Minified React error #(\d+)/;

		/** The React production error code inside `text`, or null. */
		function reactErrorCode(text) {
			var m = REACT_CODE_RE.exec(String(text === null || text === undefined ? "" : text));
			return m ? Number(m[1]) : null;
		}

		/** The slot key a renderer crash line names, or null. */
		function slotKeyIn(text) {
			var m = SLOT_KEY_RE.exec(String(text === null || text === undefined ? "" : text));
			return m ? m[1] : null;
		}

		/**
		 * Turn a raw error string into something an operator can act on.
		 *
		 * @returns {{code: number|null, hookOrder: boolean, reactMessage: string,
		 *   reason: string, advice: string}}
		 */
		function decode(text) {
			var raw = String(text === null || text === undefined ? "" : text);
			var code = reactErrorCode(raw);
			if (code === null) {
				return { code: null, hookOrder: false, reactMessage: "", reason: raw.slice(0, 300), advice: "" };
			}
			var message = REACT_MESSAGES[code] || "Minified React error #" + code;
			var hookOrder = HOOK_ORDER_CODES.indexOf(code) !== -1;
			return {
				code: code,
				hookOrder: hookOrder,
				reactMessage: message,
				reason: hookOrder
					? "a component changed how many React hooks it calls between two renders of the same mounted entry"
					: message,
				advice: hookOrder
					? "look at the plugin that owns this slot: standard state arrives as hook-valued props (useInput, useSessions and friends), so a ternary guard around a seat, a typeof-function check that returns before a hook, a try/catch around a seat, or an early return above a hook all change the hook count when a prop appears or disappears between two renders of the same mounted component. Call the seat over a stable module-scope fallback and branch on the result."
					: "see https://react.dev/errors/" + code
			};
		}

		/**
		 * The one-line headline for a decoded crash.
		 *
		 * @param {object} decoded - decode() output.
		 * @param {string|null} slotKey - the slot the renderer named, when known.
		 * @param {string} [where] - what surfaced it ("slot boundary", "window.error", ...).
		 */
		function headline(decoded, slotKey, where) {
			var who = slotKey ? "slot '" + slotKey + "'" : "a slot entry";
			if (decoded.code === null) return who + " reported an error (" + (where || "unknown") + ")";
			if (decoded.hookOrder) {
				return who + " crashed with React #" + decoded.code + " — " + decoded.reason + " (" + (where || "unknown") + ")";
			}
			return who + " crashed with React #" + decoded.code + " — " + decoded.reactMessage + " (" + (where || "unknown") + ")";
		}

		exports.version = VERSION;
		exports.reactErrorCode = reactErrorCode;
		exports.slotKeyIn = slotKeyIn;
		exports.decode = decode;
		exports.headline = headline;

		// ------------------------------------------------------------------
		// Browser wiring. Every step is guarded: a guard that throws while
		// reporting someone else's crash would be a very poor guard.
		// ------------------------------------------------------------------

		var nativeError = typeof console !== "undefined" && console.error ? console.error.bind(console) : function () {};
		var seen = Object.create(null);
		var lastCrash = null;

		function safe(fn) {
			try {
				fn();
			} catch (error) {
				nativeError("[dsh-slot-guard] the guard itself failed; ignoring", error);
			}
		}

		/** Log a decoded line, at most once per REPEAT_MS per distinct message. */
		function report(kind, line, detail) {
			var now = Date.now();
			var key = kind + "|" + line;
			if (seen[key] && now - seen[key] < REPEAT_MS) return;
			seen[key] = now;
			nativeError("[dsh-slot-guard " + new Date().toISOString() + "] " + kind + ": " + line + (detail ? "\n  " + detail : ""));
		}

		function noteCrash(text, where) {
			var decoded = decode(text);
			var slotKey = slotKeyIn(text) || (lastCrash && lastCrash.slotKey) || null;
			if (decoded.code === null && !slotKey) return;
			lastCrash = { code: decoded.code, slotKey: slotKey, at: Date.now(), headline: headline(decoded, slotKey, where), advice: decoded.advice };
			if (typeof window !== "undefined") window.__dshSlotGuard = guardState();
			if (decoded.code === null) {
				report("slot-crash", headline(decoded, slotKey, where), "the region rendered its crash face; the original line is above");
				return;
			}
			report("react-error", headline(decoded, slotKey, where), decoded.advice);
		}

		function guardState() {
			return { version: VERSION, lastCrash: lastCrash, overlayShown: !!overlay };
		}

		function installConsoleWatch() {
			if (typeof console === "undefined") return;
			var original = console.error;
			console.error = function () {
				if (typeof original === "function") original.apply(console, arguments);
				var text = "";
				for (var i = 0; i < arguments.length; i++) {
					var a = arguments[i];
					text += " " + (a && a.message ? a.message : String(a));
				}
				if (text.indexOf("dsh-slot-guard") !== -1) return;
				safe(function () {
					noteCrash(text, "slot boundary");
				});
			};
		}

		function installWindowWatch() {
			if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
			window.addEventListener("error", function (event) {
				safe(function () {
					var message = String((event && (event.message || (event.error && event.error.message))) || "");
					if (reactErrorCode(message) !== null) noteCrash(message, "window.error");
				});
			}, true);
			window.addEventListener("unhandledrejection", function (event) {
				safe(function () {
					var reason = event && event.reason;
					var message = String((reason && (reason.message || reason.stack)) || reason || "");
					if (reactErrorCode(message) !== null) noteCrash(message, "unhandledrejection");
				});
			});
		}

		var CSS = "" +
			"div[data-slot-error],div[data-factory-error]{display:block!important;box-sizing:border-box;min-height:34px;" +
			"margin:8px;padding:9px 11px;border:1px solid #b3261e;border-radius:8px;background:#fdecea;color:#7f1d1d;" +
			"font:600 12px/17px var(--dsw-font-family,ui-sans-serif,system-ui,sans-serif);white-space:pre-wrap;overflow:auto}" +
			"div[data-slot-error]::before{content:\"dsh-slot-guard: a plugin crashed while rendering this region (slot '\" attr(data-slot-error) \"'). The console has the decoded reason. Hard-reload (Ctrl/Cmd+Shift+R) to recover.\"}" +
			"div[data-factory-error]::before{content:\"dsh-slot-guard: a slot factory crashed here (factory '\" attr(data-factory-error) \"'). The console has the details. Hard-reload (Ctrl/Cmd+Shift+R) to recover.\"}" +
			"@media (prefers-color-scheme:dark){div[data-slot-error],div[data-factory-error]{background:#3a1210;border-color:#f3b3ac;color:#ffd7d3}}";

		function injectStyles() {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
			var style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			(document.head || document.documentElement).appendChild(style);
		}

		var overlay = null;

		function showOverlay() {
			if (overlay || typeof document === "undefined" || !document.body) return;
			var reason = lastCrash ? lastCrash.headline : "the React root went empty without a slot boundary catching it";
			var advice = (lastCrash && lastCrash.code && lastCrash.advice) || "";
			var box = document.createElement("div");
			box.id = OVERLAY_ID;
			box.setAttribute("role", "alert");
			box.setAttribute("aria-live", "assertive");
			box.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
				"padding:24px;background:rgba(20,20,20,.92);color:#fff;font:400 14px/21px var(--dsw-font-family,ui-sans-serif,system-ui,sans-serif)";
			var card = document.createElement("div");
			card.style.cssText = "max-width:640px;padding:22px 24px;border:1px solid #b3261e;border-radius:12px;background:#2a1615;box-shadow:0 20px 60px rgba(0,0,0,.5)";
			var title = document.createElement("div");
			title.textContent = "The UI crashed";
			title.style.cssText = "margin:0 0 8px;font:700 18px/24px var(--dsw-font-family,ui-sans-serif,system-ui,sans-serif)";
			var why = document.createElement("div");
			why.textContent = reason;
			why.style.cssText = "margin:0 0 10px;color:#ffd7d3";
			var hint = document.createElement("div");
			hint.textContent = "Reload the page to recover." + (advice ? " " + advice : "");
			hint.style.cssText = "margin:0 0 16px;color:#e6c7c4;font-size:12px;line-height:18px";
			var button = document.createElement("button");
			button.type = "button";
			button.textContent = "Reload now";
			button.style.cssText = "padding:8px 16px;border:1px solid #f3b3ac;border-radius:8px;background:#b3261e;color:#fff;" +
				"font:600 13px/18px var(--dsw-font-family,ui-sans-serif,system-ui,sans-serif);cursor:pointer";
			button.addEventListener("click", function () {
				window.location.reload();
			});
			card.appendChild(title);
			card.appendChild(why);
			card.appendChild(hint);
			card.appendChild(button);
			box.appendChild(card);
			document.body.appendChild(box);
			overlay = box;
			report("whiteout", "the React root stayed empty; showing the recovery overlay", reason);
		}

		function hideOverlay() {
			if (!overlay) return;
			if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
			overlay = null;
		}

		/** Is the app's React root currently rendering nothing? */
		function rootBlank() {
			var root = document.getElementById(ROOT_ID);
			if (!root) return document.readyState === "complete";
			if (root.childElementCount === 0) return true;
			var text = "";
			try {
				text = root.innerText || root.textContent || "";
			} catch (error) {
				text = "";
			}
			return text.trim().length === 0 && root.offsetHeight === 0;
		}

		var seenHealthy = false;
		var emptySince = 0;

		function scanSlotFaces() {
			if (typeof document === "undefined" || !document.querySelectorAll) return;
			var nodes = document.querySelectorAll("[data-slot-error],[data-factory-error]");
			for (var i = 0; i < nodes.length; i++) {
				var el = nodes[i];
				if (el.getAttribute("data-dsh-guard-seen")) continue;
				el.setAttribute("data-dsh-guard-seen", "1");
				var key = el.getAttribute("data-slot-error") || el.getAttribute("data-factory-error") || "?";
				noteCrash("slot entry crashed in '" + key + "':", "crash face");
			}
		}

		function check() {
			if (typeof document === "undefined" || document.readyState !== "complete") return;
			scanSlotFaces();
			var blank = rootBlank();
			if (!blank) {
				seenHealthy = true;
				emptySince = 0;
				if (overlay) hideOverlay();
				return;
			}
			if (!seenHealthy) return;
			if (!emptySince) {
				emptySince = Date.now();
				return;
			}
			if (Date.now() - emptySince > EMPTY_GRACE_MS) showOverlay();
		}

		function start() {
			safe(injectStyles);
			if (typeof document !== "undefined") {
				var pending = false;
				var schedule = function () {
					if (pending) return;
					pending = true;
					setTimeout(function () {
						pending = false;
						safe(check);
					}, 250);
				};
				if (typeof MutationObserver === "function") {
					new MutationObserver(schedule).observe(document.documentElement, {
						childList: true,
						subtree: true,
						attributes: true,
						attributeFilter: ["data-slot-error", "data-factory-error"]
					});
				}
				// Backstop: a crash that mutates nothing (the boundary already rendered
				// its face before this bundle loaded) is still found within a second.
				setInterval(function () {
					safe(check);
				}, 1000);
			}
			safe(check);
		}

		function apply() {
			if (typeof window === "undefined") return;
			if (window.__dshSlotGuard && window.__dshSlotGuard.version) return;
			window.__dshSlotGuard = guardState();
			installConsoleWatch();
			installWindowWatch();
			if (typeof document !== "undefined" && document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
			else start();
		}

		exports.apply = apply;
		safe(apply);
		return module.exports;
	}
});
