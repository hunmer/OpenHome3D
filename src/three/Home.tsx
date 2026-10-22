import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Edges } from '@react-three/drei'
import { useStore } from '../state/store'
import { homeAABB, type RoomDef, type Side } from '../state/home'
import { deriveWalls, WALL_T, type WallSegment } from '../gen/walls'
import { EDGE, SELECT_EDGE } from '../models/parametric/shared'
import { SHELL } from '../models/palette'
import { toonGradientMap } from '../lib/toon'

const SILL = 0.55
const WIN_TOP = 2.4
const DOOR_H = 2.05
const SLAB_H = 0.15
const SLAB_OVERHANG = 0.25

/** Which side of its room a wall segment faces (drives wall click → selectWall). */
function wallSide(seg: WallSegment, room: RoomDef): Side | null {
  if (seg.normal) {
    if (seg.normal[1] < 0) return 'n'
    if (seg.normal[1] > 0) return 's'
    return seg.normal[0] < 0 ? 'w' : 'e'
  }
  // interior wall: its fixed coordinate lies on one of the room's edges
  const { x, z, w, d } = room.rect
  if (seg.axis === 'x')
    return Math.abs(seg.from[1] - (z - d / 2)) < 1e-6 ? 'n' : Math.abs(seg.from[1] - (z + d / 2)) < 1e-6 ? 's' : null
  return Math.abs(seg.from[0] - (x - w / 2)) < 1e-6 ? 'w' : Math.abs(seg.from[0] - (x + w / 2)) < 1e-6 ? 'e' : null
}

/** Standard toon shell mesh with cast/receive shadows and a dark outline. */
function WallMesh({
  geometry,
  args,
  position,
  color = SHELL.wall,
  highlight = false,
}: {
  geometry?: THREE.BufferGeometry
  args?: [number, number, number]
  position: [number, number, number]
  color?: string
  highlight?: boolean
}) {
  return (
    <mesh castShadow receiveShadow geometry={geometry} position={position}>
      {args ? <boxGeometry args={args} /> : null}
      <meshToonMaterial
        color={color}
        gradientMap={toonGradientMap()}
        emissive={highlight ? SELECT_EDGE : '#000000'}
        emissiveIntensity={highlight ? 0.35 : 0}
      />
      <Edges threshold={20} lineWidth={1} color={highlight ? SELECT_EDGE : EDGE} />
    </mesh>
  )
}

function segLength(seg: WallSegment): number {
  return Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1])
}

/** Doorways with their gap interval clamped into the segment (like Room.tsx's dl/dr). */
function clampedDoorways(seg: WallSegment, L: number) {
  const out: { dl: number; dr: number; kind: 'door' | 'open' }[] = []
  let prev = 0
  const doors = [...seg.doorways].sort((a, b) => a.u - b.u)
  for (const d of doors) {
    const dl = Math.max(prev === 0 ? 0.2 : prev + 0.05, d.u - d.w / 2)
    const dr = Math.min(L - 0.05, d.u + d.w / 2)
    if (dr - dl < 0.2) continue
    out.push({ dl, dr, kind: d.kind })
    prev = dr
  }
  return out
}

/** Windows that pass the size guard, clamped into the segment. */
function clampedWindows(seg: WallSegment, L: number, windowsOn: boolean) {
  if (!windowsOn) return []
  const top = Math.min(WIN_TOP, seg.height - 0.25)
  if (top - SILL < 0.25) return []
  const out: { u: number; w: number; top: number }[] = []
  for (const win of seg.windows) {
    const wl = Math.max(0.02, win.u - win.w / 2)
    const wr = Math.min(L - 0.02, win.u + win.w / 2)
    if (wr - wl < 0.25) continue
    out.push({ u: (wl + wr) / 2, w: wr - wl, top })
  }
  return out
}

/**
 * One wall segment as an extruded shape in its local frame (x = along the
 * wall from `from`, y = up, thickness centered on z = 0). The outline is
 * traced around doorway gaps (they are not interior holes); windows are
 * fully interior rectangular holes.
 */
