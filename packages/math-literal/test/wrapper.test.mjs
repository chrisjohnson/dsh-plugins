// Executes the injected head script (src/wrapper.mjs) in a Node vm against
// both orderings of the boot queue facade, and proves: the seed swap happens
// exactly at create() time, only MarkdownText changes, the escape global is
// consulted per render, and every failure path degrades to the untouched boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { wrapperSource } from "../src/wrapper.mjs";

const PRIM = "@deepseek-ai/dsh-client-ui-primitives";

function makeFacade(createImpl) {
	return {
		mode: "queue",
		pendingQueue: [],
		load(registration) {
			this.pendingQueue.push(registration);
		},
		create(options) {
			if (createImpl !== undefined) return createImpl(options);
			return { created: true, options };
		}
	};
}

function boot({ facadeFirst, createImpl, escape, staticModules }) {
	const warnings = [];
	const context = { console: { warn: (...args) => warnings.push(args) } };
	if (facadeFirst) context.__ModuleLoader__ = makeFacade(createImpl);
	createContext(context);
	runInContext(wrapperSource, context);
	if (!facadeFirst) context.__ModuleLoader__ = makeFacade(createImpl);
	if (escape !== undefined) context.__DSH_MATH_LITERAL_ESCAPE__ = escape;
	const options = staticModules === undefined ? {} : { staticModules };
	const result = context.__ModuleLoader__.create(options);
	return { context, options, result, warnings };
}

function makeTable(realMarkdownText = function defaultMarkdownText() {}) {
	const jsxCalls = [];
	const prim = Object.freeze(Object.defineProperty({ __proto__: null, MarkdownText: realMarkdownText, other: 42 }, "__proto__", { value: null }));
	const table = {
		[PRIM]: prim,
		"react/jsx-runtime": {
			jsx: (type, props) => {
				// Record a main-realm copy: props is built inside the vm, so
				// its prototype belongs to the vm realm and deepStrictEqual
				// would reject it.
				jsxCalls.push([type, { ...props }]);
				return { type, props };
			}
		}
	};
	return { prim, table, jsxCalls, realMarkdownText };
}

// The real MarkdownText is a React.memo exotic object, not a function.
const memoOf = (fn) => ({ $$typeof: Symbol.for("react.memo"), type: fn, compare: null });
const COMPONENTS = [
	["a plain function", function realMarkdownText() {}],
	["a React.memo exotic object", null]
];
COMPONENTS[1][1] = memoOf(function realMemoComponent() {});

