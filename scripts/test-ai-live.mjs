/**
 * Opt-in integration: one real recognition (local codex) and one real
 * OpenAI-compatible image API call; consumes Codex usage and image quota.
 * Set HOME3D_AI_BASEURL / HOME3D_AI_APIKEY (HOME3D_AI_MODEL defaults to
 * gpt-image-1) before running with --run.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aiApi } from './ai-api.mjs'
import { CODEX_MODEL } from './ai-config.mjs'
import { appUrl, launchBrowser, preparePage } from './lib/browser.mjs'

if (!process.argv.includes('--run')) {
  throw new Error('Opt-in only: add --run to use real recognition/image generation. Start npm run dev first.')
}
const httpConfig = {
  baseUrl: process.env.HOME3D_AI_BASEURL,
  apiKey: process.env.HOME3D_AI_APIKEY,
  model: process.env.HOME3D_AI_MODEL || 'gpt-image-1',
}
if (!httpConfig.baseUrl || !httpConfig.apiKey) {
  throw new Error('Set HOME3D_AI_BASEURL and HOME3D_AI_APIKEY (OpenAI-compatible image API; HOME3D_AI_MODEL defaults to gpt-image-1).')
}
const artifacts = mkdtempSync(join(tmpdir(), 'home3d-ai-live-'))
const renderOnly = process.argv.includes('--render-only')
let middleware
aiApi().configureServer({ middlewares: { use(handler) { middleware = handler } } })
const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end() }))
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api/ai`
let browser
async function request(endpoint, body) {
  const res = await fetch(`${base}/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await res.json()
  assert.equal(result.ok, true, `${endpoint}: ${result.error ?? res.status}`)
  return result
}
try {
  let recognized
  if (!renderOnly) {
    const status = await fetch(`${base}/status`).then(res => res.json())
    assert.equal(status.codex.available, true, status.codex.reason)
    assert.equal(status.codexModel, CODEX_MODEL)
    const image = `data:image/png;base64,${readFileSync(new URL('./fixtures/plan-synthetic.png', import.meta.url)).toString('base64')}`
    console.log(`Recognizing synthetic floor plan with ${CODEX_MODEL}…`)
    recognized = await request('understand', { image })
    assert.equal(recognized.codexModel, CODEX_MODEL)
    assert.ok(recognized.plan.rooms.length > 0)
    assert.ok(recognized.plan.overall.widthM > 0 && recognized.plan.overall.depthM > 0)
    writeFileSync(join(artifacts, 'recognized.json'), JSON.stringify(recognized, null, 2))
    console.log(`Recognition OK: ${recognized.plan.rooms.length} rooms, ${recognized.durationMs} ms`)
  }

  // Fresh browser storage and default built-in scene: never use the user's saved project.
  browser = await launchBrowser()
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 960 })
  const errors = await preparePage(page) // The app itself still uses mocked AI routes.
  await page.goto(appUrl(), { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => window.__three && !document.querySelector('.loading-veil'), { timeout: 15000 })
  // Capture the real UI request so this test uses production framing/cropping/prompt logic.
  await page.click('.ai-btn')
  await page.evaluate(() => {
    const input = document.querySelector('.ai-panel input[type="password"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'live-placeholder')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForFunction(() => document.querySelector('.ai-panel .btn-primary')?.disabled === false)
  const pendingInput = page.waitForRequest(request => new URL(request.url()).pathname === '/api/ai/render', { timeout: 30000 })
  await page.click('.ai-panel .btn-primary')
  const renderInput = JSON.parse((await pendingInput).postData())
  assert.deepEqual(errors, [])
  await browser.close(); browser = null
  writeFileSync(join(artifacts, 'render-input.png'), Buffer.from(renderInput.image.split(',')[1], 'base64'))
  console.log(`Rendering one room preview with ${httpConfig.model} → ${httpConfig.baseUrl}/images/edits…`)
  const rendered = await request('render', { ...renderInput, ...httpConfig })
  assert.equal(rendered.model, httpConfig.model)
  assert.ok(rendered.image.startsWith('data:image/'))
  writeFileSync(join(artifacts, 'render-output.png'), Buffer.from(rendered.image.split(',')[1], 'base64'))
  const summary = {
    imageModel: httpConfig.model, baseUrl: httpConfig.baseUrl, codexModel: CODEX_MODEL,
    recognitionMs: recognized?.durationMs, renderMs: rendered.durationMs, rooms: recognized?.plan.rooms.length,
  }
  writeFileSync(join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log('Live AI OK:', JSON.stringify(summary), '\nArtifacts:', artifacts)
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
