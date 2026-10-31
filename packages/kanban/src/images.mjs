// dsh-kanban: ticket body images — every decision in one pure module.
//
// A ticket body is markdown text. Images ride inside it as markdown links
// whose target is a durable attachment reference:
//
//     ![screenshot](kanban-image:sha256:<64 hex>)
//
// The bytes live in DSH core's content-addressed attachment store
// (`ctx.attachments`): `$DSH_HOME/attachments/v1/objects/xx/<sha256>`, on disk,
// validated, deduped, persisted across restarts. The body stays the single
// source of truth — no new table, no migration.
//
// While a draft is being written in the browser the reference cannot carry a
// real id yet, so it carries a client-minted token:
//
//     ![screenshot](kanban-image:pending-a1b2c3)
//
// On save the Host stores each image, rewrites every pending token to the
// attachment id it produced, and only then writes the body. A pending token
// with no matching upload — or a malformed ref — rejects the whole write: no
// ticket is created and no patch is applied with a dangling ref inside.
//
// This file imports nothing from `@deepseek-ai/*`: the byte work is handed a
// duck-typed `attachments` service (only `saveImage`/`imageHostPath` are
// called), so every branch here is testable with a stub.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const REF_PREFIX = 'kanban-image:';
export const PENDING_PREFIX = 'pending-';
export const MAX_IMAGES_PER_TICKET = 10;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const ALLOWED_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** A durable attachment id as the local store brands it: `sha256:<64 hex>`. */
const ATTACHMENT_ID_RE = /^sha256:[0-9a-f]{64}$/;
/** A client-minted pending token: `pending-` plus a short url-safe slug. */
const TOKEN_RE = /^pending-[A-Za-z0-9_-]{1,64}$/;
/** One markdown image ref: ![alt](kanban-image:<target>), whitespace tolerated. */
const REF_RE = /!\[([^\]\n]*)\]\(\s*kanban-image:([^\s)]+)\s*\)/g;

export function isAttachmentId(value) {
  return typeof value === 'string' && ATTACHMENT_ID_RE.test(value);
}

export function isPendingToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/** The markdown text one image ref occupies. */
export function refText(name, target) {
  const clean = String(name ?? '')
    .replace(/[\]\n\r]/g, ' ')
    .trim()
    .slice(0, 120);
  return `![${clean === '' ? 'image' : clean}](${REF_PREFIX}${target})`;
}

/**
 * Every ref in body order, each as { target, name, attachmentId, pending }.
 * `attachmentId` is set only for well-formed durable ids; `pending` only for
 * well-formed client tokens. Anything else is an invalid ref, reported as-is.
 */
export function refsFromBody(body) {
  const text = typeof body === 'string' ? body : '';
  const out = [];
  for (const match of text.matchAll(REF_RE)) {
    const [, name, target] = match;
    out.push({
      target,
      name,
      attachmentId: isAttachmentId(target) ? target : null,
      pending: isPendingToken(target) ? target.slice(PENDING_PREFIX.length) : null,
    });
  }
  return out;
}

/**
 * The durable attachment ids referenced by the body, in order, unique.
 * Pending tokens and malformed targets are not attachment ids and never appear.
 */
export function listRefs(body) {
  const seen = new Set();
  const ids = [];
  for (const ref of refsFromBody(body)) {
    if (ref.attachmentId === null || seen.has(ref.attachmentId)) continue;
    seen.add(ref.attachmentId);
    ids.push(ref.attachmentId);
  }
  return ids;
}

/** The pending client tokens referenced by the body, in order, unique. */
export function listTokens(body) {
  const seen = new Set();
  const tokens = [];
  for (const ref of refsFromBody(body)) {
    if (ref.pending === null || seen.has(ref.pending)) continue;
    seen.add(ref.pending);
    tokens.push(ref.pending);
  }
  return tokens;
}

/**
 * How many distinct images the body references, pending or durable. This is
 * what the per-ticket cap counts; a repeated ref to one image counts once.
 */
export function countRefs(body) {
  const seen = new Set();
  for (const ref of refsFromBody(body)) {
    if (ref.attachmentId !== null) seen.add(ref.attachmentId);
    else if (ref.pending !== null) seen.add(ref.pending);
  }
  return seen.size;
}

/**
 * Insert one image ref at `cursor` (a selection index in `body`), on its own
 * line-block: blank-line separated from prose so the markdown renderer and the
 * remove path both see a clean standalone ref.
 */
