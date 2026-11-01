import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ALLOWED_MEDIA_TYPES,
  MAX_IMAGES_PER_TICKET,
  REF_PREFIX,
  countRefs,
  decodeBase64,
  describeBodyImages,
  insertRef,
  isAttachmentId,
  listRefs,
  listTokens,
  prepareBodyImages,
  readImageFromStore,
  refText,
  removeRef,
  resolveTokens,
  refsFromBody,
  sniffImage,
  validateDraft,
} from '../src/images.mjs'

const ID_A = `sha256:${'a'.repeat(64)}`
const ID_B = `sha256:${'b'.repeat(64)}`
const ID_C = `sha256:${'c'.repeat(64)}`

// A real 1x1 PNG, so sniffImage tests parse genuine headers.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// ------------------------------------------------------------------ refs

test('REF_PREFIX is the documented scheme', () => {
  assert.equal(REF_PREFIX, 'kanban-image:')
})

test('isAttachmentId accepts only sha256:<64 hex>', () => {
  assert.equal(isAttachmentId(ID_A), true)
  assert.equal(isAttachmentId('sha256:abc'), false)
  assert.equal(isAttachmentId('a'.repeat(64)), false)
  assert.equal(isAttachmentId(`sha256:${'g'.repeat(64)}`), false)
  assert.equal(isAttachmentId(`sha256:${'A'.repeat(64)}`), false)
  assert.equal(isAttachmentId(undefined), false)
})

test('refText sanitizes the alt text and falls back to "image"', () => {
  assert.equal(refText('shot.png', ID_A), `![shot.png](kanban-image:${ID_A})`)
  assert.equal(refText('a]b\nc', ID_A), '![a b c](kanban-image:' + ID_A + ')')
  assert.equal(refText('', ID_A), `![image](kanban-image:${ID_A})`)
  assert.equal(refText(undefined, ID_A), `![image](kanban-image:${ID_A})`)
})

test('refsFromBody reads every ref in order with its name', () => {
  const body = `Intro\n\n![one](${REF_PREFIX}${ID_A})\n\nmiddle ![two](${REF_PREFIX}pending-t1) tail`
  const refs = refsFromBody(body)
  assert.equal(refs.length, 2)
  assert.deepEqual(refs[0], { target: ID_A, name: 'one', attachmentId: ID_A, pending: null })
  assert.deepEqual(refs[1], { target: 'pending-t1', name: 'two', attachmentId: null, pending: 't1' })
})

test('listRefs returns ordered unique attachment ids and skips pending tokens', () => {
  const body = `![a](${REF_PREFIX}${ID_B}) ![x](${REF_PREFIX}pending-t1) ![b](${REF_PREFIX}${ID_A}) ![dup](${REF_PREFIX}${ID_B})`
  assert.deepEqual(listRefs(body), [ID_B, ID_A])
  assert.deepEqual(listTokens(body), ['t1'])
  assert.deepEqual(listRefs('no images here'), [])
})

test('countRefs counts distinct images once, pending or durable', () => {
  const body = `![a](${REF_PREFIX}${ID_A})![again](${REF_PREFIX}${ID_A})![p](${REF_PREFIX}pending-t1)![p2](${REF_PREFIX}pending-t1)`
  assert.equal(countRefs(body), 2)
  assert.equal(countRefs(''), 0)
})

// -------------------------------------------------------- insert / remove

test('insertRef puts a pending ref at the cursor, blank-line separated', () => {
  assert.equal(insertRef('', 0, 't1', 'shot.png'), '![shot.png](kanban-image:pending-t1)\n')
  const body = 'hello world'
  assert.equal(insertRef(body, 5, 't1', 's'), 'hello\n\n![s](kanban-image:pending-t1)\n\n world')
  assert.equal(insertRef('line\n', 5, 't1', 's'), 'line\n\n![s](kanban-image:pending-t1)\n')
  // Cursor clamps into range.
  assert.equal(insertRef('ab', 99, 't1', 's'), 'ab\n\n![s](kanban-image:pending-t1)\n')
  assert.equal(insertRef('ab', -3, 't1', 's'), '![s](kanban-image:pending-t1)\n\nab')
})

