// Unit tests for the escape PASS (src/escape.mjs) with the stub parser from
// test/helpers.mjs. The real parser and the committed chunk are covered by
// test/chunk.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEscapeDollars } from "../src/escape.mjs";
import { stubFromMarkdown } from "./helpers.mjs";

const esc = makeEscapeDollars(stubFromMarkdown);

test("non-string input is returned unchanged", () => {
	assert.equal(esc(undefined), undefined);
	assert.equal(esc(5), 5);
	assert.equal(esc(null), null);
});

test("text without dollars is the identity", () => {
	assert.equal(esc("plain text, no dollars"), "plain text, no dollars");
});

test("a lone dollar becomes an escaped dollar", () => {
	assert.equal(esc("total was $55,011"), "total was \\$55,011");
});

test("a trailing lone dollar is escaped", () => {
	assert.equal(esc("ends with $"), "ends with \\$");
});

test("two lone dollars do not pair — each is escaped", () => {
	assert.equal(esc("from $55,011 outgoing rollover to $230 contributions"), "from \\$55,011 outgoing rollover to \\$230 contributions");
});

test("a $$ pair is kept as math delimiters", () => {
	assert.equal(esc("Inline math $$x^2$$ here."), "Inline math $$x^2$$ here.");
});

test("an escaped dollar inside $$ math is kept", () => {
	assert.equal(esc("costs $$\\$5 each$$ total"), "costs $$\\$5 each$$ total");
});

test("a triple dollar keeps the pair and escapes the third", () => {
	assert.equal(esc("price $$$5 today"), "price $$\\$5 today");
});

test("an already-escaped dollar is left alone", () => {
	assert.equal(esc("cost is \\$5 each"), "cost is \\$5 each");
});

test("a dollar after an even backslash run is a lone dollar", () => {
	assert.equal(esc("path C:\\\\$drive"), "path C:\\\\\\$drive");
});

test("dollar signs inside fenced code are untouched", () => {
	const text = "run:\n```\nexport HOME=$HOME\necho $DSH_*\n```\ndone";
	assert.equal(esc(text), text);
});

test("dollar signs inside inline code are untouched", () => {
	assert.equal(esc("use `$VAR` and `$HOME` here"), "use `$VAR` and `$HOME` here");
});

test("prose dollars around code are escaped, code is not", () => {
	assert.equal(esc("a `$X` b $Y"), "a `$X` b \\$Y");
});

test("an unclosed fence keeps the rest of the text verbatim", () => {
	const text = "```\n$HOME\n$DSH_*";
	assert.equal(esc(text), text);
});

test("the escape is idempotent", () => {
	const corpus = [
		"total was $55,011",
		"from $55,011 outgoing rollover to $230",
		"Inline math $$x^2$$ here.",
		"costs $$\\$5 each$$ total",
		"price $$$5 today",
		"cost is \\$5 each",
		"use `$VAR` and `$HOME` here",
		"run:\n```\nexport HOME=$HOME\necho $DSH_*\n```\ndone"
	];
	for (const text of corpus) {
		assert.equal(esc(esc(text)), esc(text), `not idempotent for: ${JSON.stringify(text)}`);
	}
});
