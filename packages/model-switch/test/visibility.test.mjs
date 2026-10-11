// The open/closed rule of the repair panel is the only user-visible decision in
// the client half that can be tested without a browser, so it is kept as a pure
// function (`nextVisibility` in src/client.mjs) and exercised here.
//
// src/client.mjs is a classic script: it registers itself with the page's module
// loader at import time and cannot `import` a sibling module, which is why the
// decision lives in the bundle instead of a tested `visibility.mjs` the way
// `fit.mjs` is. Stubbing the loader is cheaper than pretending a DOM exists.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const registered = [];
globalThis.window = { __ModuleLoader__: { load: (def) => registered.push(def) } };
await import(pathToFileURL(path.join(here, "..", "src", "client.mjs")).href);

const definition = registered.find((def) => def.id === "dsh-model-switch");
assert.ok(definition, "client half did not register with the module loader");

// The factory calls require("react") only to *define* components; no hook runs
// until something renders, so a stand-in is enough to reach the exports.
const reactStandIn = {
	createElement: () => null,
	useState: () => [null, () => {}],
	useEffect: () => {},
};
const client = definition.factory(() => reactStandIn);
const decide = client.visibilityPolicy;

assert.equal(typeof decide, "function", "visibilityPolicy is not exported");

/** Mirrors what the panel does with the decision: store `open`, remember the flag. */
function panel() {
	let open = false;
	const autoShown = new Set();
	return {
		evaluate({ hard = false, settled = false, route = "p/m" }) {
			const next = decide({ hard, settled, open, autoShown: autoShown.has(route) });
			if (next.autoShown) autoShown.add(route);
			else autoShown.delete(route);
			open = next.open;
			return open;
		},
		click() {
			open = !open;
			return open;
		},
		get open() {
			return open;
		},
	};
}

test("the decision is a table over the four states", () => {
	assert.deepEqual(decide({ settled: true, hard: false, open: true, autoShown: true }), {
		open: false,
		autoShown: false,
	});
	assert.deepEqual(decide({ settled: false, hard: true, open: false, autoShown: false }), {
		open: true,
		autoShown: true,
	});
	assert.deepEqual(decide({ settled: false, hard: true, open: false, autoShown: true }), {
		open: false,
		autoShown: true,
	});
	assert.deepEqual(decide({ settled: false, hard: false, open: true, autoShown: false }), {
		open: true,
		autoShown: false,
	});
});

test("past the auto-compact line the panel stays hidden until it is asked for", () => {
	const view = panel();
	// The whole point of the change: crossing the line must not take composer space.
	assert.equal(view.evaluate({}), false);
	assert.equal(view.evaluate({}), false);
	assert.equal(view.click(), true);
	assert.equal(view.evaluate({}), true, "a poll must not close a panel the operator opened");
	assert.equal(view.click(), false);
	assert.equal(view.evaluate({}), false);
});

test("past the route's own window the panel warns once and then obeys the operator", () => {
	const view = panel();
	assert.equal(view.evaluate({ hard: true }), true, "the hard case opens itself");
	assert.equal(view.click(), false, "the operator closes it");
	assert.equal(view.evaluate({ hard: true }), false, "the next poll must not reopen it");
	assert.equal(view.evaluate({ hard: true }), false);
});

test("a hard regression on a different route warns again", () => {
	const view = panel();
	assert.equal(view.evaluate({ hard: true, route: "small/m" }), true);
	view.click();
	assert.equal(view.evaluate({ hard: true, route: "small/m" }), false);
	assert.equal(view.evaluate({ hard: true, route: "other/m" }), true);
});

test("settling closes the panel and hands the auto-open back", () => {
	const view = panel();
	assert.equal(view.evaluate({ hard: true }), true);
	view.click(); // closed by hand, flag spent
	assert.equal(view.evaluate({ settled: true }), false, "settling closes it");
	assert.equal(view.evaluate({ hard: true }), true, "a later regression warns again");
});

test("settling also closes a panel the operator had opened", () => {
	const view = panel();
	view.click();
	assert.equal(view.open, true);
	assert.equal(view.evaluate({ settled: true }), false);
	// ...and the next crossing starts collapsed rather than still open.
	assert.equal(view.evaluate({}), false);
});
