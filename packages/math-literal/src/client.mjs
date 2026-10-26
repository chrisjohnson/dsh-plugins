// dsh-math-literal: Client half (browser).
//
// The whole browser half is one global: globalThis.__DSH_MATH_LITERAL_ESCAPE__,
// the render-time escape the Host half's head-script wrapper (src/wrapper.mjs)
// looks up before handing text to MarkdownText. The escape and its commonmark
// parser live in the package-local chunk src/client.parser.js (a generated
// artifact — scripts/build-parser.mjs rebuilds it), loaded here at boot.
//
// `dsh.client.immediately: true` puts this entry in the shell's immediate
// prefetch tier, so the chunk is fetched during boot, before the application
// entries render.
//
// No slots, no styles, no hooks: there is no UI to register. If the chunk
// fails to load the global stays unset and the wrapper renders the original
// text — the page degrades to the pre-plugin behavior, nothing else.

window.__ModuleLoader__.load({
	id: "dsh-math-literal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		require.async("./client.parser.js").then(function (chunk) {
			if (chunk !== null && typeof chunk === "object" && typeof chunk.escapeDollars === "function") {
				globalThis.__DSH_MATH_LITERAL_ESCAPE__ = chunk.escapeDollars;
			} else {
				console.warn("dsh-math-literal: parser chunk did not export escapeDollars; escaping stays off");
			}
		}, function (error) {
			console.warn("dsh-math-literal: parser chunk failed to load; escaping stays off", error);
		});

		function apply() {
			// Nothing to register: the escape global above is the client half.
		}

		exports.apply = apply;
		return module.exports;
	}
});
