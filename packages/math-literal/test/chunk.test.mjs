// Runs the committed src/client.parser.js in a Node vm — exactly the file the
// on-demand chunk route serves — and tests the real bundled parser end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const chunkSource = readFileSync(join(root, "src", "client.parser.js"), "utf8");
const escapeSource = readFileSync(join(root, "src", "escape.mjs"), "utf8");
const embeddedEscape = escapeSource.replace(/^export function/m, "function");

function bootChunk() {
	const registrations = [];
	const context = { console: { warn: () => {} } };
	context.window = context;
	// The bundled decoder pre-creates one DOM element for HTML-entity
	// decoding (browser-only; the test corpus contains no entities).
	context.document = { createElement: () => ({ innerHTML: "", textContent: "" }) };
	context.__ModuleLoader__ = { load: (registration) => registrations.push(registration) };
	createContext(context);
	runInContext(chunkSource, context);
	return { registrations, context };
}

test("the chunk registers as a package-local chunk", () => {
	const { registrations } = bootChunk();
	assert.equal(registrations.length, 1);
	assert.deepEqual({ id: registrations[0].id, chunk: registrations[0].chunk }, { id: "dsh-math-literal", chunk: "client.parser.js" });
	assert.equal(typeof registrations[0].factory, "function");
});

test("the factory returns escapeDollars bound to the bundled parser, requiring nothing", () => {
	const { registrations } = bootChunk();
	const exports = registrations[0].factory(() => {
		throw new Error("the chunk must not require anything");
	});
	assert.equal(typeof exports.escapeDollars, "function");
	assert.equal(exports.escapeDollars("no dollars"), "no dollars");
	assert.equal(exports.escapeDollars("$5"), "\\$5");
});

test("the committed chunk embeds src/escape.mjs verbatim (stale-artifact gate)", () => {
	assert.ok(chunkSource.includes(embeddedEscape), "src/client.parser.js is stale — rebuild with `node scripts/build-parser.mjs`");
});

test("the banner pins the bundled parser version", () => {
	assert.match(chunkSource, /mdast-util-from-markdown \d+\.\d+\.\d+/);
});

const { context } = bootChunk();
const fromMarkdown = context.DSH_MATH_LITERAL_PARSER.fromMarkdown;
const { escapeDollars } = bootChunk().registrations[0].factory(() => {
	throw new Error("no requires");
});

test("currency and shell variables: lone dollars escaped, no pair survives", () => {
	assert.equal(escapeDollars("unpaired: total was $55,011 and nothing followed"), "unpaired: total was \\$55,011 and nothing followed");
	assert.equal(escapeDollars("paired: from $55,011 outgoing rollover to $230 contributions"), "paired: from \\$55,011 outgoing rollover to \\$230 contributions");
	assert.equal(
		escapeDollars("Set DSH_HOME=/data/dsh, use $WORKDIR/src/$MODULE, glob $DSH_* and $HOME."),
		"Set DSH_HOME=/data/dsh, use \\$WORKDIR/src/\\$MODULE, glob \\$DSH_* and \\$HOME."
	);
});

test("real math delimiters survive", () => {
	assert.equal(escapeDollars("Inline math $$x^2$$ here."), "Inline math $$x^2$$ here.");
	assert.equal(escapeDollars("$$\nx^2 + y^2\n$$\n"), "$$\nx^2 + y^2\n$$\n");
	assert.equal(escapeDollars("Inline TeX \\(x^2\\) here."), "Inline TeX \\(x^2\\) here.");
});

const CODE_SHAPES = [
	"run this:\n```\nexport HOME=$HOME\necho $DSH_*\n```\ndone",
	"para\n\n    $HOME is a var\n\nend",
	"para\n\n\t$HOME is a var\n\nend",
	"use `$VAR` and `$HOME` here",
	"```\n$$x$$ and $y\n```",
	"> ```\n> $HOME\n> ```",
	"- ```\n  - $HOME\n  ```"
];

test("code shapes are byte-identical after the escape (real parser)", () => {
	for (const text of CODE_SHAPES) {
		assert.equal(escapeDollars(text), text, `code shape must be untouched: ${JSON.stringify(text)}`);
	}
});

test("edges", () => {
	assert.equal(escapeDollars("price $$$5 today"), "price $$\\$5 today");
	assert.equal(escapeDollars("cost is \\$5 each"), "cost is \\$5 each");
	assert.equal(escapeDollars("cost $5\nthen $6 later"), "cost \\$5\nthen \\$6 later");
	assert.equal(escapeDollars("[see the $5 fee](http://example.com) ok"), "[see the \\$5 fee](http://example.com) ok");
	assert.equal(escapeDollars("line one $5\r\nline two $6"), "line one \\$5\r\nline two \\$6");
});

test("the escape is idempotent on the whole corpus", () => {
	const corpus = [
		"unpaired: total was $55,011 and nothing followed",
		"paired: from $55,011 outgoing rollover to $230 contributions",
		"Inline math $$x^2$$ here.",
		"$$\nx^2 + y^2\n$$\n",
		"price $$$5 today",
		"cost is \\$5 each",
		...CODE_SHAPES
	];
	for (const text of corpus) {
		assert.equal(escapeDollars(escapeDollars(text)), escapeDollars(text), `not idempotent for: ${JSON.stringify(text)}`);
	}
});

test("code node values survive the escape (real parser round-trip)", () => {
	const codeValues = (node) => (node.type === "code" ? [node.value] : (node.children ?? []).flatMap(codeValues));
	for (const text of CODE_SHAPES) {
		const before = codeValues(fromMarkdown(text));
		const after = codeValues(fromMarkdown(escapeDollars(text)));
		assert.deepEqual(after, before, `code values must survive: ${JSON.stringify(text)}`);
	}
});
