import { footprintOf, getModel, type FurnitureInstance } from '../models/registry'
import { boxAt, clamp, overlaps, type Box } from '../lib/geom'
import { useStore } from '../state/store'
import { roomById } from '../state/home'
import { architecturalObstacles } from '../gen/architecturalFurniture'
import { polygonContainsFootprint } from '../gen/architectureGeometry'
import type { PlanPoint } from '../state/architecture'

/**
 * Pet behavior engine: models of type PETS wander their room, play a little
 * performance when clicked and respect collision boxes. Everything here is
 * session-only presentation state — the store keeps the placed (anchor)
 * position, so wandering never writes history, persistence or undo snapshots.
 *
 * The renderer drives `tick` once per frame; positions are room-local like
 * FurnitureInstance.position. Walls bound the walkable area (the room rect in
 * legacy mode, the real space polygon in professional mode), other furniture
 * footprints and fellow pets are obstacles the pet steers around.
 */

const WALK_SPEED = 0.34 // m/s stroll
const TURN_SPEED = 7 // rad/s while facing the walk target
const EDGE_CLEAR = 0.05 // extra wall clearance beyond the pet radius
const IDLE_MIN = 1.2
const IDLE_MAX = 4.6
const MIN_STROLL = 0.45 // shorter trips aren't worth waking up for
const TARGET_TRIES = 14
const WALK_STEP_RATE = 9 // bob cycles per second while walking
const WALK_BOB_H = 0.03
const WALK_ROLL = 0.07
const PLAY_TOTAL = 1.9 // click performance: crouch → two hops → happy wiggle
const PLAY_HOP_H = 0.17
/** rug-height furniture the pet happily walks across */
const WALKABLE_HEIGHT = 0.05

/**
 * Per-model facing correction — the yaw the wander group must carry so the
 * nose leads the movement is the walk bearing minus this offset. Both cats
 * were calibrated against their walk direction in the browser: the chibi
 * kitten (Z-up export, +90° X node bake) faces +Z at heading 0, while the
 * toon cat's nose points along -Z.
 */
const PET_FORWARD_FLIP: Record<string, number> = {
  'pets:chibi-kitten': 0,
  'pets:toon-cat': Math.PI,
}

/** Live pets of the whole scene (room-local positions), for pet-vs-pet collision. */
interface LivePet {
  x: number
  z: number
  radius: number
  roomId: string
}
const livePets = new Map<string, LivePet>()

interface PetEnv {
  originX: number
  originZ: number
  /** legacy rect mode: walkable half-extents around the room center */
  halfW: number
  halfD: number
  /** professional mode: real space polygon + wall/stair obstacles (home coords) */
  polygon: PlanPoint[] | null
  archObstacles: PlanPoint[][] | null
  polyBounds: { minX: number; minZ: number; maxX: number; maxZ: number } | null
  /** furniture collision boxes (room-local, pets/ceiling/rugs excluded) */
  boxes: Box[]
}

function petRadius(instance: FurnitureInstance): number {
  const def = getModel(instance.modelId)
  if (!def) return 0.2
  const [w, d] = footprintOf(def, instance.params, instance.scale)
  return Math.max(w, d) / 2
}

function buildEnv(instance: FurnitureInstance): PetEnv | null {
  const s = useStore.getState()
  const room = roomById(s.home, instance.roomId)
  if (!room) return null
  const arch = s.home.architecture
  const space = arch?.spaces.find((sp) => sp.id === instance.roomId) ?? null
  const radius = petRadius(instance)
  const boxes: Box[] = []
  for (const f of s.furniture) {
    if (f.roomId !== instance.roomId || f.id === instance.id) continue
    const def = getModel(f.modelId)
    if (!def || def.type === 'PETS') continue // fellow pets collide as circles
    if (def.mount === 'ceiling' || def.mount === 'wall') continue
    if (def.height !== undefined && def.height < WALKABLE_HEIGHT) continue
    const [w, d] = footprintOf(def, f.params, f.scale)
    boxes.push(boxAt(f.position[0], f.position[1], w, d, f.rotationY))
  }
  let polygon: PlanPoint[] | null = null
  let archObstacles: PlanPoint[][] | null = null
  let polyBounds: PetEnv['polyBounds'] = null
  if (space) {
    polygon = space.polygon
    archObstacles = architecturalObstacles(arch!, space.levelId)
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    for (const [px, pz] of polygon) {
      minX = Math.min(minX, px)
      maxX = Math.max(maxX, px)
      minZ = Math.min(minZ, pz)
      maxZ = Math.max(maxZ, pz)
    }
    polyBounds = { minX, minZ, maxX, maxZ }
  }
  return {
    originX: room.rect.x,
    originZ: room.rect.z,
    halfW: room.rect.w / 2 - radius - EDGE_CLEAR,
    halfD: room.rect.d / 2 - radius - EDGE_CLEAR,
    polygon,
    archObstacles,
    polyBounds,
    boxes,
  }
}

