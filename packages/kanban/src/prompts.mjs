// dsh-kanban: prompt loading, hashing and rendering.
//
// Prompt bodies are phase user messages. The system prompt comes from the
// standard preset and is never replaced by this plugin.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ConfigError, DEFAULT_PROMPTS } from './config.mjs';

export function hashText(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function shortHash(hash) {
  return String(hash).slice(0, 12);
}

/** Replace `{{key}}` placeholders; absent values become empty, never "undefined". */
export function render(template, vars = {}) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = vars[key];
    if (value === undefined || value === null) return '';
    return Array.isArray(value) ? value.join('\n') : String(value);
  });
}

/** Load every phase prompt from disk and hash it. */
export async function loadPrompts(config, packageDir) {
  const dir = config.promptsDir ?? join(packageDir, 'prompts');
  const bodies = {};
  const hashes = {};
  const sources = {};
  for (const [name, file] of Object.entries(DEFAULT_PROMPTS)) {
    const path = join(dir, file);
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      throw new ConfigError(`cannot read ${name} prompt at ${path}: ${error.message}`);
    }
    bodies[name] = text;
    hashes[name] = hashText(text);
    sources[name] = 'file';
  }
  return { dir, bodies, hashes, sources };
}

export function doneWhenBlock(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return '(none)';
  return conditions
    .map((c) => `- id: ${c.id}\n  statement: ${c.statement}\n  how_verified: ${c.howVerified}`)
    .join('\n');
}

export function acceptanceBlock(acceptance) {
  if (!Array.isArray(acceptance) || acceptance.length === 0) return '(the human wrote no acceptance statements)';
  return acceptance.map((a) => `- [${a.source}] ${a.statement}`).join('\n');
}
