import { useEffect, useState, type ReactNode } from 'react'
import { useStore, type PlanTab } from '../state/store'
import { ROOM_TYPES } from '../gen/roomTypes'
import { useUI, type SidebarPanel } from './uiStore'
import SelectionPanel from './SelectionPanel'
import HomeTab from './HomeTab'
import ProjectFiles from './ProjectFiles'
import { GhostButton, NumberInput, PrimaryButton, Section, SegmentedTabs, Slider } from './components'

const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** 方案 Plan: outer wall with an inner partition and a doorway gap. */
function PlanIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <path d="M2.5 2.5 H13.5 V13.5 H2.5 Z" />
      <path d="M8 2.5 V6 M8 9 V13.5 M8 9 H13.5" />
    </svg>
  )
}

/** 家具 Furniture: couch — seat, backrest, arms. */
function SofaIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <path d="M2 9 H14 V12.5 H2 Z" />
      <path d="M2 9 V6.8 M14 9 V6.8 M4.5 6.8 V4.5 H11.5 V6.8" />
    </svg>
  )
}

/** 工程 Files: project folder. */
function FilesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <path d="M2 4 H6.5 L8 5.5 H14 V12.5 H2 Z" />
    </svg>
  )
}

/** 选中 Selection: pointer cursor. */
function SelectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <path d="M4.5 2.5 L12 8.7 L8.9 9.3 L10.7 13 L9 13.8 L7.2 10.1 L4.5 12.3 Z" />
    </svg>
  )
}

/**
 * Rail entry card: picks the panel shown beside the rail (and re-expands a
 * collapsed sidebar). The rail itself stays mounted in every sidebar state.
 */