test('removeRef takes out the ref and the blank line the insert added', () => {
  assert.equal(removeRef(`a\n\n![s](${REF_PREFIX}pending-t1)\n\nb`, 'pending-t1'), 'a\n\nb')
  // Bare token and durable id both work.
  assert.equal(removeRef(`a\n\n![s](${REF_PREFIX}pending-t1)\n\nb`, 't1'), 'a\n\nb')
  assert.equal(removeRef(`a\n\n![s](${REF_PREFIX}${ID_A})\n\nb`, ID_A), 'a\n\nb')
  // Unknown token: untouched.
  assert.equal(removeRef('plain text', 'pending-z'), 'plain text')
  // Insert then remove leaves the prose with a paragraph break where the
  // ref block stood.
  assert.equal(removeRef(insertRef('hello world', 5, 'tk9', 'x.png'), 'pending-tk9').trim(), 'hello\n\n world')
})

// ------------------------------------------------------------ resolveTokens

test('resolveTokens rewrites pending refs to durable ids', () => {
  const body = `Intro\n\n![s](${REF_PREFIX}pending-t1)\n\nmid ![d](${REF_PREFIX}${ID_A})`
  const out = resolveTokens(body, [{ token: 't1', attachmentId: ID_B }])
  assert.equal(out.ok, true)
  assert.equal(out.body, `Intro\n\n![s](${REF_PREFIX}${ID_B})\n\nmid ![d](${REF_PREFIX}${ID_A})`)
  assert.deepEqual(listRefs(out.body), [ID_B, ID_A])
})

test('resolveTokens accepts a Map as well as an array', () => {
  const body = `![s](${REF_PREFIX}pending-t1)`
  const out = resolveTokens(body, new Map([['t1', ID_B]]))
  assert.equal(out.ok, true)
  assert.match(out.body, new RegExp(ID_B))
})

test('resolveTokens rejects a pending token with no upload', () => {
  const out = resolveTokens(`![s](${REF_PREFIX}pending-missing)`, [{ token: 't1', attachmentId: ID_B }])
  assert.equal(out.ok, false)
  assert.match(out.error, /pending-missing/)
})

test('resolveTokens rejects a malformed ref target', () => {
  const out = resolveTokens(`![s](${REF_PREFIX}nonsense)`, [])
  assert.equal(out.ok, false)
  assert.match(out.error, /neither a pending upload nor a valid attachment id/)
})

test('resolveTokens rejects a saved id that is not a valid attachment id', () => {
  const out = resolveTokens(`![s](${REF_PREFIX}pending-t1)`, [{ token: 't1', attachmentId: 'oops' }])
  assert.equal(out.ok, false)
  assert.match(out.error, /is malformed/)
})

test('resolveTokens passes a body with no refs through untouched', () => {
  const out = resolveTokens('just prose', [])
  assert.equal(out.ok, true)
  assert.equal(out.body, 'just prose')
})

// ----------------------------------------------------------- validateDraft