/**
 * Is (x, z) standing room for a pet? Hard limits (walls / space polygon)
 * always apply; soft obstacles (furniture, other pets) are ignored while the
 * pet is already stuck inside one so it can walk free.
 */
function walkableAt(
  env: PetEnv,
  radius: number,
  id: string,
  roomId: string,
  x: number,
  z: number,
  ignoreSoft = false,
): boolean {
  if (env.polygon) {
    const d = radius * 2 + 0.03
    if (
      !polygonContainsFootprint(
        env.polygon,
        [x + env.originX, z + env.originZ],
        d,
        d,
        0,
        env.archObstacles ?? [],
      )
    )
      return false
  } else if (Math.abs(x) > env.halfW || Math.abs(z) > env.halfD) {
    return false
  }
  if (ignoreSoft) return true
  const self = { x, z, w: radius * 2, d: radius * 2 }
  for (const b of env.boxes) if (overlaps(self, b, 0.02)) return false
  for (const [pid, p] of livePets) {
    if (pid === id || p.roomId !== roomId) continue
    const dx = p.x - x
    const dz = p.z - z
    const rr = p.radius + radius + 0.02
    if (dx * dx + dz * dz < rr * rr) return false
  }
  return true
}

export interface PetController {
  /** visual position, room-local (starts at the placed position) */
  x: number
  z: number
  /** extra facing on top of the stored rotationY */
  heading: number
  /** frame pose: hop height, squash/stretch (>0 = squashed wide), side roll */
  hopY: number
  squash: number
  roll: number
  /** play the click performance (ignored while dragging) */
  play(): void
  beginDrag(): void
  endDrag(): void
  /** stored position changed: drag keeps the grab offset, other edits re-anchor */
  reanchor(pos: readonly [number, number]): void
  tick(dt: number, instance: FurnitureInstance): void
  dispose(): void
}

