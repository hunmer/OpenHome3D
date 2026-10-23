import { floorPieces, polygonArea } from '../gen/architectureGeometry'
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { homeAABB, openingsOn, roomById, homeForRoomLevel, sharedSpan, sideSpan, type Opening } from '../state/home'
import { subscribeZoomPct } from '../three/runtime'
import { useUI } from './uiStore'
import { IconButton } from './components'
import { OPENING_KIND_LABELS, openingKindLabel, SIDE_LABELS } from './labels'

const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const ROT_STEP = Math.PI / 12 // 15°
const OPENING_STEP = 0.05

function RotateLeftIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" {...S}>
      <path d="M13 8 A5 5 0 1 1 8 3" />
      <path d="M5.6 2.2 L8 3 L6.6 5.2" />
    </svg>
  )
}

function RotateRightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" {...S}>
      <path d="M3 8 A5 5 0 1 0 8 3" />
      <path d="M10.4 2.2 L8 3 L9.4 5.2" />
    </svg>
  )
}

function DuplicateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" {...S}>
      <rect x="3" y="3" width="7" height="7" />
      <path d="M6 6 h7 v7 h-7" />
    </svg>
  )
}

function SwapIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" {...S}>
      <path d="M3 6 H12 M12 6 L9.7 3.7 M12 6 L9.7 8.3" />
      <path d="M13 10 H4 M4 10 L6.3 7.7 M4 10 L6.3 12.3" />
    </svg>
  )
}

/** 收进储物箱 Store away: open box with an arrow dropping into it. */
function StoreAwayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" {...S}>
      <path d="M2.5 9 H13.5 V13.5 H2.5 Z" />
      <path d="M8 2 V6.6" />
      <path d="M6 4.8 L8 6.8 L10 4.8" />
    </svg>
  )
}

/**
 * 结构选择 pill：在整宅结构编辑器里点击墙条或门窗标记后出现。
 * Wall selected → 该墙门窗列表（点击编辑、×删除）+ +门/+窗/+打通（或阳台）+ 删墙；
 * opening selected → 类型/宽度/位置/删除。
 */
