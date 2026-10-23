import { PLAN_SCHEMA, UNDERSTAND_PROMPT } from './plan-schema.mjs'
/**
 * Local AI API (dev-server middleware), two backends:
 * - understand (floor-plan recognition) runs the local codex CLI. No
 *   credentials are read by this script: codex authentication lives in
 *   $CODEX_HOME/auth.json and is managed by codex itself (`codex login`).
 * - render (3D view repaint) proxies one call to an OpenAI-compatible
 *   HTTP image API (POST {baseUrl}/images/edits). The client supplies
 *   baseUrl/apiKey/model per request; nothing is persisted here.
 *
 *   GET  /api/ai/status  → { ok, codex: { available, reason? }, busy, busySince, busyKind, model }
 *   POST /api/ai/understand  { image: dataURL }
 *                      → { ok, plan, durationMs, engine: 'codex' }
 *                      → { ok: false, code: 'auth'|'busy'|'cancelled'|'error', error, startedAt? }
 *   POST /api/ai/render  { prompt, image: dataURL, images?: dataURL[], aspect,
 *                          baseUrl, apiKey, model }
 *                      → { ok, image: dataURL, durationMs, model, aspect }
 *                      → { ok: false, code: 'auth'|'cancelled'|'error', error }
 *   POST /api/ai/understand/cancel
 *                      → { ok, cancelled }  (escape hatch for a stuck codex task)
 *
 * understand is the only slot user: codex tasks are heavy, one at a time.
 * render is a plain HTTP forward — it never claims the slot, so rendering
 * and recognition can overlap. It follows the client connection: aborting
 * the browser fetch (or closing the page) aborts the upstream request.
 * Errors are HTTP 200 + { ok:false } (only malformed input → 400).
 *
 * The understand codex invocation uses --output-schema + `-o` file +
 * --ephemeral (strict JSON, nothing persisted).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_MODEL, PLAN_REASONING_EFFORT, MODEL_LABEL, MIN_CODEX_VERSION, supportsCodexModel } from './ai-config.mjs'

const CODEX_BIN = process.env.HOME3D_CODEX_BIN || 'codex'
// Windows cannot exec shebang scripts: an explicit bin path without a native
// extension (the offline-test mock, a JS launcher) is run through node.
const VIA_NODE =
  process.platform === 'win32' && /[\\/]/.test(CODEX_BIN) && !/\.(exe|cmd|bat|com)$/i.test(CODEX_BIN)

const UNDERSTAND_TIMEOUT_MS = 600_000
const RENDER_TIMEOUT_MS = 240_000
const CODEX_CHECK_TTL_MS = 30_000
const MAX_BODY = 48 * 1024 * 1024

const DATA_URL_RE = /^data:image\/(png|jpeg);base64,(.+)$/

function send(res, obj, status = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Spawn the codex CLI; resolve with { code, stdout, stderr, timedOut, killed, error? }.
 * The returned promise carries a `kill()` handle: SIGKILLs the child (e.g. when
 * the HTTP client disconnects mid-task) and flags the result `killed`.
 *
 * Two hard-won details:
 * - detached + process-group kill: codex spawns MCP-server grandchildren that
 *   inherit the stdio pipes; killing only the direct child leaves them (and
 *   the pipes) alive for seconds, and 'close' waits for the pipes.
 * - killed/timed-out runs settle on 'exit', not 'close' — same reason.
 */
