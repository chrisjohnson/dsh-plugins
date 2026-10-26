#!/usr/bin/env node
// Rebuild src/client.parser.js — the browser chunk that ships the markdown
// parser (mdast-util-from-markdown) plus src/escape.mjs, registered as a
// package-local client chunk for the dsh-client-modules module loader.
//
// Usage (from this package's root, with the devDependencies installed):
//
//   npm install --no-save --no-package-lock
//   node scripts/build-parser.mjs
//
// The output is deterministic for a fixed dependency version (no
// timestamps), so the committed artifact and a rebuild are byte-comparable.
// test/chunk.test.mjs pins the embedded escape source and the parser-version
// banner on a bare clone, where no rebuild is possible.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRoot = createRequire(join(root, "package.json"));

// Read the installed parser version from its manifest (resolve the entry and
// read package.json next to it, so an `exports` field cannot block the read).
const parserEntry = requireFromRoot.resolve("mdast-util-from-markdown");
const parserVersion = JSON.parse(readFileSync(join(dirname(parserEntry), "package.json"), "utf8")).version;

const escapeSourceRaw = readFileSync(join(root, "src/escape.mjs"), "utf8");
if ((escapeSourceRaw.match(/^export /gm) ?? []).length !== 1 || !/^export function makeEscapeDollars/m.test(escapeSourceRaw)) {
	throw new Error("build-parser: src/escape.mjs must export exactly one function, makeEscapeDollars");
}
if (/^\s*import /m.test(escapeSourceRaw)) {
	throw new Error("build-parser: src/escape.mjs must stay import-free (it is embedded verbatim into a classic script)");
}

// 1. Bundle the parser: one named global, nothing else leaks out.
const { outputFiles } = await build({
	stdin: {
		contents: 'import { fromMarkdown } from "mdast-util-from-markdown";\nexport { fromMarkdown };\n',
		resolveDir: root,
		loader: "js"
	},
	bundle: true,
	minify: true,
	format: "iife",
	globalName: "DSH_MATH_LITERAL_PARSER",
	target: "es2019",
	platform: "browser",
	write: false
});
const parserBundle = outputFiles[0].text;

// 2. The escape source, minus its one ESM export keyword.
const escapeSource = escapeSourceRaw.replace(/^export function/m, "function");

// 3. Compose the chunk: banner, parser, escape, chunk registration.
const out = [
	"/* dsh-math-literal: src/client.parser.js — GENERATED FILE, do not edit by hand.",
	"   Rebuild: node scripts/build-parser.mjs   (from this package's root, devDependencies installed)",
	`   Bundles: mdast-util-from-markdown ${parserVersion} (MIT) — a commonmark-only`,
	"            fromMarkdown, used to locate code regions before escaping lone dollars.",
	"   Embeds:  src/escape.mjs verbatim (minus its one ESM export keyword).",
	'   Register: a package-local client chunk (id "dsh-math-literal", chunk',
	'            "client.parser.js") for the dsh-client-modules module loader; the',
	"            on-demand route serves this file from the package directory. */",
	"",
	parserBundle,
	"",
	escapeSource,
	"",
	"window.__ModuleLoader__.load({",
	'\tid: "dsh-math-literal",',
	'\tchunk: "client.parser.js",',
	"\tfactory: function () {",
	"\t\treturn { escapeDollars: makeEscapeDollars(DSH_MATH_LITERAL_PARSER.fromMarkdown) };",
	"\t}",
	"});"
].join("\n") + "\n";

writeFileSync(join(root, "src/client.parser.js"), out);
console.log(`build-parser: wrote src/client.parser.js (${out.length} bytes, mdast-util-from-markdown ${parserVersion})`);