function RailButton({
  panel,
  label,
  active,
  disabled,
  dot,
  children,
}: {
  panel: SidebarPanel
  label: string
  active: boolean
  disabled?: boolean
  /** Selection marker: something in the scene is selected. */
  dot?: boolean
  children: ReactNode
}) {
  const setPanel = useUI((s) => s.setPanel)
  return (
    <button
      type="button"
      data-panel={panel}
      className={`rail-btn${active ? ' active' : ''}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={() => setPanel(panel)}
    >
      {children}
      {dot && <span className="rail-dot" aria-hidden="true" />}
    </button>
  )
}

const PLAN_TABS: { value: PlanTab; label: string }[] = [
  { value: 'home', label: '整宅 Home' },
  { value: 'room', label: '房间 Room' },
]

/** 房间 Room tab: edits the ACTIVE room's contents (structure/openings live in the Home tab). */
function RoomTab() {
  const architecture = useStore(s=>s.home.architecture)
  const room = useStore((s) => s.home.rooms.find((r) => r.id === s.activeRoomId) ?? s.home.rooms[0])
  const setRoomType = useStore((s) => s.setRoomType)
  const setRoomRect = useStore((s) => s.setRoomRect)
  const setPlanTab = useStore((s) => s.setPlanTab)
  const newRoom = useStore((s) => s.newRoom)
  const [confirmNew, setConfirmNew] = useState(false)
  const reshuffleFurniture = useStore((s) => s.reshuffleFurniture)
  const wallHeight = useStore((s) => s.wallHeight)
  const setRoomPartition = useStore((s) => s.setRoomPartition)

  const partitionHeight = room.partitionHeight
  const partitionUnit =
    partitionHeight === 0 ? '无 none' : partitionHeight === wallHeight ? '通高 full' : 'm'

  if (architecture) return <>
    <p className="caption">{room.name} · 精确轮廓 Precision outline · 结构在整宅面板编辑 Structure edits in Home</p>
    <div className="btn-row"><GhostButton onClick={()=>setPlanTab('home')}>结构参数 Structure</GhostButton><GhostButton onClick={()=>reshuffleFurniture()}>换一换 Shuffle</GhostButton></div>
  </>

  return (
    <>
      {/* label + link already fill the row, so the value wraps to its own line:
          the name ellipsizes (title tooltip) and the link stays whole */}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="row-label">当前房间 Room</span>
        <span
          className="row-value"
          style={{ flex: '1 1 100%', minWidth: 0, justifyContent: 'space-between' }}
        >
          <span
            title={room.name}
            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {room.name}
          </span>
          <button type="button" className="link-btn" onClick={() => setPlanTab('home')}>
            在整宅中编辑 Edit in Home
          </button>
        </span>
      </div>
      <div className="row">
        <span className="row-label">房间类型 Room type</span>
        <span className="row-value" style={{ flex: 1, maxWidth: 132 }}>
          <select
            className="input"
            value={room.type}
            onChange={(e) => setRoomType(e.target.value)}
          >
            {ROOM_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </span>
      </div>
      <NumberInput
        label="面宽 Width"
        value={room.rect.w}
        min={1.5}
        max={12}
        step={0.05}
        unit="m"
        onCommit={(v) => setRoomRect(room.id, { ...room.rect, w: v })}
      />
      <NumberInput
        label="进深 Depth"
        value={room.rect.d}
        min={1.5}
        max={12}
        step={0.05}
        unit="m"
        onCommit={(v) => setRoomRect(room.id, { ...room.rect, d: v })}
      />
      <NumberInput
        label="隔墙 Partition"
        value={partitionHeight}
        min={0}
        max={5}
        step={0.05}
        unit={partitionUnit}
        onCommit={(v) => setRoomPartition(v)}
      />
      <p className="caption">扩建 10 金币/m²，缩小免费 Expand 10 coins/m²</p>
      <div className="btn-row">
        <GhostButton onClick={() => setConfirmNew(true)}>新建方案 New plan</GhostButton>
        <GhostButton onClick={() => reshuffleFurniture()}>换一换 Shuffle</GhostButton>
      </div>
      {confirmNew && (
        <div>
          <p className="caption">将替换整宅和家具；金币与储物箱保留。Replaces plan & furniture; coins and storage are kept.</p>
          <div className="btn-row">
            <PrimaryButton onClick={() => { newRoom(); setConfirmNew(false) }}>确认覆盖 Confirm replace</PrimaryButton>
            <GhostButton onClick={() => setConfirmNew(false)}>取消 Cancel</GhostButton>
          </div>
        </div>
      )}
    </>
  )
}

function GitHubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

export default function Sidebar() {
  const collapsed = useUI((s) => s.collapsed)
  const activePanel = useUI((s) => s.activePanel)
  const openModal = useUI((s) => s.openModal)
  const pushToast = useUI((s) => s.pushToast)
  const selectedId = useStore((s) => s.selectedId)
  const planTab = useStore((s) => s.planTab)
  const setPlanTab = useStore((s) => s.setPlanTab)

  const extras = useStore((s) => s.extras)
  const setExtras = useStore((s) => s.setExtras)
  const storageCount = useStore((s) => s.storage.length)

  const structureNotice = useStore(s => s.structureNotice)
  const dismissStructureNotice = useStore(s => s.dismissStructureNotice)
  useEffect(() => {
    if (!structureNotice) return
    pushToast(structureNotice)
    dismissStructureNotice()
  }, [structureNotice, pushToast, dismissStructureNotice])

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-inner">
        {/* vertical card rail: always visible, collapsed sidebar = rail only */}
        <nav className="sb-rail" aria-label="侧栏功能 Sidebar panels">
          <RailButton panel="plan" label="方案 Plan" active={activePanel === 'plan'}>
            <PlanIcon />
          </RailButton>
          <RailButton panel="furniture" label="家具 Furniture" active={activePanel === 'furniture'}>
            <SofaIcon />
          </RailButton>
          <RailButton panel="files" label="工程 Files" active={activePanel === 'files'}>
            <FilesIcon />
          </RailButton>
          <RailButton
            panel="selection"
            label="选中 Selection"
            active={activePanel === 'selection'}
            disabled={!selectedId}
            dot={!!selectedId}
          >
            <SelectIcon />
          </RailButton>
        </nav>

        <div className="sb-main">
          <div className="sb-header">
            <img className="sb-logo" src={`${import.meta.env?.BASE_URL ?? '/'}brand/logo-header.webp`} alt="家居生成器 logo" />
            <span className="sb-title">家居生成器</span>
            <span className="sb-axo">Cartoon</span>
            <a
              className="icon-btn sb-github"
              href="https://github.com/yuyou-dev/OpenHome3D"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub 仓库 Repository"
            >
              <GitHubIcon />
            </a>
          </div>

          {/* panels stay mounted (hidden ones via [hidden]) so DOM-driven
              regressions keep finding their inputs and buttons */}
          <div className="sb-panel" hidden={activePanel !== 'plan'}>
            <Section title="方案 Plan">
              <div style={{ marginBottom: 10 }}>
                <SegmentedTabs options={PLAN_TABS} value={planTab} onChange={setPlanTab} />
              </div>
              {planTab === 'room' && <RoomTab />}
              {planTab === 'home' && <HomeTab />}
            </Section>
          </div>

          <div className="sb-panel" hidden={activePanel !== 'furniture'}>
            <Section title="家具 Furniture">
              <Slider
                label="装饰密度 Extras"
                value={extras}
                min={0}
                max={100}
                step={1}
                display={`${extras}%`}
                onChange={setExtras}
              />
              <div className="btn-row">
                <GhostButton onClick={() => openModal({ kind: 'add' })}>+ 添加家具 Add furniture</GhostButton>
              </div>
              <div className="btn-row">
                <GhostButton onClick={() => openModal({ kind: 'storage' })}>
                  储物箱 Storage{storageCount > 0 ? ` (${storageCount})` : ''}
                </GhostButton>
              </div>
            </Section>
          </div>

          <div className="sb-panel" hidden={activePanel !== 'files'}>
            <Section title="工程 Files">
              <ProjectFiles />
            </Section>
            <a
              className="link-btn sb-feedback"
              href="https://github.com/yuyou-dev/OpenHome3D/issues/new/choose"
              target="_blank"
              rel="noopener noreferrer"
            >
              反馈 Feedback ↗
            </a>
          </div>

          <div className="sb-panel" hidden={activePanel !== 'selection'}>
            {selectedId ? (
              <SelectionPanel />
            ) : (
              <p className="caption">未选中家具；在场景中点击家具后可在此编辑 Nothing selected</p>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