export function createPetController(instance: FurnitureInstance): PetController {
  const state = {
    x: instance.position[0],
    z: instance.position[1],
    heading: 0,
    hopY: 0,
    squash: 0,
    roll: 0,
    phase: 'idle' as 'idle' | 'walk' | 'play',
    timer: 0.8 + Math.random() * 2,
    target: null as { x: number; z: number } | null,
    playT: 0,
    walkPhase: 0,
    dragging: false,
    lastPos: [instance.position[0], instance.position[1]] as [number, number],
    env: null as PetEnv | null,
    envFurniture: null as readonly FurnitureInstance[] | null,
    envHome: null as unknown,
    clock: Math.random() * 10,
  }

  const flip = PET_FORWARD_FLIP[instance.modelId] ?? 0

  /** Sample random walk targets; true once one is both free and worth the trip. */
  const pickTarget = (env: PetEnv, radius: number): boolean => {
    const rect = !env.polygon
    if (rect && (env.halfW <= 0 || env.halfD <= 0)) return false
    for (let i = 0; i < TARGET_TRIES; i++) {
      let x: number
      let z: number
      if (rect) {
        x = (Math.random() * 2 - 1) * env.halfW
        z = (Math.random() * 2 - 1) * env.halfD
      } else {
        const b = env.polyBounds!
        x = b.minX + Math.random() * (b.maxX - b.minX) - env.originX
        z = b.minZ + Math.random() * (b.maxZ - b.minZ) - env.originZ
      }
      const dx = x - state.x
      const dz = z - state.z
      if (dx * dx + dz * dz < MIN_STROLL * MIN_STROLL) continue
      if (!walkableAt(env, radius, instance.id, instance.roomId, x, z)) continue
      state.target = { x, z }
      state.phase = 'walk'
      return true
    }
    return false
  }

  const controller: PetController = {
    get x() {
      return state.x
    },
    get z() {
      return state.z
    },
    get heading() {
      return state.heading
    },
    get hopY() {
      return state.hopY
    },
    get squash() {
      return state.squash
    },
    get roll() {
      return state.roll
    },
    play() {
      if (state.dragging) return
      state.phase = 'play'
      state.playT = 0
      state.target = null
      state.hopY = 0
    },
    beginDrag() {
      state.dragging = true
    },
    endDrag() {
      state.dragging = false
    },
    reanchor(pos) {
      if (state.dragging) {
        // keep the grab: shift the visual pose by the same delta as the store
        state.x += pos[0] - state.lastPos[0]
        state.z += pos[1] - state.lastPos[1]
      } else {
        state.x = pos[0]
        state.z = pos[1]
        state.heading = 0
        state.target = null
        state.phase = 'idle'
        state.timer = 0.8 + Math.random() * 1.2
        state.hopY = 0
        state.squash = 0
        state.roll = 0
      }
      state.lastPos = [pos[0], pos[1]]
    },
    tick(dt, current) {
      const s = useStore.getState()
      if (state.envFurniture !== s.furniture || state.envHome !== s.home || !state.env) {
        state.env = buildEnv(current)
        state.envFurniture = s.furniture
        state.envHome = s.home
      }
      const env = state.env
      const radius = petRadius(current)
      state.clock += dt

      // stuck inside an obstacle (furniture dragged onto the pet, walls moved)?
      // then stepping may ignore soft collisions until it is free again
      const stuck = env ? !walkableAt(env, radius, current.id, current.roomId, state.x, state.z) : false

      if (!state.dragging && env) {
        if (state.phase === 'play') {
          state.playT += dt
          const t = state.playT
          if (t < 0.3) {
            // crouch: squash in anticipation
            state.squash = (t / 0.3) * 0.22
            state.hopY = 0
            state.roll = 0
          } else if (t < 1.4) {
            // two hops: stretch in flight, squash on touch-down
            const u = ((t - 0.3) % 0.55) / 0.55
            state.hopY = 4 * PLAY_HOP_H * u * (1 - u)
            state.squash = u > 0.82 ? ((u - 0.82) / 0.18) * 0.22 : -0.16 * Math.sin(u * Math.PI)
            state.roll = 0
          } else if (t < PLAY_TOTAL) {
            // happy wiggle, dying out
            const u = (t - 1.4) / (PLAY_TOTAL - 1.4)
            state.hopY = 0
            state.squash = 0
            state.roll = Math.sin(u * Math.PI * 5) * 0.14 * (1 - u)
          } else {
            state.phase = 'idle'
            state.timer = 0.6 + Math.random() * 1.6
            state.hopY = 0
            state.squash = 0
            state.roll = 0
          }
        } else if (state.phase === 'idle') {
          state.squash = Math.sin(state.clock * 2.1) * 0.02 // breathing
          state.hopY = 0
          state.roll = 0
          state.timer -= dt
          if (state.timer <= 0) {
            if (!pickTarget(env, radius)) state.timer = 0.8 + Math.random() * 1.2
          }
        } else {
          // walking: move along the target bearing θ, face θ minus the model's
          // authored nose offset (flip) — never let the correction steer the feet
          const target = state.target!
          const bearing = Math.atan2(target.x - state.x, target.z - state.z)
          const desired = bearing - flip
          let delta = desired - state.heading
          delta = Math.atan2(Math.sin(delta), Math.cos(delta))
          const maxTurn = TURN_SPEED * dt
          state.heading += clamp(delta, -maxTurn, maxTurn)

          const dx = target.x - state.x
          const dz = target.z - state.z
          if (dx * dx + dz * dz < 0.06 * 0.06) {
            state.phase = 'idle'
            state.timer = IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN)
            state.target = null
          } else if (Math.abs(delta) > 1.05) {
            // still turning to face the target — don't moonwalk
          } else {
            const step = WALK_SPEED * dt
            const nx = state.x + Math.sin(bearing) * step
            const nz = state.z + Math.cos(bearing) * step
            const free = (x: number, z: number) => walkableAt(env, radius, current.id, current.roomId, x, z, stuck)
            if (free(nx, nz)) {
              state.x = nx
              state.z = nz
            } else if (free(nx, state.z)) {
              state.x = nx
            } else if (free(state.x, nz)) {
              state.z = nz
            } else {
              state.phase = 'idle'
              state.timer = 0.6 + Math.random() * 1.4
              state.target = null
            }
            state.walkPhase += WALK_STEP_RATE * dt
            state.hopY = Math.abs(Math.sin(state.walkPhase)) * WALK_BOB_H
            state.roll = Math.sin(state.walkPhase) * WALK_ROLL
            state.squash = 0
          }
        }
      }

      livePets.set(current.id, { x: state.x, z: state.z, radius, roomId: current.roomId })
    },
    dispose() {
      livePets.delete(instance.id)
    },
  }
  livePets.set(instance.id, {
    x: state.x,
    z: state.z,
    radius: petRadius(instance),
    roomId: instance.roomId,
  })
  return controller
}
