/**
 * Offline API regression: a fake codex CLI (recognition) plus a fake
 * OpenAI-compatible image API (render). No credentials or real AI calls.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = mkdtempSync(join(tmpdir(), 'home3d-ai-test-'))
const testHome = join(root, 'codex')
const mockBin = join(root, 'codex-mock')
writeFileSync(mockBin, `#!${process.execPath}\n${readFileSync(new URL('./fixtures/ai-mock-codex.mjs', import.meta.url), 'utf8')}`)
chmodSync(mockBin, 0o755)
// These overrides exist only in this test process and its mock children.
process.env.HOME3D_CODEX_BIN = mockBin
process.env.CODEX_HOME = testHome
process.env.HOME3D_AI_MOCK = root
configure()

const { aiApi } = await import('./ai-api.mjs')
let middleware
aiApi().configureServer({ middlewares: { use(handler) { middleware = handler } } })
const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api/ai`

// --- fake OpenAI-compatible image API --------------------------------------
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)])
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 2)])
let imageConfig = {}
const imageCalls = []
const imageApi = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const call = { url: req.url, auth: req.headers.authorization, socket: req.socket }
  imageCalls.push(call)
  try {
    if (req.url === '/v1/images/edits') {
      const form = await new Request('http://mock/', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] },
        body: Buffer.concat(chunks),
      }).formData()
      call.fields = {
        model: form.get('model'),
        size: form.get('size'),
        n: form.get('n'),
        prompt: form.get('prompt'),
      }
      call.images = form.getAll('image[]').map((file) => ({ name: file.name, type: file.type, size: file.size }))
    }
  } catch (error) {
    call.parseError = String(error)
  }
  if (req.url === '/img.png') {
    // url-mode download endpoint: raw image bytes
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(imageConfig.jpeg ? jpeg : png)
    return
  }
  if (imageConfig.delay) await delay(imageConfig.delay)
  if (imageConfig.status) {
    res.writeHead(imageConfig.status, { 'content-type': imageConfig.json ? 'application/json' : 'text/plain' })
    res.end(imageConfig.body ?? JSON.stringify({ error: { message: imageConfig.error ?? 'mock image failure' } }))
    return
  }
  if (imageConfig.url) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${imageApi.address().port}/img.png` }] }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data: [{ b64_json: (imageConfig.jpeg ? jpeg : png).toString('base64') }] }))
})
imageApi.listen(0, '127.0.0.1')
await once(imageApi, 'listening')
const httpConfig = { baseUrl: `http://127.0.0.1:${imageApi.address().port}/v1`, apiKey: 'test-key-1', model: 'gpt-image-1' }

const image = 'data:image/png;base64,iVBORw0KGgo='
const input = { image, prompt: 'Repaint this room', aspect: '3:2', ...httpConfig }
const events = () => readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)

function configure(config = {}) {
  writeFileSync(join(root, 'config.json'), JSON.stringify(config))
  writeFileSync(join(root, 'events.jsonl'), '')
}

function images(count) {
  return Array.from({ length: count }, () => image)
}

async function request(path, body = input) {
  const response = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, ...await response.json() }
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}`)
    await delay(20)
  }
}

async function assertSlotFree() {
  // The response can arrive just before the finally block releases the slot.
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await fetch(`${base}/status`).then((response) => response.json())
    if (!status.busy) break
    assert.ok(attempt < 99, 'slot was not released')
    await delay(20)
  }
  for (const event of events().filter((event) => event.type === 'exec')) assert.equal(existsSync(event.cwd), false, 'codex temp dir cleaned')
}

let checks = 0
try {
  // --- render: config validation -------------------------------------------
  for (const body of [
    { ...input, baseUrl: '', apiKey: '', model: '' },
    { ...input, apiKey: '' },
    { ...input, baseUrl: 'ftp://insecure' },
    { ...input, model: '' },
  ]) {
    const rejected = await request('render', body)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.ok, false)
    checks++
  }
  assert.equal(events().length, 0, 'renders must never invoke codex')

  // --- render works while the codex CLI is outdated or missing -------------
  configure({ version: '0.144.5' })
  const outdated = await fetch(`${base}/status`).then(response => response.json())
  assert.equal(outdated.codex.available, false)
  assert.match(outdated.codex.reason, /0\.153\.1/)
  const rejectedUnderstand = await request('understand', { image })
  assert.equal(rejectedUnderstand.ok, false)
  assert.match(rejectedUnderstand.error, /npm i -g @openai\/codex@latest/)
  const renderedAnyway = await request('render')
  assert.equal(renderedAnyway.ok, true, 'render does not depend on the codex CLI')
  assert.ok(events().every(event => event.type === 'version'), 'old CLI must not log in or exec')
  checks++

  configure({ version: '0.153.1' })
  const status = await fetch(`${base}/status`).then(response => response.json())
  assert.equal(status.codex.available, true)
  assert.equal(status.codexModel, 'gpt-6-astra')
  assert.equal(status.model, 'GPT-6 Astra')
  checks++
  configure()
  for (const body of [null, [], 42, 'text', {}, { image: 'not an image' }]) {
    const result = await request('understand', body)
    assert.equal(result.status, 400)
    assert.equal(result.ok, false)
    checks++
  }
  assert.equal(events().length, 0, 'invalid input must not invoke codex')

  // --- render: OpenAI images/edits call shape ------------------------------
  imageCalls.length = 0
  const ok = await request('render')
  assert.equal(ok.ok, true)
  assert.equal(ok.model, 'gpt-image-1', 'response echoes the configured model')
  assert.equal(ok.aspect, '3:2')
  assert.equal(ok.durationMs > 0, true)
  assert.ok(ok.image.startsWith('data:image/png;base64,iVBORw0KGgo'))
  assert.equal(imageCalls.length, 1)
  assert.equal(imageCalls[0].url, '/v1/images/edits')
  assert.equal(imageCalls[0].auth, 'Bearer test-key-1')
  assert.equal(imageCalls[0].fields.model, 'gpt-image-1')
  assert.equal(imageCalls[0].fields.size, '1536x1024')
  assert.equal(imageCalls[0].fields.n, '1')
  assert.match(imageCalls[0].fields.prompt, /Repaint this room/)
  assert.deepEqual(imageCalls[0].images.map(f => f.name), ['image-0.png'])
  assert.equal(imageCalls[0].images[0].type, 'image/png')
  checks++

  // custom model + aspect → size mapping, view + reference photos
  for (const [aspect, size] of [['1:1', '1024x1024'], ['2:3', '1024x1536'], ['9:16', '1536x1024']]) {
    const result = await request('render', { ...input, aspect, model: 'my-relay-image-model' })
    assert.equal(result.ok, true, aspect)
    assert.equal(result.model, 'my-relay-image-model')
    assert.equal(result.aspect, aspect === '9:16' ? '3:2' : aspect)
    const call = imageCalls.at(-1)
    assert.equal(call.fields.model, 'my-relay-image-model')
    assert.equal(call.fields.size, size)
    checks++
  }

  imageCalls.length = 0
  const withRefs = await request('render', { ...input, aspect: '1:1', images: images(7) })
  assert.equal(withRefs.ok, true)
  assert.equal(imageCalls[0].images.length, 6, 'first image (view) plus at most 5 references')
  assert.deepEqual(imageCalls[0].images.map(f => f.name), ['image-0.png', 'image-1.png', 'image-2.png', 'image-3.png', 'image-4.png', 'image-5.png'])
  checks++

  // providers answering with a URL instead of inline base64
  imageConfig = { url: true }
  const viaUrl = await request('render')
  assert.equal(viaUrl.ok, true)
  assert.ok(viaUrl.image.startsWith('data:image/png;base64,iVBORw0KGgo'), 'URL result is inlined')
  imageConfig = { url: true, jpeg: true }
  const viaJpegUrl = await request('render')
  assert.ok(viaJpegUrl.image.startsWith('data:image/jpeg;base64,/9j/'), 'jpeg magic sniffed from the download')
  imageConfig = {}
  checks++

  // upstream errors map to auth / error with the provider's message
  imageConfig = { status: 401, json: true, error: 'Incorrect API key provided' }
  assert.equal((await request('render')).code, 'auth')
  assert.match((await request('render')).error, /Incorrect API key provided/)
  imageConfig = { status: 500, json: true, error: 'provider exploded' }
  assert.equal((await request('render')).code, 'error')
  assert.match((await request('render')).error, /provider exploded/)
  imageConfig = { status: 502, json: false, body: 'Bad Gateway' }
  assert.match((await request('render')).error, /Bad Gateway/)
  imageConfig = { status: 200, json: true, body: JSON.stringify({ data: [] }) }
  assert.match((await request('render')).error, /no image in image API response/)
  imageConfig = {}
  checks++

  // --- render is independent of the understand single-flight slot ----------
  configure({ execDelay: 400 })
  const understanding = request('understand', { image })
  await waitFor(() => events().some((event) => event.type === 'exec'), 'understand subprocess')
  const concurrentRender = await request('render')
  assert.equal(concurrentRender.ok, true, 'render runs while a recognition task holds the codex slot')
  assert.equal((await understanding).ok, true)
  await assertSlotFree()
  checks++

  // --- render follows the client connection --------------------------------
  imageConfig = { delay: 60_000 }
  const ctrl = new AbortController()
  const pending = fetch(`${base}/render`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: ctrl.signal,
  })
  await waitFor(() => imageCalls.some((call) => call.url === '/v1/images/edits'), 'upstream render request')
  ctrl.abort()
  assert.equal((await pending.catch((error) => error.name)), 'AbortError')
  // keep-alive sockets stay pooled on success; only an abort destroys them
  await waitFor(() => imageCalls.some((call) => call.socket?.destroyed), 'upstream request cancelled with the client')
  imageConfig = {}
  assert.equal((await request('render')).ok, true, 'no state stuck after an aborted render')
  checks++

  // the render cancel escape hatch is gone with the codex render path
  assert.equal((await fetch(`${base}/render/cancel`, { method: 'POST' })).status, 404)
  checks++

  // --- understand: codex invocation shape -----------------------------------
  configure()
  const understood = await request('understand', { image })
  assert.equal(understood.ok, true)
  assert.equal(understood.plan.rooms[0].name, 'Living')
  assert.equal(understood.codexModel, 'gpt-6-astra')
  const understandArgs = events().find(event => event.type === 'exec').args
  assert.equal(understandArgs[understandArgs.indexOf('--model') + 1], 'gpt-6-astra')
  assert.ok(understandArgs.includes('model_reasoning_effort="medium"'))
  assert.equal(understandArgs[understandArgs.indexOf('-s') + 1], 'read-only')
  assert.ok(understandArgs.includes('--ephemeral') && understandArgs.includes('--output-schema'))
  await assertSlotFree()
  checks++

  // concurrent recognitions: exactly one may claim the slot
  configure({ loginBarrier: 2, execDelay: 200 })
  const concurrent = await Promise.all([request('understand', { image }), request('understand', { image })])
  assert.equal(concurrent.filter((result) => result.ok).length, 1)
  assert.equal(concurrent.filter((result) => result.code === 'busy').length, 1)
  await assertSlotFree()
  checks++

  // stuck recognition killed via the cancel escape hatch
  configure({ mode: 'hang' })
  const hung = request('understand', { image })
  await waitFor(() => events().some((event) => event.type === 'ready'), 'understand subprocess')
  assert.equal((await request('understand/cancel', {})).cancelled, true)
  assert.equal((await hung).code, 'cancelled')
  await assertSlotFree()
  assert.equal((await request('understand/cancel', {})).cancelled, false)
  await assertSlotFree()
  checks++

  // A cached successful status must never bypass a fresh task's compatibility check.
  configure({ version: '0.153.0' })
  assert.equal((await request('understand', { image })).ok, false)
  assert.ok(events().every(event => event.type === 'version'))
  checks++

  configure({ loginExit: 1 })
  assert.equal((await request('understand', { image })).code, 'auth')
  assert.equal(events().filter((event) => event.type === 'exec').length, 0)
  checks++

  console.log(`AI API: ${checks} offline checks passed (no real codex or image API calls).`)
} finally {
  server.closeAllConnections()
  imageApi.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => imageApi.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
