#!/usr/bin/env node
/**
 * Scans public/models/<brand-dir>/*.glb and writes src/assets/manifest.json:
 * an array of { id, name, brand, type, file }.
 *
 *  - id:    unique kebab-case id derived from the filename
 *  - name:  humanized filename ("loungeSofaCorner" -> "Lounge Sofa Corner")
 *  - brand: KENNEY | KAYKIT (both kaykit dirs map to KAYKIT) | PETS (pets dir)
 *  - type:  BEDS | SEATING | LIGHTING | TABLES | STORAGE | KITCHEN | BATHROOM
 *           | DECOR | PETS | OTHER, from filename word rules (see RULES)
 *  - file:  web path, e.g. /models/kenney/loungeSofaCorner.glb
 *
 * Prints a per-type summary at the end. Re-run any time; it always
 * regenerates the manifest from whatever GLBs are on disk.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeIO, getBounds } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { sizeFor } from './size-rules.mjs'

const glbIO = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODELS_DIR = join(ROOT, 'public', 'models')
const OUT_FILE = join(ROOT, 'src', 'assets', 'manifest.json')

// Directory processing order matters: earlier dirs win clean ids on collision.
const BRAND_BY_DIR = {
  kenney: 'KENNEY',
  'kaykit-furniture': 'KAYKIT',
  'kaykit-restaurant': 'KAYKIT',
  pets: 'PETS',
}

// Classification is per-word: the kebab-case id is split on '-' and each rule
// matches whole words first ("bookshelf" never hits "book", "cupboard" never
// hits "cup"). A second pass then tries substring matches for keywords of 4+
// chars, which catches concatenated KayKit names like "kitchencounter",
// "pictureframe" or "extractorhood" (short keywords like cup/pan/pot stay
// exact-only so "cupboard"/"paneling"/"potted" don't false-hit).
// First matching rule wins. Anything with "kitchen" in any word is KITCHEN
// outright (Kenney's kitchen* files, KayKit's kitchencounter/kitchentable/
// kitchencabinet and *-kitchen names like "sink-kitchen").
const RULES = [
  // pets first: "dog bed" is a pet, not furniture
  ['PETS', ['pet', 'pets', 'kitten', 'cat', 'dog', 'puppy', 'hamster', 'rabbit', 'bunny', 'parrot', 'fish tank', 'aquarium', 'turtle', 'bird']],
  ['BEDS', ['bed', 'bunk', 'bunkbed']],
  ['SEATING', ['chair', 'sofa', 'stool', 'bench', 'seat', 'ottoman', 'lounge', 'armchair', 'couch', 'booth']],
  ['LIGHTING', ['lamp', 'light', 'fan', 'chandelier']],
  ['TABLES', ['table', 'desk', 'side']],
  ['STORAGE', ['bookcase', 'bookshelf', 'cabinet', 'shelf', 'rack', 'wardrobe', 'dresser', 'crate', 'box', 'chest', 'drawer', 'drawers', 'cupboard']],
  ['KITCHEN', ['fridge', 'stove', 'oven', 'microwave', 'toaster', 'blender', 'hood', 'dish', 'plate', 'cup', 'jar', 'food', 'mug', 'pan', 'pot', 'kettle', 'cutlery', 'knife', 'spatula', 'bowl', 'cuttingboard', 'ketchup', 'mustard', 'lid', 'papertowel']],
  ['BATHROOM', ['bath', 'bathroom', 'bathtub', 'shower', 'toilet', 'washer', 'dryer', 'sink', 'towel', 'towels']],
  ['DECOR', ['plant', 'rug', 'pillow', 'book', 'decor', 'vase', 'picture', 'frame', 'clock', 'bear', 'television', 'tv', 'radio', 'speaker', 'laptop', 'screen', 'keyboard', 'mouse', 'trash', 'mirror', 'cactus', 'menu']],
]

const ALL_TYPES = [...RULES.map(([t]) => t), 'OTHER']

function kebab(file) {
  return file
    .replace(/\.[^.]+$/, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

function humanize(id) {
  return id
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

function classify(words) {
  for (const w of words) {
    if (w.includes('kitchen')) return 'KITCHEN'
  }
  for (const [type, keywords] of RULES) {
    for (const kw of keywords) {
      if (words.has(kw)) return type
    }
  }
  for (const [type, keywords] of RULES) {
    for (const kw of keywords) {
      if (kw.length < 4) continue
      for (const w of words) {
        if (w.includes(kw)) return type
      }
    }
  }
  return 'OTHER'
}

if (!existsSync(MODELS_DIR)) {
  console.error(`[build-manifest] ${MODELS_DIR} does not exist — run fetch-assets first`)
  process.exit(1)
}

const entries = []
const usedIds = new Set()

for (const dir of Object.keys(BRAND_BY_DIR)) {
  const absDir = join(MODELS_DIR, dir)
  if (!existsSync(absDir)) continue
  const files = readdirSync(absDir)
    .filter((f) => f.toLowerCase().endsWith('.glb'))
    .sort()
  for (const file of files) {
    const base = kebab(file)
    let id = base
    for (let i = 2; usedIds.has(id); i += 1) id = `${base}-${i}`
    usedIds.add(id)
    const words = new Set(id.split('-'))
    const type = classify(words)
    const entry = {
      id,
      name: humanize(id),
      brand: BRAND_BY_DIR[dir],
      type,
      file: `/models/${dir}/${file}`,
    }
    // Real-world size: measure the GLB bbox, then apply the size rules so the
    // registry footprint/height reflect plausible real dimensions (and ceiling
    // items get flagged) instead of type-level guesses.
    try {
      const doc = await glbIO.read(join(absDir, file))
      const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0]
      const b = getBounds(scene)
      const size = sizeFor(id, type, {
        w: b.max[0] - b.min[0],
        h: b.max[1] - b.min[1],
        d: b.max[2] - b.min[2],
      })
      entry.footprint = size.footprint
      entry.height = size.height
      if (size.mount !== 'floor') entry.mount = size.mount
    } catch (e) {
      console.warn(`[build-manifest] size probe failed for ${file}: ${e.message}`)
    }
    entries.push(entry)
  }
}

mkdirSync(dirname(OUT_FILE), { recursive: true })
writeFileSync(OUT_FILE, `${JSON.stringify(entries, null, 2)}\n`)

const counts = Object.fromEntries(ALL_TYPES.map((t) => [t, 0]))
for (const e of entries) counts[e.type] += 1

console.log(`[build-manifest] wrote ${entries.length} entries to ${OUT_FILE}`)
for (const t of ALL_TYPES) {
  console.log(`  ${t.padEnd(9)} ${String(counts[t]).padStart(4)}`)
}
const empty = ALL_TYPES.filter((t) => counts[t] === 0)
if (empty.length > 0) {
  console.warn(`[build-manifest] WARNING: types with no entries: ${empty.join(', ')}`)
}
const others = entries.filter((e) => e.type === 'OTHER').map((e) => e.id)
if (others.length > 0) {
  console.log(`[build-manifest] OTHER ids: ${others.join(', ')}`)
}