function runCodex(args, timeoutMs) {
  let child = null
  let killed = false
  const killTree = () => {
    try {
      process.kill(-child.pid, 'SIGKILL') // negative pid = the process group
    } catch {
      try {
        child?.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
  const promise = new Promise((resolve) => {
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    child = spawn(
      VIA_NODE ? process.execPath : CODEX_BIN,
      VIA_NODE ? [CODEX_BIN, ...args] : args,
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    )
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })
    child.on('exit', (code) => {
      if (killed || timedOut) done({ code: code ?? -1, stdout, stderr, timedOut, killed })
    })
    child.on('error', (err) =>
      done({ code: -1, stdout, stderr, timedOut, killed, error: err.code || err.message }),
    )
    child.on('close', (code) => done({ code, stdout, stderr, timedOut, killed }))
  })
  promise.kill = () => {
    killed = true
    killTree()
  }
  return promise
}

/** Fallback: extract the last balanced {...} block from text that parses as JSON. */
function extractLastJson(text) {
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

let codexCheckCache = { at: 0, result: null }

/** Check CLI compatibility before asking it to log in or run GPT-6. */
async function codexVersionError() {
  const r = await runCodex(['--version'], 3_000)
  if (r.error === 'ENOENT') return 'codex CLI not found on PATH'
  if (r.timedOut) return 'codex version check timed out'
  if (r.error || r.code !== 0) return 'codex CLI failed to report its version'
  if (!supportsCodexModel(r.stdout)) return `codex CLI >= ${MIN_CODEX_VERSION} required for GPT-6 Astra — update: npm i -g @openai/codex@latest`
  return null
}

/** Successful compatibility/login probes are cached ~30 s to avoid spawn-per-poll. */
async function codexAvailability() {
  if (codexCheckCache.result?.available && Date.now() - codexCheckCache.at < CODEX_CHECK_TTL_MS) {
    return codexCheckCache.result
  }
  const versionError = await codexVersionError()
  if (versionError) return { available: false, reason: versionError }
  const r = await runCodex(['login', 'status'], 3_000)
  let result
  if (r.error === 'ENOENT') result = { available: false, reason: 'codex CLI not found on PATH' }
  else if (r.timedOut) result = { available: false, reason: 'codex login status timed out' }
  else if (r.error || r.code !== 0) {
    result = { available: false, reason: 'codex CLI not logged in — run: codex login' }
  } else result = { available: true }
  codexCheckCache = { at: Date.now(), result }
  return result
}

// ---------------------------------------------------------------------------
// Single-flight slot for understand (the only codex-backed endpoint).
// ---------------------------------------------------------------------------

/** @type {{ kind: 'understand', startedAt: number, kill: (() => void)|null } | null} */
let codexCurrent = null

function busyResponse(res) {
  return send(res, {
    ok: false,
    code: 'busy',
    error: `another codex task (${codexCurrent.kind}) is running`,
    startedAt: codexCurrent.startedAt,
    kind: codexCurrent.kind,
  })
}

/** Check login, then atomically claim the shared slot before returning it. */
async function preflight(res) {
  if (codexCurrent) {
    busyResponse(res)
    return null
  }
  const versionError = await codexVersionError()
  if (versionError) {
    send(res, { ok: false, code: 'error', error: versionError })
    return null
  }
  const login = await runCodex(['login', 'status'], 3_000)
  if (login.error || login.timedOut || login.code !== 0) {
    send(res, { ok: false, code: 'auth', error: 'codex CLI not logged in — run: codex login' })
    return null
  }
  // Other requests can finish their login probe while this one is awaiting it.
  if (codexCurrent) {
    busyResponse(res)
    return null
  }
  if (res.destroyed) return null
  codexCurrent = { kind: 'understand', startedAt: Date.now(), kill: null }
  return codexCurrent
}

/** Escape hatch: SIGKILL the in-flight codex recognition task. */
function handleCancel(res) {
  if (!codexCurrent) return send(res, { ok: true, cancelled: false })
  codexCurrent.kill?.()
  send(res, { ok: true, cancelled: true })
}

/** Parse a request body whose `image` (and optional `images`) are PNG/JPEG data URLs. */
async function readImageBody(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body')
  } catch {
    send(res, { ok: false, code: 'error', error: 'invalid request body' }, 400)
    return null
  }
  const rawImages = [body.image, ...(Array.isArray(body.images) ? body.images : [])].filter(Boolean)
  if (rawImages.length === 0) {
    send(res, { ok: false, code: 'error', error: 'no source image' }, 400)
    return null
  }
  const images = []
  for (const raw of rawImages) {
    const m = typeof raw === 'string' ? raw.match(DATA_URL_RE) : null
    if (!m) {
      send(res, { ok: false, code: 'error', error: 'images must be PNG or JPEG data URLs' }, 400)
      return null
    }
    images.push({ ext: m[1] === 'jpeg' ? 'jpg' : 'png', data: Buffer.from(m[2], 'base64') })
  }
  return { body, images }
}

// ---------------------------------------------------------------------------
// Floor-plan recognition: codex exec --output-schema (strict JSON, ephemeral).
// ---------------------------------------------------------------------------

async function handleUnderstand(req, res) {
  const parsed = await readImageBody(req, res)
  if (!parsed) return
  const current = await preflight(res)
  if (!current) return
  const started = current.startedAt
  let dir = null
  // client went away (page refresh / abort) → kill the codex subprocess so
  // the single-flight slot frees immediately instead of after the timeout
  res.on('close', () => {
    if (!res.writableEnded && codexCurrent === current) current.kill?.()
  })
  try {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'home3d-ai-')))
    const imageFile = join(dir, `image.${parsed.images[0].ext}`)
    writeFileSync(imageFile, parsed.images[0].data)
    const schemaFile = join(dir, 'schema.json')
    writeFileSync(schemaFile, JSON.stringify(PLAN_SCHEMA))
    const outFile = join(dir, 'out.json')
    const rp = runCodex(
      [
        'exec',
        '--model', CODEX_MODEL,
        '-c', `model_reasoning_effort="${PLAN_REASONING_EFFORT}"`,
        '--skip-git-repo-check',
        '--ephemeral',
        '-s',
        'read-only',
        '-C',
        dir,
        '-i',
        imageFile,
        '--output-schema',
        schemaFile,
        '-o',
        outFile,
        '--',
        UNDERSTAND_PROMPT,
      ],
      UNDERSTAND_TIMEOUT_MS,
    )
    current.kill = rp.kill
    const r = await rp
    if (r.killed) {
      return send(res, { ok: false, code: 'cancelled', error: 'recognition cancelled' })
    }
    if (r.timedOut) {
      return send(res, { ok: false, code: 'error', error: 'recognition timed out (600 s)' })
    }
    if (r.error || r.code !== 0) {
      const tail = (r.stderr || '').trim().slice(-300) || r.error || `codex exited with code ${r.code}`
      return send(res, { ok: false, code: 'error', error: tail })
    }
    let plan = null
    try {
      plan = JSON.parse(readFileSync(outFile, 'utf8'))
    } catch {
      plan = extractLastJson(r.stdout)
    }
    if (!plan || !(plan.version === 2 ? Array.isArray(plan.spaces) && plan.spaces.length > 0 : plan.overall && Array.isArray(plan.rooms) && plan.rooms.length > 0)) {
      return send(res, { ok: false, code: 'error', error: 'unparseable model output' })
    }
    send(res, { ok: true, plan, durationMs: Date.now() - started, engine: 'codex', codexModel: CODEX_MODEL, reasoningEffort: PLAN_REASONING_EFFORT })
  } finally {
    if (codexCurrent === current) codexCurrent = null
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 3D view repaint: forward one multipart POST to an OpenAI-compatible
// image API ({baseUrl}/images/edits, Bearer apiKey). The first image is the
// 3D view to repaint, the rest are furniture reference photos.
// ---------------------------------------------------------------------------

const ASPECT_SIZES = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' }
const MAX_RENDER_REFS = 5

/** Shortest useful upstream error message for the client toast. */
async function upstreamError(response) {
  const text = await response.text().catch(() => '')
  try {
    const message = JSON.parse(text)?.error?.message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300)
  } catch {
    /* not JSON */
  }
  return text.trim().slice(0, 300) || `image API responded with HTTP ${response.status}`
}

