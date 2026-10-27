// Shared test helper: a minimal commonmark-flavoured stub parser, good enough
// for the escape-PASS unit tests. It recognises fenced blocks (``` … ```) and
// inline code spans (backtick pairs) with 1-based mdast positions. The real
// parser's behaviour is covered by test/chunk.test.mjs, which runs the
// committed chunk's bundled mdast-util-from-markdown.

export function stubFromMarkdown(text) {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
	}
	const toPos = (abs) => {
		let line = 0;
		while (line < lineStarts.length - 1 && lineStarts[line + 1] <= abs) line += 1;
		return { line: line + 1, column: abs - lineStarts[line] + 1 };
	};
	const children = [];
	let i = 0;
	while (i < text.length) {
		const atLineStart = i === 0 || text[i - 1] === "\n";
		if (atLineStart && text.startsWith("```", i)) {
			const close = text.indexOf("\n```", i + 3);
			const end = close === -1 ? text.length : close + 4;
			children.push({ type: "code", position: { start: toPos(i), end: toPos(end) } });
			i = end;
			continue;
		}
		if (text[i] === "`") {
			const close = text.indexOf("`", i + 1);
			const end = close === -1 ? text.length : close + 1;
			children.push({ type: "inlineCode", position: { start: toPos(i), end: toPos(end) } });
			i = end;
			continue;
		}
		i += 1;
	}
	return { type: "root", children };
}
