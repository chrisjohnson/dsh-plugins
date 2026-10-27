// dsh-math-literal: the render-time dollar escape, parser-independent.
//
// makeEscapeDollars(fromMarkdown) returns escapeDollars(text), which turns
// every "lone" $ into \$ so the settled markdown grammar — which enables
// single-$ inline math in this deployment — renders it as a literal dollar
// sign, matching the streaming arm (which has no math at all).
//
// What survives untouched:
//   - $$ pairs (the inline/block math delimiters),
//   - already-escaped \$ in the source,
//   - every $ inside a code span or code block (byte-for-byte; code must
//     stay verbatim).
//
// The fromMarkdown (mdast-util-from-markdown, commonmark only — code
// positions are identical under the renderer's gfm+math grammar) is injected
// by the caller; in the browser that binding is done once by the generated
// chunk src/client.parser.js (see scripts/build-parser.mjs).
//
// This module must stay import-free with exactly one top-level export: it is
// embedded verbatim into a classic browser script, and its logic is
// unit-tested on a bare clone (test/escape.test.mjs).

function lineStarts(text) {
	const starts = [0];
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

/** Absolute [start, end) offsets of every code region in one text. */
function codeRegions(text, fromMarkdown) {
	const tree = fromMarkdown(text, {});
	const starts = lineStarts(text);
	const toAbs = (pos) => starts[pos.line - 1] + (pos.column - 1);
	const regions = [];
	const walk = (node) => {
		for (const child of node.children ?? []) {
			if (child.type === "code" || child.type === "inlineCode") {
				regions.push([toAbs(child.position.start), toAbs(child.position.end)]);
			} else {
				walk(child);
			}
		}
	};
	walk(tree);
	regions.sort((a, b) => a[0] - b[0]);
	return regions;
}

/**
 * Bind the escape to one parser and return escapeDollars.
 * @param fromMarkdown - commonmark-only mdast parser (mdast-util-from-markdown).
 * @returns escapeDollars(text) — the escaped text, or the input unchanged.
 */
export function makeEscapeDollars(fromMarkdown) {
	return function escapeDollars(text) {
		if (typeof text !== "string" || text.indexOf("$") === -1) return text;
		const regions = codeRegions(text, fromMarkdown);
		let regionIndex = 0;
		const inRegion = (i) => {
			while (regionIndex < regions.length && regions[regionIndex][1] <= i) regionIndex += 1;
			return regionIndex < regions.length && regions[regionIndex][0] <= i;
		};
		let out = "";
		let backslashRun = 0;
		for (let i = 0; i < text.length; i += 1) {
			const ch = text[i];
			if (inRegion(i)) {
				out += ch;
				backslashRun = ch === "\\" ? backslashRun + 1 : 0;
				continue;
			}
			if (ch === "$") {
				if (backslashRun % 2 === 1) {
					out += "$"; // already escaped in the source
					backslashRun = 0;
					continue;
				}
				if (text[i + 1] === "$" && !inRegion(i + 1)) {
					out += "$$"; // keep the math delimiter pair
					i += 1;
					backslashRun = 0;
					continue;
				}
				out += "\\$"; // lone dollar: make it a literal
				backslashRun = 0;
				continue;
			}
			out += ch;
			backslashRun = ch === "\\" ? backslashRun + 1 : 0;
		}
		return out;
	};
}