export function insertRef(body, cursor, token, name = 'image') {
  const text = typeof body === 'string' ? body : '';
  const at = Math.max(0, Math.min(Number.isFinite(cursor) ? Math.trunc(cursor) : text.length, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const ref = refText(name, `${PENDING_PREFIX}${token}`);
  const lead = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = after === '' ? '\n' : after.startsWith('\n') ? '\n' : '\n\n';
  return before + lead + ref + tail + after;
}

/**
 * Remove every ref for one image from the body, collapsing the blank line the
 * insert path added around it. `token` is a bare pending token (`t1`), a full
 * pending target (`pending-t1`), or a durable attachment id.
 */
export function removeRef(body, token) {
  const text = typeof body === 'string' ? body : '';
  let target = String(token ?? '');
  if (target === '') return text;
  if (!target.startsWith(PENDING_PREFIX) && !isAttachmentId(target)) target = `${PENDING_PREFIX}${target}`;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const one = new RegExp(`(?:\\n\\n|\\n)?!\\[[^\\]\\n]*\\]\\(\\s*${escape(REF_PREFIX)}${escape(target)}\\s*\\)(?:\\n\\n|\\n)?`, 'g');
  return text.replace(one, '\n\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * Client-side gate for one picked/pasted/dropped image, before any upload:
 * media type in the allow list, byte size within the cap, and the ticket not
 * already at MAX_IMAGES_PER_TICKET. `bytes` is a byte length or a Uint8Array.
 */
export function validateDraft({ mediaType, bytes, body = '' }, limit = MAX_IMAGES_PER_TICKET) {
  const size = bytes instanceof Uint8Array ? bytes.byteLength : Number(bytes);
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    return { ok: false, error: `unsupported image type ${mediaType ?? '(none)'}; allowed: ${ALLOWED_MEDIA_TYPES.join(', ')}` };
  }
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'image is empty' };
  if (size > MAX_IMAGE_BYTES) {
    return { ok: false, error: `image is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
  }
  if (countRefs(body) >= limit) {
    return { ok: false, error: `a ticket carries at most ${limit} images` };
  }
  return { ok: true };
}

/**
 * Rewrite every `pending-<token>` ref in the body to the durable attachment id
 * the Host stored for that token. `saved` is a Map or an array of
 * { token, attachmentId }.
 *
 * Strict by design: a pending token with no saved entry, and any ref target
 * that is neither a pending token nor a well-formed attachment id, rejects the
 * whole body — the caller must not persist a body with a dangling ref.
 */
export function resolveTokens(body, saved) {
  const text = typeof body === 'string' ? body : '';
  const map = saved instanceof Map ? saved : new Map((Array.isArray(saved) ? saved : []).map((entry) => [entry.token, entry.attachmentId]));
  let error = null;
  const rewritten = text.replace(REF_RE, (whole, name, target) => {
    if (error !== null) return whole;
    if (isAttachmentId(target)) return whole;
    if (isPendingToken(target)) {
      const id = map.get(target.slice(PENDING_PREFIX.length));
      if (id === undefined || id === null) {
        error = `image reference "${target}" has no uploaded image`;
        return whole;
      }
      if (!isAttachmentId(id)) {
        error = `uploaded image id "${id}" is malformed`;
        return whole;
      }
      return refText(name, id);
    }
    error = `image reference "${target}" is neither a pending upload nor a valid attachment id`;
    return whole;
  });
  if (error !== null) return { ok: false, error };
  return { ok: true, body: rewritten };
}

/**
 * Store every uploaded image and resolve the body in one step: decode each
 * base64 payload, gate it through validateDraft, hand the bytes to the
 * attachment service's `saveImage`, then rewrite the pending refs. On any
 * failure nothing has been written to the ticket — the caller creates no
 * ticket and applies no patch.
 *
 * `attachments` is the duck-typed store (`ctx.attachments`): only
 * `saveImage({ data, mediaType, name })` is called, returning a ref whose
 * `attachmentId` is the durable id.
 */
export async function prepareBodyImages({ body, images, attachments, limit = MAX_IMAGES_PER_TICKET }) {
  const text = typeof body === 'string' ? body : '';
  const list = Array.isArray(images) ? images : [];
  if (countRefs(text) > limit) {
    return { ok: false, error: `a ticket carries at most ${limit} images` };
  }
  const saved = [];
  for (const image of list) {
    const token = typeof image?.token === 'string' ? image.token : '';
    if (!isPendingToken(`${PENDING_PREFIX}${token}`)) {
      return { ok: false, error: `image upload has a malformed token ${JSON.stringify(token)}` };
    }
    const mediaType = typeof image.mediaType === 'string' ? image.mediaType : '';
    if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
      return { ok: false, error: `unsupported image type ${mediaType || '(none)'}; allowed: ${ALLOWED_MEDIA_TYPES.join(', ')}` };
    }
    const data = decodeBase64(image.data);
    if (data === null) return { ok: false, error: `image "${token}" is not valid base64` };
    const draft = validateDraft({ mediaType, bytes: data, body: '' });
    if (!draft.ok) return { ok: false, error: draft.error };
    let ref;
    try {
      ref = await attachments.saveImage({
        data,
        mediaType,
        name: typeof image.name === 'string' && image.name.trim() !== '' ? image.name.trim() : `${token}.img`,
      });
    } catch (error) {
      return { ok: false, error: `image "${token}" could not be stored: ${error && error.message ? error.message : String(error)}` };
    }
    const attachmentId = ref && typeof ref.attachmentId === 'string' ? ref.attachmentId : '';
    if (!isAttachmentId(attachmentId)) return { ok: false, error: `image store returned a malformed id ${JSON.stringify(attachmentId)}` };
    saved.push({ token, attachmentId });
  }
  const resolved = resolveTokens(text, saved);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (countRefs(resolved.body) > limit) {
    return { ok: false, error: `a ticket carries at most ${limit} images` };
  }
  return { ok: true, body: resolved.body, saved };
}

/**
 * Decode canonical base64 strictly: whitespace is tolerated, anything else
 * that node's decoder would silently drop or substitute is rejected by
 * re-encoding and comparing.
 */
export function decodeBase64(value) {
  if (typeof value !== 'string' || value === '') return null;
  const clean = value.replace(/\s/g, '');
  let bytes;
  try {
    bytes = new Uint8Array(Buffer.from(clean, 'base64'));
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;
  if (Buffer.from(bytes).toString('base64') !== clean) return null;
  return bytes;
}

/**
 * Read intrinsic media type and dimensions from encoded bytes, for the
 * readImage endpoint. Pure header parsing — png, jpeg, gif and webp only, the
 * formats the attachment store admits. Returns null when nothing is proven.
 */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : null;
  if (b === null || b.byteLength < 12) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (at, n) => String.fromCharCode(...b.subarray(at, at + n));
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') {
    return { mediaType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (ascii(0, 4) === 'GIF8') {
    return { mediaType: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 9 < b.byteLength) {
      if (b[at] !== 0xff) { at += 1; continue; }
      const marker = b[at + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { mediaType: 'image/jpeg', width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + view.getUint16(at + 2);
    }
    return { mediaType: 'image/jpeg', width: 0, height: 0 };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const tag = ascii(12, 4);
    if (tag === 'VP8X' && b.byteLength >= 30) {
      return {
        mediaType: 'image/webp',
        width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      };
    }
    if (tag === 'VP8 ' && b.byteLength >= 30) {
      return { mediaType: 'image/webp', width: view.getUint16(26) & 0x3fff, height: view.getUint16(28) & 0x3fff };
    }
    if (tag === 'VP8L' && b.byteLength >= 25) {
      const bits = b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24);
      return { mediaType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mediaType: 'image/webp', width: 0, height: 0 };
  }
  return null;
}

/**
 * Read one stored image back for the browser, through the attachment store's
 * host-file view: `imageHostPath` locates the content-addressed object, the
 * bytes are re-digested and must match the id they are read under — the same
 * integrity guarantee `readImage` gives, without needing the full reference
 * facts (bytes/width/height) that a body ref deliberately does not carry.
 *
 * Returns { ok: true, value: { base64, mediaType, width, height, hostPath } }
 * or { ok: false, code, error }.
 */
export async function readImageFromStore(attachments, attachmentId) {
  if (!isAttachmentId(attachmentId)) {
    return { ok: false, code: 'bad_request', error: 'attachmentId must be sha256:<64 hex>' };
  }
  if (attachments === undefined || attachments === null || typeof attachments.imageHostPath !== 'function') {
    return { ok: false, code: 'unavailable', error: 'the attachment store is not available' };
  }
  let hostPath;
  try {
    hostPath = attachments.imageHostPath({ attachmentId });
  } catch (error) {
    return { ok: false, code: 'bad_request', error: error && error.message ? error.message : String(error) };
  }
  if (typeof hostPath !== 'string' || hostPath === '') {
    return { ok: false, code: 'unavailable', error: 'this attachment backend exposes no host files' };
  }
  let bytes;
  try {
    bytes = await readFile(hostPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, code: 'not_found', error: 'image bytes are no longer in the store' };
    return { ok: false, code: 'internal', error: error && error.message ? error.message : String(error) };
  }
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== attachmentId) {
    return { ok: false, code: 'internal', error: 'stored bytes do not match the attachment id' };
  }
  const sniffed = sniffImage(bytes);
  return {
    ok: true,
    value: {
      base64: bytes.toString('base64'),
      mediaType: sniffed === null ? null : sniffed.mediaType,
      width: sniffed === null ? 0 : sniffed.width,
      height: sniffed === null ? 0 : sniffed.height,
      hostPath,
    },
  };
}

/**
 * The detail-view image list: one entry per distinct durable ref in the body,
 * in order, each { attachmentId, name, available }. `available` is a cheap
 * existence check on the content-addressed object — a ref whose bytes no
 * longer resolve stays in the list marked unavailable, so the client renders
 * it as broken instead of silently dropping the human's reference.
 */
export function describeBodyImages(attachments, body) {
  const out = [];
  const seen = new Set();
  for (const ref of refsFromBody(body)) {
    if (ref.attachmentId === null || seen.has(ref.attachmentId)) continue;
    seen.add(ref.attachmentId);
    let available = false;
    try {
      const hostPath = attachments?.imageHostPath?.({ attachmentId: ref.attachmentId });
      available = typeof hostPath === 'string' && hostPath !== '' && existsSync(hostPath);
    } catch {
      available = false;
    }
    out.push({ attachmentId: ref.attachmentId, name: ref.name === '' ? null : ref.name, available });
  }
  return out;
}
