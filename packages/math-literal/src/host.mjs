import { wrapperSource } from "./wrapper.mjs";

/**
 * Mount the render-time dollar guard on every index response.
 *
 * The pushed row (kind "script", placement "head") is spliced into
 * index.html right after the opening head tag by dsh-host-webserver, so the
 * wrapper runs before the shell's deferred module script and can intercept
 * window.__ModuleLoader__.create — see src/wrapper.mjs for what it does and
 * why it can never break boot.
 *
 * @param ctx - Host context serving browser pages.
 */
export function apply(ctx) {
	return ctx.on("webserver/index-inject", (table) => {
		table.push({ kind: "script", placement: "head", text: wrapperSource });
	});
}