function segmentGeometry(
  seg: WallSegment,
  doors: ReturnType<typeof clampedDoorways>,
  wins: ReturnType<typeof clampedWindows>,
): THREE.ExtrudeGeometry {
  const L = segLength(seg)
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  for (const d of doors) {
    s.lineTo(d.dl, 0)
    s.lineTo(d.dl, DOOR_H)
    s.lineTo(d.dr, DOOR_H)
    s.lineTo(d.dr, 0)
  }
  s.lineTo(L, 0)
  s.lineTo(L, seg.height)
  s.lineTo(0, seg.height)
  s.closePath()
  for (const win of wins) {
    const h = new THREE.Path()
    h.moveTo(win.u - win.w / 2, SILL)
    h.lineTo(win.u + win.w / 2, SILL)
    h.lineTo(win.u + win.w / 2, win.top)
    h.lineTo(win.u - win.w / 2, win.top)
    h.closePath()
    s.holes.push(h)
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: WALL_T, bevelEnabled: false })
  g.translate(0, 0, -WALL_T / 2)
  return g
}

/** Per-room partition (interior half-wall, or full wall with a doorway gap). */
function Partition({ room, wallHeight }: { room: RoomDef; wallHeight: number }) {
  const { w, d } = room.rect
  const partitionHeight = room.partitionHeight
  const partLen = w * 0.4
  const partZ = -d / 2 + d * 0.35
  const partX0 = -w / 2 // flush with the west wall
  const fullPartition = partitionHeight >= wallHeight && partitionHeight > 0
  return (
    <group position={[room.rect.x, 0, room.rect.z + partZ]}>
      {fullPartition ? (
        <>
          <WallMesh
            args={[partLen - 0.8 - 0.12, partitionHeight, WALL_T]}
            position={[partX0 + (partLen - 0.8 - 0.12) / 2, partitionHeight / 2, 0]}
          />
          <WallMesh
            args={[0.12, partitionHeight, WALL_T]}
            position={[partX0 + partLen - 0.06, partitionHeight / 2, 0]}
          />
          <WallMesh
            args={[0.8 + 0.12, partitionHeight - DOOR_H, WALL_T]}
            position={[
              partX0 + partLen - (0.8 + 0.12) / 2,
              DOOR_H + (partitionHeight - DOOR_H) / 2,
              0,
            ]}
          />
        </>
      ) : (
        <WallMesh
          args={[partLen, partitionHeight, WALL_T]}
          position={[partX0 + partLen / 2, partitionHeight / 2, 0]}
        />
      )}
    </group>
  )
}

/**
 * Whole-home shell: wall segments derived from room adjacency, floor, and
 * per-room partitions. Exterior walls bulge outward and register their
 * normal for cutaway; interior walls are centered on the shared boundary
 * and never hide.
 */