for (const facadeFirst of [true, false]) {
	const label = facadeFirst ? "facade present when the wrapper runs" : "wrapper runs before the facade (assignment trapped)";

	for (const [shapeLabel, component] of COMPONENTS) {
		test(`${label}, MarkdownText is ${shapeLabel}: create swaps the seed entry and only MarkdownText changes`, () => {
			const { prim, table, jsxCalls, realMarkdownText } = makeTable(component);
			const { options, result, warnings } = boot({ facadeFirst, createImpl: () => "CREATED", escape: (t) => "ESCAPED:" + t, staticModules: table });
			assert.deepEqual(warnings, []);
			assert.equal(result, "CREATED");
			assert.notEqual(options.staticModules[PRIM], prim, "the seed entry must be replaced");
			assert.equal(options.staticModules[PRIM].other, 42, "other exports are forwarded");
			const safe = options.staticModules[PRIM].MarkdownText;
		assert.equal(typeof safe, "function");
		const element = safe({ text: "$5", keep: 1 });
		assert.equal(jsxCalls.length, 1);
		assert.equal(jsxCalls[0][0], realMarkdownText, "the real component renders");
		assert.deepEqual(jsxCalls[0][1], { text: "ESCAPED:$5", keep: 1 }, "all props pass through, only text is escaped");
		});
	}

	test(`${label}: without the escape global the text passes through untouched`, () => {
		const { table, jsxCalls, realMarkdownText } = makeTable();
		const { warnings } = boot({ facadeFirst, createImpl: () => "CREATED", staticModules: table });
		assert.deepEqual(warnings, []);
		const safe = table[PRIM].MarkdownText;
		safe({ text: "$5" });
		assert.equal(jsxCalls[0][0], realMarkdownText);
		assert.deepEqual(jsxCalls[0][1], { text: "$5" });
	});

	test(`${label}: an escape that throws falls back to the original text`, () => {
		const { table, jsxCalls } = makeTable();
		const { warnings } = boot({ facadeFirst, escape: () => {
			throw new Error("boom");
		}, staticModules: table });
		assert.deepEqual(warnings, []);
		table[PRIM].MarkdownText({ text: "$5" });
		assert.deepEqual(jsxCalls[0][1], { text: "$5" });
	});

	test(`${label}: the escape is consulted per render, not captured`, () => {
		const { table, jsxCalls } = makeTable();
		const { context, warnings } = boot({ facadeFirst, createImpl: () => "CREATED", staticModules: table });
		assert.deepEqual(warnings, []);
		context.__DSH_MATH_LITERAL_ESCAPE__ = (t) => "ONE:" + t;
		table[PRIM].MarkdownText({ text: "$5" });
		context.__DSH_MATH_LITERAL_ESCAPE__ = (t) => "TWO:" + t;
		table[PRIM].MarkdownText({ text: "$5" });
		assert.deepEqual(jsxCalls.map(([, props]) => props.text), ["ONE:$5", "TWO:$5"]);
	});

	test(`${label}: the facade queue and load() are untouched`, () => {
		const { context } = boot({ facadeFirst });
		context.__ModuleLoader__.load({ id: "some-plugin", factory: () => ({}) });
		assert.deepEqual(context.__ModuleLoader__.pendingQueue, [{ id: "some-plugin", factory: context.__ModuleLoader__.pendingQueue[0].factory }]);
	});
}

test("a prim entry without MarkdownText is left alone", () => {
	const prim = Object.freeze({ __proto__: null, other: 1 });
	const table = { [PRIM]: prim, "react/jsx-runtime": { jsx: () => {} } };
	const { options, result, warnings } = boot({ facadeFirst: true, createImpl: () => "CREATED", staticModules: table });
	assert.deepEqual(warnings, []);
	assert.equal(result, "CREATED");
	assert.equal(options.staticModules[PRIM], prim, "entry must be unchanged");
});

test("options without staticModules pass through", () => {
	const { result, warnings } = boot({ facadeFirst: false, createImpl: (o) => "CREATED:" + JSON.stringify(o) });
	assert.deepEqual(warnings, []);
	assert.equal(result, "CREATED:{}",);
});

test("null options do not throw", () => {
	let received;
	boot({ facadeFirst: true, createImpl: (o) => {
		received = o;
		return "OK";
	} });
	// The default boot() calls create with {} — call the wrapped create with null directly:
	const context = { console: { warn: () => {} } };
	context.__ModuleLoader__ = makeFacade((o) => {
		received = o;
		return "OK";
	});
	createContext(context);
	runInContext(wrapperSource, context);
	const result = context.__ModuleLoader__.create(null);
	assert.equal(result, "OK");
	assert.equal(received, null);
});

test("double installation is idempotent", () => {
	let calls = 0;
	const context = { console: { warn: () => {} } };
	context.__ModuleLoader__ = makeFacade(() => {
		calls += 1;
		return "CREATED";
	});
	createContext(context);
	runInContext(wrapperSource, context);
	runInContext(wrapperSource, context);
	context.__ModuleLoader__.create({});
	context.__ModuleLoader__.create({});
	assert.equal(calls, 2, "the original create must be called exactly once per create()");
});

test("the injected source contains no </script sequence", () => {
	assert.ok(!wrapperSource.includes("</script"), "the text is spliced raw into <script>…</script>");
});
