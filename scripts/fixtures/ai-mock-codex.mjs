// Executed only by test-ai-api.mjs in its isolated temporary CODEX_HOME.
// Only floor-plan recognition goes through codex; image renders use the mock
// image API, so every exec here must be an --ephemeral understand run.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = process.env.HOME3D_AI_MOCK
if (!root) throw new Error('HOME3D_AI_MOCK is required')
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
const events = join(root, 'events.jsonl')
const record = (event) => appendFileSync(events, `${JSON.stringify(event)}\n`)
const args = process.argv.slice(2)

if (args[0] === '--version') {
  record({ type: 'version' })
  console.log(`codex-cli ${config.version ?? '0.153.4'}`)
  process.exit(0)
}

if (args[0] === 'login') {
  record({ type: 'login' })
  if (config.loginBarrier) {
    // Both preflight probes must be in progress before either may complete.
    const deadline = Date.now() + 3_000
    while (readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(event => event.type === 'login').length < config.loginBarrier) {
      if (Date.now() > deadline) throw new Error('login barrier timed out')
      await delay(10)
    }
  }
  await delay(40)
  process.exit(config.loginExit ?? 0)
}

if (args[0] !== 'exec') throw new Error(`unexpected command: ${args[0]}`)
if (!args.includes('--ephemeral')) throw new Error('unexpected non-ephemeral exec (renders no longer use codex)')
const cwd = args[args.indexOf('-C') + 1]
record({ type: 'exec', cwd, args })
record({ type: 'ready' })
if (config.mode === 'hang') await delay(60_000)
await delay(config.execDelay ?? 0)
const plan = { overall: { widthM: 5, depthM: 4 }, rooms: [{ name: 'Living', type: 'living', x: 0, y: 0, w: 5, d: 4 }], doors: [], windows: [] }
writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(plan))