export default function Home() {
  const home = useStore((s) => s.home)
  const wallHeight = useStore((s) => s.wallHeight)
  const cutawayWalls = useStore((s) => s.cutawayWalls)
  const floorSlab = useStore((s) => s.floorSlab)
  const windowsOn = useStore((s) => s.windows)
  const doorLeaves = useStore((s) => s.doorLeaves)
  const selectedWall = useStore((s) => s.selectedWall)

  const segments = useMemo(() => deriveWalls(home, wallHeight), [home, wallHeight])
  const aabb = useMemo(() => homeAABB(home), [home])

  // openings are resolved once per segment and shared by geometry + leaves/trim
  const resolved = useMemo(
    () =>
      segments.map((seg) => {
        const L = segLength(seg)
        return {
          seg,
          doors: clampedDoorways(seg, L),
          wins: clampedWindows(seg, L, windowsOn),
        }
      }),
    [segments, windowsOn],
  )

  const geoms = useMemo(
    () => resolved.map(({ seg, doors, wins }) => segmentGeometry(seg, doors, wins)),
    [resolved],
  )
  useEffect(() => () => geoms.forEach((g) => g.dispose()), [geoms])

  // -- cutaway: hide exterior walls whose outward normal faces the camera -----
  const wallRefs = useRef(new Map<string, { obj: THREE.Group; n: THREE.Vector3 }>())
  const registerWall = useCallback(
    (key: string, n: THREE.Vector3, g: THREE.Group | null) => {
      if (g) wallRefs.current.set(key, { obj: g, n })
      else wallRefs.current.delete(key)
    },
    [],
  )
  const camDir = useRef(new THREE.Vector3())
  useFrame(({ camera }) => {
    camera.getWorldDirection(camDir.current)
    wallRefs.current.forEach(({ obj, n }) => {
      // outward normal opposing the view direction → wall stands in front of the camera
      obj.visible = !cutawayWalls || n.dot(camDir.current) >= -0.05
    })
  })

  return (
    <group>
      {/* floor: one overhanging slab over the home AABB, or a thin plate per room */}
      {floorSlab ? (
        <WallMesh
          color={SHELL.floor}
          args={[
            aabb.w + 2 * WALL_T + 2 * SLAB_OVERHANG,
            SLAB_H,
            aabb.d + 2 * WALL_T + 2 * SLAB_OVERHANG,
          ]}
          position={[aabb.cx, -SLAB_H / 2, aabb.cz]}
        />
      ) : (
        home.rooms.map((r) => (
          <WallMesh
            key={r.id}
            color={SHELL.floor}
            args={[r.rect.w, 0.02, r.rect.d]}
            position={[r.rect.x, -0.01, r.rect.z]}
          />
        ))
      )}

      {/* wall segments: clicking a wall selects it for the status-bar opening editor */}
      {resolved.map(({ seg, doors, wins }, i) => {
        const dx = seg.to[0] - seg.from[0]
        const dz = seg.to[1] - seg.from[1]
        const rotY = Math.atan2(-dz, dx)
        // exterior: wall center plane sits WALL_T/2 outward of the room edge;
        // interior: centered on the shared boundary
        const off = seg.kind === 'ext' && seg.normal ? WALL_T / 2 : 0
        const px = seg.from[0] + (seg.normal?.[0] ?? 0) * off
        const pz = seg.from[1] + (seg.normal?.[1] ?? 0) * off
        const segRoom = home.rooms.find((r) => r.id === seg.roomId)
        const side = segRoom ? wallSide(seg, segRoom) : null
        const highlighted =
          !!selectedWall && !!side && selectedWall.roomId === seg.roomId && selectedWall.side === side
        const pickWall = () => {
          if (!segRoom || !side) return
          const st = useStore.getState()
          st.selectRoom(segRoom.id) // activates the declaring room first (clears selection)
          st.selectWall({ roomId: segRoom.id, side })
        }
        return (
          <group
            key={seg.key}
            ref={
              seg.kind === 'ext' && seg.normal
                ? (g) => registerWall(seg.key, new THREE.Vector3(seg.normal![0], 0, seg.normal![1]), g)
                : undefined
            }
            position={[px, 0, pz]}
            rotation-y={rotY}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              pickWall()
            }}
          >
            <WallMesh geometry={geoms[i]} position={[0, 0, 0]} highlight={highlighted} />

            {/* door leaves, hinged at the gap start (kind 'open' has no leaf) */}
            {doorLeaves &&
              doors.map((d, j) =>
                d.kind !== 'door' ? null : (
                  <group
                    key={j}
                    position={[d.dl + 0.02, 0, WALL_T / 2]}
                    rotation-y={-Math.PI / 6}
                  >
                    <WallMesh
                      color={SHELL.doorLeaf}
                      args={[d.dr - d.dl - 0.04, DOOR_H - 0.05, 0.04]}
                      position={[(d.dr - d.dl - 0.04) / 2, (DOOR_H - 0.05) / 2, 0]}
                    />
                  </group>
                ),
              )}

            {/* window frames + glass in the wall's local frame; glass gets no
                edges/shadows and hides with its wall via the group ref */}
            {wins.map((win, k) => {
              const h = win.top - SILL
              return (
                <group key={`${win.u}:${k}`} position={[win.u, 0, 0]}>
                  <WallMesh
                    args={[0.05, h, WALL_T + 0.02]}
                    position={[-(win.w / 2 - 0.025), SILL + h / 2, 0]}
                  />
                  <WallMesh
                    args={[0.05, h, WALL_T + 0.02]}
                    position={[win.w / 2 - 0.025, SILL + h / 2, 0]}
                  />
                  {/* center mullion splits the window into two panes */}
                  <WallMesh args={[0.04, h, WALL_T + 0.02]} position={[0, SILL + h / 2, 0]} />
                  <WallMesh
                    args={[win.w - 0.1, 0.05, WALL_T + 0.02]}
                    position={[0, win.top - 0.025, 0]}
                  />
                  <WallMesh
                    args={[win.w - 0.1, 0.05, WALL_T + 0.04]}
                    position={[0, SILL + 0.025, 0]}
                  />
                  <mesh position={[0, SILL + h / 2, 0]}>
                    <boxGeometry args={[win.w - 0.06, h - 0.06, 0.02]} />
                    <meshStandardMaterial
                      color={SHELL.glass}
                      transparent
                      opacity={0.35}
                      roughness={0.1}
                      metalness={0}
                      depthWrite={false}
                    />
                  </mesh>
                </group>
              )
            })}
          </group>
        )
      })}

      {/* per-room partitions */}
      {home.rooms.map(
        (r) =>
          r.partitionHeight > 0 && <Partition key={r.id} room={r} wallHeight={wallHeight} />,
      )}
    </group>
  )
}