test('validateDraft gates media type, size and the per-ticket cap', () => {
  assert.equal(validateDraft({ mediaType: 'image/png', bytes: 10 }).ok, true)
  assert.equal(validateDraft({ mediaType: 'image/bmp', bytes: 10 }).ok, false)
  assert.equal(validateDraft({ mediaType: undefined, bytes: 10 }).ok, false)
  assert.equal(validateDraft({ mediaType: 'image/png', bytes: 0 }).ok, false)
  assert.equal(validateDraft({ mediaType: 'image/png', bytes: 20 * 1024 * 1024 }).ok, true)
  assert.equal(validateDraft({ mediaType: 'image/png', bytes: 20 * 1024 * 1024 + 1 }).ok, false)
  // Uint8Array input is measured by byteLength.
  assert.equal(validateDraft({ mediaType: 'image/png', bytes: new Uint8Array(100) }).ok, true)
  assert.deepEqual([...ALLOWED_MEDIA_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
})

test('validateDraft refuses the eleventh image', () => {
  const body = Array.from({ length: MAX_IMAGES_PER_TICKET }, (_, i) => `![i${i}](${REF_PREFIX}pending-t${i})`).join('\n')
  assert.equal(countRefs(body), MAX_IMAGES_PER_TICKET)
  const out = validateDraft({ mediaType: 'image/png', bytes: 10, body })
  assert.equal(out.ok, false)
  assert.match(out.error, /at most 10 images/)
  // Nine refs still admit one more.
  const nine = body.split('\n').slice(0, 9).join('\n')
  assert.equal(validateDraft({ mediaType: 'image/png', bytes: 10, body: nine }).ok, true)
})

// ----------------------------------------------------------- decodeBase64

test('decodeBase64 is strict about canonical input', () => {
  assert.deepEqual([...decodeBase64(PNG_1PX.toString('base64'))], [...PNG_1PX])
  assert.equal(decodeBase64('not base64!!!'), null)
  assert.equal(decodeBase64(''), null)
  assert.equal(decodeBase64('###'), null)
  assert.equal(decodeBase64(null), null)
})

// -------------------------------------------------------------- sniffImage

test('sniffImage reads png/gif/webp/jpeg headers', () => {
  assert.deepEqual(sniffImage(PNG_1PX), { mediaType: 'image/png', width: 1, height: 1 })
  const gif = new Uint8Array(13)
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00])
  assert.deepEqual(sniffImage(gif), { mediaType: 'image/gif', width: 16, height: 32 })
  const webp = new Uint8Array(30)
  webp.set([0x52, 0x49, 0x46, 0x46])
  webp.set([0x57, 0x45, 0x42, 0x50], 8)
  webp.set([0x56, 0x50, 0x38, 0x58], 12)
  webp[24] = 39; webp[25] = 0; webp[26] = 0
  webp[27] = 19; webp[28] = 0; webp[29] = 0
  assert.deepEqual(sniffImage(webp), { mediaType: 'image/webp', width: 40, height: 20 })
  // A minimal JPEG: SOI, then an SOF0 with 8x4.
  const jpeg = new Uint8Array(20)
  jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x04, 0x00, 0x08])
  assert.deepEqual(sniffImage(jpeg), { mediaType: 'image/jpeg', width: 8, height: 4 })
  assert.equal(sniffImage(new Uint8Array([1, 2, 3])), null)
})

// ------------------------------------------------------- prepareBodyImages