function StructurePill() {
  const home = useStore((s) => s.home)
  const wall = useStore((s) => s.selectedWall)
  const opening = useStore((s) => s.home.openings.find((o) => o.id === s.selectedOpeningId) ?? null)
  const addOpening = useStore((s) => s.addOpening)
  const updateOpening = useStore((s) => s.updateOpening)
  const removeOpening = useStore((s) => s.removeOpening)
  const removeWall = useStore((s) => s.removeWall)
  const selectOpening = useStore((s) => s.selectOpening)
  const hoverOpening = useUI((s) => s.hoverOpening)

  // leaving the wall pill (selection cleared / switched to an opening) drops the 3D ghost
  useEffect(() => {
    if (!wall) hoverOpening(null)
  }, [wall, hoverOpening])

  if (opening) {
    const room = roomById(home, opening.a)
    if (!room) return null
    const setKind = (kind: Opening['kind']) =>
      updateOpening(opening.id, kind === 'open' ? { kind } : { kind, fullHeight: undefined, parapet: undefined })
    return (
      <div className="sel-pill struct-pill">
        <span className="pill-name" title={`${room.name} · ${SIDE_LABELS[opening.side]}`}>
          {room.name} · {SIDE_LABELS[opening.side]}
        </span>
        <select
          className="input struct-kind"
          value={opening.kind}
          onChange={(e) => setKind(e.target.value as Opening['kind'])}
        >
          {(['door', 'window', 'open'] as const).map((k) => (
            <option key={k} value={k}>
              {OPENING_KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <div className="pill-btns">
          <IconButton
            title="变窄 Narrow"
            onClick={() => updateOpening(opening.id, { width: Math.max(0.3, opening.width - OPENING_STEP) })}
          >
            −
          </IconButton>
          <span className="struct-val">{opening.width.toFixed(2)}m</span>
          <IconButton
            title="变宽 Widen"
            onClick={() => updateOpening(opening.id, { width: opening.width + OPENING_STEP })}
          >
            +
          </IconButton>
          <span className="cam-sep" />
          <IconButton
            title="沿墙移动 Move along wall"
            onClick={() => updateOpening(opening.id, { offset: opening.offset - OPENING_STEP })}
          >
            ◀
          </IconButton>
          <IconButton
            title="沿墙移动 Move along wall"
            onClick={() => updateOpening(opening.id, { offset: opening.offset + OPENING_STEP })}
          >
            ▶
          </IconButton>
          <IconButton title="删除 Delete" onClick={() => removeOpening(opening.id)}>
            ×
          </IconButton>
        </div>
      </div>
    )
  }

  if (!wall) return null
  const room = roomById(home, wall.roomId)
  if (!room) return null
  const neighbor = home.rooms.find((r) => r.id !== room.id && sharedSpan(room, r)?.side === wall.side)
  const addOnSide = (kind: 'door' | 'window' | 'gap') => {
    const side = wall.side
    if (kind === 'gap') {
      const sh = neighbor && sharedSpan(room, neighbor)
      if (neighbor && sh && sh.side === side) {
        addOpening({ kind: 'open', a: room.id, b: neighbor.id, side, offset: (sh.from + sh.to) / 2, width: sh.to - sh.from, fullHeight: true })
      } else if (!neighbor) {
        const len = sideSpan(room, side).length
        addOpening({ kind: 'open', a: room.id, b: 'exterior', side, offset: len / 2, width: len, fullHeight: true })
      }
      return
    }
    addOpening({
      kind,
      a: room.id,
      b: kind === 'window' ? 'exterior' : (neighbor?.id ?? 'exterior'),
      side,
      offset: sideSpan(room, side).length / 2,
      width: kind === 'window' ? 1.2 : 0.9,
    })
  }
  const wallOpenings = openingsOn(room, wall.side, home.openings)
  return (
    <div className="sel-pill struct-pill">
      <span className="pill-name" title={`${room.name} · ${SIDE_LABELS[wall.side]}`}>
        {room.name} · {SIDE_LABELS[wall.side]}
      </span>
      <div className="struct-list">
        {wallOpenings.length === 0 && <span className="struct-empty">无门窗 No openings</span>}
        {wallOpenings.map((o) => (
          <span
            key={o.id}
            className="struct-opening"
            title={`${openingKindLabel(o)} · ${o.width.toFixed(2)}m`}
            onMouseEnter={() => hoverOpening(o.id)}
            onMouseLeave={() => hoverOpening(null)}
          >
            <button type="button" className="struct-opening-name" onClick={() => selectOpening(o.id)}>
              {openingKindLabel(o)} {o.width.toFixed(1)}m
            </button>
            <button type="button" className="struct-opening-del" title="删除 Delete" onClick={() => removeOpening(o.id)}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="pill-btns">
        <button type="button" className="btn btn-ghost struct-add" onClick={() => addOnSide('door')}>
          + 门 Door
        </button>
        <button type="button" className="btn btn-ghost struct-add" onClick={() => addOnSide('window')}>
          + 窗 Window
        </button>
        <button
          type="button"
          className="btn btn-ghost struct-add"
          title={neighbor ? '通高打通 Full-height opening' : '外墙变护栏半墙 Railing parapet'}
          onClick={() => addOnSide('gap')}
        >
          {neighbor ? '+ 打通 Open up' : '+ 阳台 Balcony'}
        </button>
        <span className="cam-sep" />
        <button
          type="button"
          className="btn btn-ghost struct-add"
          title="删除这堵墙：内墙整段打通，外墙整段移除，可撤销 Remove this wall: interior opens up, exterior is removed entirely (undoable)"
          onClick={() => removeWall(wall.roomId, wall.side)}
        >
          删墙 Remove wall
        </button>
      </div>
    </div>
  )
}

export default function StatusBar() {
  const [zoomPct, setZoomPct] = useState(100)
  useEffect(() => subscribeZoomPct(setZoomPct), [])

  const home = useStore((s) => s.home)
  const room = useStore((s) => s.home.rooms.find((r) => r.id === s.activeRoomId) ?? s.home.rooms[0])
  const inst = useStore((s) => s.furniture.find((f) => f.id === s.selectedId))
  const instRoomName = useStore((s) => {
    const f = s.furniture.find((it) => it.id === s.selectedId)
    return f ? (roomById(s.home, f.roomId)?.name ?? '') : ''
  })
  const duplicateFurniture = useStore((s) => s.duplicateFurniture)
  const removeFurniture = useStore((s) => s.removeFurniture)
  const storeFurniture = useStore((s) => s.storeFurniture)
  const openModal = useUI((s) => s.openModal)
  const pushToast = useUI((s) => s.pushToast)

  const roomLabel = room.name.toUpperCase()
  const visibleHome = homeForRoomLevel(home, room.id)
  const bb = homeAABB(visibleHome)
  const totalArea = home.architecture ? visibleHome.architecture!.spaces.filter(s => s.kind !== 'void' && s.kind !== 'ledge').reduce((sum, s) => sum + floorPieces(s.polygon, home.architecture!.spaces.filter(v => v.kind === 'void' && v.levelId === s.levelId).map(v => v.polygon)).reduce((area, p) => area + polygonArea(p), 0), 0) : home.rooms.reduce((sum, r) => sum + r.rect.w * r.rect.d, 0)

  const rotate = (dir: 1 | -1) => {
    const s = useStore.getState()
    const f = s.furniture.find((it) => it.id === s.selectedId)
    if (f) s.rotateFurniture(f.id, f.rotationY + dir * ROT_STEP)
  }

  return (
    <div className="statusbar">
      {inst && (
        <div className="sel-pill">
          <span className="pill-name" title={`${inst.label} · ${instRoomName}`}>
            {inst.label} · {instRoomName.toUpperCase()}
          </span>
          <div className="pill-btns">
            <IconButton title="左转 15° Rotate left" onClick={() => rotate(-1)}>
              <RotateLeftIcon />
            </IconButton>
            <IconButton title="右转 15° Rotate right" onClick={() => rotate(1)}>
              <RotateRightIcon />
            </IconButton>
            <IconButton title="复制 Duplicate" onClick={() => duplicateFurniture(inst.id)}>
              <DuplicateIcon />
            </IconButton>
            <IconButton title="换模 Swap model" onClick={() => openModal({ kind: 'swap' })}>
              <SwapIcon />
            </IconButton>
            <IconButton
              title="收进储物箱（免费，可随时摆回）Store away, free to place back"
              onClick={() => {
                storeFurniture(inst.id)
                pushToast(`已收进储物箱 Stored: ${inst.label}`)
              }}
            >
              <StoreAwayIcon />
            </IconButton>
            <IconButton title="删除 Delete（不退款 no refund）" onClick={() => removeFurniture(inst.id)}>
              ×
            </IconButton>
          </div>
        </div>
      )}
      <StructurePill />
      <div className="status-info">
        {zoomPct}% · {roomLabel} · 整宅 {bb.w.toFixed(2)} × {bb.d.toFixed(2)} M ·{' '}
        {totalArea.toFixed(1)} M²
      </div>
    </div>
  )
}