function imageMimeType(buffer) {
  return buffer.length > 1 && buffer[0] === 0xff && buffer[1] === 0xd8 ? 'image/jpeg' : 'image/png'
}

async function handleRender(req, res) {
  const parsed = await readImageBody(req, res)
  if (!parsed) return
  const prompt = typeof parsed.body.prompt === 'string' ? parsed.body.prompt.trim() : ''
  if (!prompt) return send(res, { ok: false, code: 'error', error: 'prompt is required' }, 400)
  const baseUrl = typeof parsed.body.baseUrl === 'string' ? parsed.body.baseUrl.trim().replace(/\/+$/, '') : ''
  const apiKey = typeof parsed.body.apiKey === 'string' ? parsed.body.apiKey.trim() : ''
  const model = typeof parsed.body.model === 'string' ? parsed.body.model.trim() : ''
  if (!baseUrl || !apiKey || !model) {
    return send(res, { ok: false, code: 'error', error: 'baseUrl, apiKey and model are required' }, 400)
  }
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    return send(res, { ok: false, code: 'error', error: 'baseUrl must be an http(s) URL' }, 400)
  }
  const aspect = Object.hasOwn(ASPECT_SIZES, parsed.body.aspect) ? parsed.body.aspect : '3:2'

  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, RENDER_TIMEOUT_MS)
  // client went away (page refresh / abort) → cancel the upstream request
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const started = Date.now()
  try {
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    form.append('size', ASPECT_SIZES[aspect])
    form.append('n', '1')
    for (const [i, img] of parsed.images.slice(0, MAX_RENDER_REFS + 1).entries()) {
      form.append(
        'image[]',
        new Blob([img.data], { type: img.ext === 'jpg' ? 'image/jpeg' : 'image/png' }),
        `image-${i}.${img.ext}`,
      )
    }
    const upstream = await fetch(`${baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: abort.signal,
    })
    if (!upstream.ok) {
      return send(res, {
        ok: false,
        code: upstream.status === 401 || upstream.status === 403 ? 'auth' : 'error',
        error: await upstreamError(upstream),
      })
    }
    const data = await upstream.json()
    const item = Array.isArray(data?.data) ? data.data[0] : null
    let buffer = typeof item?.b64_json === 'string' && item.b64_json ? Buffer.from(item.b64_json, 'base64') : null
    if ((!buffer || buffer.length === 0) && typeof item?.url === 'string') {
      // Providers may answer with a URL instead of inline base64; inline it here.
      const download = await fetch(item.url, { signal: abort.signal })
      if (download.ok) buffer = Buffer.from(await download.arrayBuffer())
    }
    if (!buffer || buffer.length === 0) {
      return send(res, { ok: false, code: 'error', error: 'no image in image API response' })
    }
    send(res, {
      ok: true,
      image: `data:${imageMimeType(buffer)};base64,${buffer.toString('base64')}`,
      durationMs: Date.now() - started,
      model,
      aspect,
    })
  } catch (error) {
    if (timedOut) {
      return send(res, { ok: false, code: 'error', error: `render timed out (${RENDER_TIMEOUT_MS / 1000} s)` })
    }
    if (abort.signal.aborted) {
      return send(res, { ok: false, code: 'cancelled', error: 'render cancelled' })
    }
    return send(res, { ok: false, code: 'error', error: String(error).slice(0, 300) })
  } finally {
    clearTimeout(timer)
  }
}

async function handleStatus(res) {
  send(res, {
    ok: true,
    codex: await codexAvailability(),
    busy: !!codexCurrent,
    busySince: codexCurrent?.startedAt ?? null,
    busyKind: codexCurrent?.kind ?? null,
    model: MODEL_LABEL,
    codexModel: CODEX_MODEL,
  })
}

/** Vite plugin: mounts the API on the dev server. */
export function aiApi() {
  return {
    name: 'home3d-ai-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        let task
        if (url === '/api/ai/status' && req.method === 'GET') task = handleStatus(res)
        else if (url === '/api/ai/understand' && req.method === 'POST') task = handleUnderstand(req, res)
        else if (url === '/api/ai/render' && req.method === 'POST') task = handleRender(req, res)
        else if (url === '/api/ai/understand/cancel' && req.method === 'POST') {
          return void handleCancel(res)
        } else return next()
        task.catch((error) => {
          if (!res.destroyed && !res.headersSent) send(res, { ok: false, code: 'error', error: error.message })
        })
      })
    },
  }
}