function stubAttachments() {
  const saved = []
  return {
    saved,
    async saveImage(input) {
      saved.push(input)
      const digest = createHash('sha256').update(input.data).digest('hex')
      return { attachmentId: `sha256:${digest}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, name: input.name }
    },
  }
}

test('prepareBodyImages stores each upload and resolves the body in one step', async () => {
  const attachments = stubAttachments()
  const b64 = PNG_1PX.toString('base64')
  const body = `Look\n\n![shot.png](${REF_PREFIX}pending-t1)\n\nand ![dup](${REF_PREFIX}pending-t1)`
  const out = await prepareBodyImages({ body, images: [{ token: 't1', data: b64, mediaType: 'image/png', name: 'shot.png' }], attachments })
  assert.equal(out.ok, true)
  assert.equal(attachments.saved.length, 1)
  assert.deepEqual([...attachments.saved[0].data], [...PNG_1PX])
  assert.equal(out.saved.length, 1)
  const id = out.saved[0].attachmentId
  assert.equal(isAttachmentId(id), true)
  // Both refs for the same token resolve to the same durable id; no pending left.
  assert.deepEqual(listRefs(out.body), [id])
  assert.equal(out.body.includes('pending-'), false)
})

test('prepareBodyImages with no images still validates the body refs', async () => {
  const attachments = stubAttachments()
  const ok = await prepareBodyImages({ body: `![a](${REF_PREFIX}${ID_A})`, images: [], attachments })
  assert.equal(ok.ok, true)
  assert.equal(attachments.saved.length, 0)
  const bad = await prepareBodyImages({ body: `![a](${REF_PREFIX}pending-nope)`, images: [], attachments })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /no uploaded image/)
})

test('prepareBodyImages refuses an unresolvable token and stores nothing else into the body', async () => {
  const attachments = stubAttachments()
  const b64 = PNG_1PX.toString('base64')
  const out = await prepareBodyImages({
    body: `![good](${REF_PREFIX}pending-t1) ![ghost](${REF_PREFIX}pending-ghost)`,
    images: [{ token: 't1', data: b64, mediaType: 'image/png' }],
    attachments,
  })
  assert.equal(out.ok, false)
  assert.match(out.error, /pending-ghost/)
})

test('prepareBodyImages rejects bad media type, bad base64 and a bad token', async () => {
  const attachments = stubAttachments()
  const b64 = PNG_1PX.toString('base64')
  const badType = await prepareBodyImages({ body: '', images: [{ token: 't1', data: b64, mediaType: 'image/bmp' }], attachments })
  assert.equal(badType.ok, false)
  assert.match(badType.error, /unsupported image type/)
  const badB64 = await prepareBodyImages({ body: '', images: [{ token: 't1', data: '!!!', mediaType: 'image/png' }], attachments })
  assert.equal(badB64.ok, false)
  assert.match(badB64.error, /not valid base64/)
  const badToken = await prepareBodyImages({ body: '', images: [{ token: '', data: b64, mediaType: 'image/png' }], attachments })
  assert.equal(badToken.ok, false)
  assert.match(badToken.error, /malformed token/)
})

test('prepareBodyImages enforces the ten-image cap on the final body', async () => {
  const attachments = stubAttachments()
  const b64 = PNG_1PX.toString('base64')
  const images = Array.from({ length: 11 }, (_, i) => ({ token: `t${i}`, data: b64, mediaType: 'image/png' }))
  const body = images.map((image) => `![x](${REF_PREFIX}pending-${image.token})`).join('\n')
  const out = await prepareBodyImages({ body, images, attachments })
  assert.equal(out.ok, false)
  assert.match(out.error, /at most 10 images/)
})

test('prepareBodyImages surfaces a store failure as a rejection', async () => {
  const attachments = {
    async saveImage() {
      throw new Error('disk on fire')
    },
  }
  const b64 = PNG_1PX.toString('base64')
  const out = await prepareBodyImages({
    body: `![s](${REF_PREFIX}pending-t1)`,
    images: [{ token: 't1', data: b64, mediaType: 'image/png' }],
    attachments,
  })
  assert.equal(out.ok, false)
  assert.match(out.error, /disk on fire/)
})

// --------------------------------------------------- readImageFromStore

const REAL_PNG_ID = `sha256:${createHash('sha256').update(PNG_1PX).digest('hex')}`

function fileBackedAttachments(dir) {
  return {
    imageHostPath(ref) {
      if (!isAttachmentId(ref.attachmentId)) throw new Error('Attachment reference is invalid.')
      return join(dir, ref.attachmentId.slice(7))
    },
  }
}

test('readImageFromStore returns verified bytes for a stored image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-img-'))
  await writeFile(join(dir, REAL_PNG_ID.slice(7)), PNG_1PX)
  const out = await readImageFromStore(fileBackedAttachments(dir), REAL_PNG_ID)
  assert.equal(out.ok, true)
  assert.equal(out.value.base64, PNG_1PX.toString('base64'))
  assert.equal(out.value.mediaType, 'image/png')
  assert.deepEqual([out.value.width, out.value.height], [1, 1])
})

test('readImageFromStore rejects malformed ids, missing bytes and digest mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-img-'))
  assert.equal((await readImageFromStore(fileBackedAttachments(dir), 'bogus')).code, 'bad_request')
  assert.equal((await readImageFromStore(undefined, REAL_PNG_ID)).code, 'unavailable')
  assert.equal((await readImageFromStore(fileBackedAttachments(dir), REAL_PNG_ID)).code, 'not_found')
  await writeFile(join(dir, REAL_PNG_ID.slice(7)), Buffer.from('tampered bytes, wrong digest for this id'))
  assert.equal((await readImageFromStore(fileBackedAttachments(dir), REAL_PNG_ID)).code, 'internal')
})

// --------------------------------------------------- describeBodyImages

test('describeBodyImages lists distinct refs in order with availability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-img-'))
  await writeFile(join(dir, REAL_PNG_ID.slice(7)), PNG_1PX)
  const attachments = fileBackedAttachments(dir)
  const body = `![shot.png](${REF_PREFIX}${REAL_PNG_ID}) then ![gone](${REF_PREFIX}${ID_C}) then ![again](${REF_PREFIX}${REAL_PNG_ID})`
  const images = describeBodyImages(attachments, body)
  assert.deepEqual(images, [
    { attachmentId: REAL_PNG_ID, name: 'shot.png', available: true },
    { attachmentId: ID_C, name: 'gone', available: false },
  ])
  assert.deepEqual(describeBodyImages(attachments, 'no images'), [])
})
