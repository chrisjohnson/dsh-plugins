// Evaluate pure helpers straight out of the browser half.
//
// src/client.mjs is one self-contained classic-script factory with no imports,
// so its helpers cannot be `import`ed. The pure ones - no DOM, no React, no RPC -
// are sliced out of the source by name and evaluated, which tests the code the
// browser actually runs rather than a copy of it.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const CLIENT_PATH = fileURLToPath(new URL('../src/client.mjs', import.meta.url))

export async function clientSource() {
  return readFile(CLIENT_PATH, 'utf8')
}

/** The source text of one top-level function of the factory, braces balanced. */
export function sliceFunction(src, name) {
  const marker = `\t\tfunction ${name}(`
  const start = src.indexOf(marker)
  if (start < 0) throw new Error(`client.mjs has no function ${name}`)
  const end = src.indexOf('\n\t\t}\n', start)
  if (end < 0) throw new Error(`could not find the end of ${name}`)
  return src.slice(start, end + 4)
}

/**
 * Evaluate the named helpers together (so they can call each other) with the
 * given globals in scope, and return them by name.
 */
export async function loadClientHelpers(names, scope = {}) {
  const src = await clientSource()
  const body = names.map((name) => sliceFunction(src, name)).join('\n')
  const keys = Object.keys(scope)
  const make = new Function(...keys, `${body}\nreturn { ${names.join(', ')} };`)
  return make(...keys.map((key) => scope[key]))
}
