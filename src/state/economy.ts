import {
  allModels,
  type FurnitureInstance,
  type FurnitureType,
  type ModelDef,
} from '../models/registry'
import type { HomeDef } from './home'

/**
 * Nurture-game economy: pure pricing/income functions and constants only.
 * The store owns the wallet; coins never enter undo snapshots, so spending
 * is final (no refunds on delete/undo/reset) and claims can't be rolled back.
 */

export const STARTING_COINS = 800
/** New rooms and grown rooms cost this many coins per square meter (shrinking is free). */
export const ROOM_COIN_PER_M2 = 10
export const INCOME_PER_ROOM = 2 // coins per minute per room
export const INCOME_PER_MODEL = 1 // per DISTINCT model currently placed
export const INCOME_CAP_MINUTES = 12 * 60 // offline accrual ceiling
export const DAILY_BASE = 100
export const DAILY_STREAK_STEP = 20
export const DAILY_STREAK_MAX = 200

const TYPE_PRICES: Record<FurnitureType, number> = {
  BEDS: 400,
  KITCHEN: 350,
  BATHROOM: 300,
  SEATING: 250,
  TABLES: 200,
  STORAGE: 180,
  LIGHTING: 120,
  OTHER: 100,
  DECOR: 60,
  // pets are living companions (walk, play, collide), priced as a premium
  // adoption — 520 reads as "我爱你" for the Chinese-first audience
  PETS: 520,
}

/** Placement price: uploads are free, built-in parametrics half price. */
export function modelPrice(def: ModelDef): number {
  if (def.kind === 'upload') return 0
  return Math.round(TYPE_PRICES[def.type] * (def.brand === 'BUILT-IN' ? 0.5 : 1))
}

export function roomAreaCost(w: number, d: number): number {
  return Math.round(w * d * ROOM_COIN_PER_M2)
}

/** Growing a room charges the added area; shrinking refunds nothing. */
export function expansionCost(oldW: number, oldD: number, newW: number, newD: number): number {
  const added = newW * newD - oldW * oldD
  return added > 0 ? Math.round(added * ROOM_COIN_PER_M2) : 0
}

/** Distinct placed models only — duplicates and reshuffles must not farm income. */
export function incomePerMinute(home: HomeDef, furniture: readonly FurnitureInstance[]): number {
  return (
    home.rooms.length * INCOME_PER_ROOM +
    new Set(furniture.map((f) => f.modelId)).size * INCOME_PER_MODEL
  )
}

/** Whole coins accrued; floored so very short waits collect 0, capped offline. */
export function accruedIncome(ratePerMin: number, elapsedMs: number): number {
  if (ratePerMin <= 0 || elapsedMs <= 0) return 0
  return Math.floor(Math.min(elapsedMs / 60000, INCOME_CAP_MINUTES) * ratePerMin)
}

/** Day 1 pays the base; each consecutive day adds a step, capped at the max. */
export function dailyReward(streak: number): number {
  return DAILY_BASE + Math.min(Math.max(streak - 1, 0) * DAILY_STREAK_STEP, DAILY_STREAK_MAX - DAILY_BASE)
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function localDayKey(now: number = Date.now()): string {
  return dayKeyOf(new Date(now))
}

export function previousDayKey(now: number = Date.now()): string {
  const d = new Date(now)
  d.setDate(d.getDate() - 1)
  return dayKeyOf(d)
}

export interface OwnershipSource {
  unlocked: readonly string[]
  furniture: readonly FurnitureInstance[]
  storage: readonly FurnitureInstance[]
  uploads: readonly ModelDef[]
}

/**
 * The catalog auto-layout may pick from: paid unlocks plus everything
 * currently placed or stashed (legacy saves and imports self-heal into the
 * catalog), the built-in parametrics and the user's own uploads.
 */
export function ownedModelIds(src: OwnershipSource): Set<string> {
  const owned = new Set(src.unlocked)
  for (const f of src.furniture) owned.add(f.modelId)
  for (const f of src.storage) owned.add(f.modelId)
  for (const u of src.uploads) owned.add(u.id)
  for (const m of allModels()) if (m.kind === 'parametric') owned.add(m.id)
  return owned
}
