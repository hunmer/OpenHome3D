import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { del } from 'idb-keyval'
import { useStore } from '../../state/store'
import {
  allModels,
  defaultParams,
  type Brand,
  type FurnitureType,
  type ModelDef,
} from '../../models/registry'
import { modelPrice, ownedModelIds } from '../../state/economy'
import { PARAMETRIC_COMPONENTS } from '../../models/parametric/index'
import { matchesModelSearch } from '../../models/search'
import { MODEL_BLOB_KEY } from '../../three/runtime'
import { evictThumbnail, getThumbnail } from '../../lib/thumbnails'
import { useUI } from '../uiStore'
import { Chip, CoinIcon, GhostButton, IconButton, PrimaryButton, useInView } from '../components'
import { BRAND_LABELS, TYPE_LABELS } from '../labels'

const BRANDS: Brand[] = ['BUILT-IN', 'KENNEY', 'KAYKIT', 'PETS', 'MY UPLOADS']

const TYPES: FurnitureType[] = [
  'PETS',
  'BEDS',
  'SEATING',
  'LIGHTING',
  'TABLES',
  'STORAGE',
  'KITCHEN',
  'BATHROOM',
  'DECOR',
  'OTHER',
]

export type BrandFilter = 'ALL' | Brand
export type TypeFilter = 'ALL' | FurnitureType

/** Aim the thumbnail camera at the model's approximate bbox center, once. */
function Aim({ y }: { y: number }) {
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    camera.lookAt(0, y, 0)
    invalidate()
  }, [camera, invalidate, y])
  return null
}

/** Capture after a few live frames, then report it. */
function Capture({ onShot }: { onShot: (url: string) => void }) {
  const gl = useThree((s) => s.gl)
  const frames = useRef(0)
  const done = useRef(false)
  useFrame(() => {
    if (done.current) return
    if (++frames.current >= 3) {
      done.current = true
      onShot(gl.domElement.toDataURL('image/png'))
    }
  })
  return null
}

// ---------------------------------------------------------------------------
// Parametric thumbnails: ONE shared hidden canvas renders jobs serially.
// Per-card canvases blow past the browser's ~16 WebGL context limit (the main
// scene + this modal already hold several), and evicted contexts capture as
// blank transparent PNGs — so jobs queue onto a single worker canvas instead.
// ---------------------------------------------------------------------------

const paramThumbCache = new Map<string, string>()
type ParamJob = { def: ModelDef; resolve: (url: string) => void }
const paramJobQueue: ParamJob[] = []
const paramJobPending = new Set<string>()
let paramWorkerKick: (() => void) | null = null

function requestParamThumb(def: ModelDef): Promise<string> {
  const hit = paramThumbCache.get(def.id)
  if (hit) return Promise.resolve(hit)
  return new Promise((resolve) => {
    if (!paramJobPending.has(def.id)) {
      paramJobPending.add(def.id)
      paramJobQueue.push({ def, resolve })
    } else {
      paramJobQueue.push({ def, resolve }) // extra waiter for the same id
    }
    paramWorkerKick?.()
  })
}

/** Mounted once inside ModelBrowser; invisible. Also reused by the storage box. */
export function ParamThumbWorker() {
  const [job, setJob] = useState<ParamJob | null>(null)

  // kick: pick up the next queued job when idle
  useEffect(() => {
    paramWorkerKick = () => {
      setJob((cur) => cur ?? paramJobQueue.shift() ?? null)
    }
    return () => {
      paramWorkerKick = null
    }
  }, [])

  if (!job) return null
  const { def } = job
  const Comp = PARAMETRIC_COMPONENTS[def.id]
  const h = def.height ?? 1
  const maxDim = Math.max(def.footprint[0], def.footprint[1], h)
  const d = 1.8 * maxDim

  const finish = (url: string) => {
    paramThumbCache.set(def.id, url)
    // resolve every queued waiter for this id
    const waiters = [job, ...paramJobQueue.filter((j) => j.def.id === def.id)]
    for (let i = paramJobQueue.length - 1; i >= 0; i--) {
      if (paramJobQueue[i].def.id === def.id) paramJobQueue.splice(i, 1)
    }
    paramJobPending.delete(def.id)
    waiters.forEach((j) => j.resolve(url))
    setJob(paramJobQueue.shift() ?? null)
  }

  return (
    <div style={{ position: 'absolute', width: 160, height: 160, left: -9999, top: -9999 }}>
      <Canvas
        key={def.id}
        dpr={1}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        camera={{ fov: 22, position: [d, 0.8 * d, d], near: 0.01, far: 100 }}
        style={{ background: '#fdf6e9' }}
      >
        <ambientLight intensity={0.95} />
        <directionalLight position={[3, 5, 2]} intensity={1.7} color="#fff2df" />
        <Aim y={h / 2} />
        {Comp ? <Comp params={defaultParams(def)} /> : null}
        <Capture onShot={finish} />
      </Canvas>
    </div>
  )
}

/** Parametric (built-in) thumbnail: data URL from the shared worker canvas. */
export const ParamThumb = memo(function ParamThumb({ def }: { def: ModelDef }) {
  const [url, setUrl] = useState(() => paramThumbCache.get(def.id) ?? null)
  useEffect(() => {
    if (url) return
    let ok = true
    void requestParamThumb(def).then((u) => {
      if (ok) setUrl(u)
    })
    return () => {
      ok = false
    }
  }, [def, url])
  return url ? <img src={url} alt={def.name} /> : null
})

/** GLB/upload thumbnail: data URL from the offscreen vanilla-three renderer. */
export function GlbThumb({ def }: { def: ModelDef }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let ok = true
    void getThumbnail(def).then((u) => {
      if (ok) setUrl(u)
    })
    return () => {
      ok = false
    }
  }, [def])
  return url ? <img src={url} alt={def.name} /> : null
}

/** Lazy in-view thumbnail cell shared by the browser and the storage box cards. */
export function CardThumb({ def }: { def: ModelDef }) {
  const { ref, inView } = useInView<HTMLDivElement>()
  return (
    <div className="card-thumb" ref={ref}>
      {inView && (def.kind === 'parametric' ? <ParamThumb def={def} /> : <GlbThumb def={def} />)}
    </div>
  )
}

/** Brand/type chip rows shared by the model browser and the storage box. */
export function BrowserFilters({
  brand,
  onBrand,
  type,
  onType,
  brandCount,
  typeCount,
}: {
  brand: BrandFilter
  onBrand: (b: BrandFilter) => void
  type: TypeFilter
  onType: (t: TypeFilter) => void
  brandCount: (b: BrandFilter) => number
  typeCount: (t: TypeFilter) => number
}) {
  return (
    <div className="filters">
      <div className="filter-row">
        <span className="lbl filter-label">品牌 Brand</span>
        <div className="chips">
          <Chip label="全部 All" count={brandCount('ALL')} active={brand === 'ALL'} onClick={() => onBrand('ALL')} />
          {BRANDS.map((b) => (
            <Chip
              key={b}
              label={BRAND_LABELS[b]}
              count={brandCount(b)}
              active={brand === b}
              onClick={() => onBrand(b)}
            />
          ))}
        </div>
      </div>
      <div className="filter-row">
        <span className="lbl filter-label">类型 Type</span>
        <div className="chips">
          <Chip label="全部 All" count={typeCount('ALL')} active={type === 'ALL'} onClick={() => onType('ALL')} />
          {TYPES.map((t) => (
            <Chip
              key={t}
              label={TYPE_LABELS[t]}
              count={typeCount(t)}
              active={type === t}
              onClick={() => onType(t)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Card({
  def,
  mode,
  current,
  price,
  owned,
  onPick,
  onDelete,
}: {
  def: ModelDef
  mode: 'swap' | 'add'
  current: boolean
  /** Placement price in coins (0 = free, uploads). */
  price: number
  /** In the ownership catalog: auto-layout may place it. */
  owned: boolean
  onPick: () => void
  onDelete?: () => void
}) {
  return (
    <div
      className={`card${current ? ' current' : ''}`}
      onClick={onPick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onPick()
      }}
      title={def.name}
    >
      <CardThumb def={def} />
      <div className="card-name">
        {def.name}
        {owned && (
          <span className="card-owned" title="已收录：自动布置可用 In catalog: auto-layout can use it">
            ✓
          </span>
        )}
      </div>
      <span className={`card-price${price === 0 ? ' free' : ''}`} title={price === 0 ? '免费摆放 Free to place' : `摆放需 ${price} 金币 Place for ${price} coins`}>
        {price === 0 ? '免费 free' : <><CoinIcon size={10} /> {price}</>}
      </span>
      {mode === 'swap' && current && <span className="card-badge">✓</span>}
      {onDelete && (
        <button
          type="button"
          className="card-del"
          title={`Delete ${def.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

export default function ModelBrowser({ mode }: { mode: 'swap' | 'add' }) {
  const closeModal = useUI((s) => s.closeModal)
  const openUpload = useUI((s) => s.openUpload)
  const pushToast = useUI((s) => s.pushToast)
  const uploads = useStore((s) => s.uploads) // re-render on upload add/remove
  const selectedId = useStore((s) => s.selectedId)
  const swapModel = useStore((s) => s.swapModel)
  const addFurniture = useStore((s) => s.addFurniture)
  const removeUpload = useStore((s) => s.removeUpload)
  const coins = useStore((s) => s.coins)
  const unlocked = useStore((s) => s.unlocked)
  const furniture = useStore((s) => s.furniture)
  const storage = useStore((s) => s.storage)
  void uploads

  const [search, setSearch] = useState('')
  const [brand, setBrand] = useState<BrandFilter>(() => useUI.getState().forcedBrand ?? 'ALL')
  const [type, setType] = useState<TypeFilter>('ALL')
  /** Paid pick awaiting confirmation in the bottom bar. */
  const [pending, setPending] = useState<ModelDef | null>(null)

  // the browser reopens with MY UPLOADS active after an upload — consume that once
  useEffect(() => {
    useUI.getState().consumeForcedBrand()
  }, [])

  const models = allModels()
  const owned = useMemo(
    () => ownedModelIds({ unlocked, furniture, storage, uploads }),
    [unlocked, furniture, storage, uploads],
  )
  const matchSearch = (m: ModelDef) => matchesModelSearch(m, search)
  const brandFiltered = models.filter((m) => (brand === 'ALL' || m.brand === brand) && matchSearch(m))
  const visible = brandFiltered.filter((m) => type === 'ALL' || m.type === type)

  const brandCount = (b: BrandFilter) =>
    b === 'ALL' ? models.length : models.filter((m) => m.brand === b).length
  const typeCount = (t: TypeFilter) =>
    t === 'ALL' ? brandFiltered.length : brandFiltered.filter((m) => m.type === t).length

  const currentModelId = useStore((s) =>
    mode === 'swap' ? s.furniture.find((f) => f.id === s.selectedId)?.modelId : undefined,
  )

  const place = (def: ModelDef, price: number) => {
    if (mode === 'swap') {
      if (selectedId) {
        swapModel(selectedId, def.id)
        pushToast(
          price > 0
            ? `已花费 ${price} 金币换模 Swapped for ${def.name}`
            : `已换模 Swapped for ${def.name}`,
        )
      }
    } else {
      addFurniture(def.id)
      if (def.type === 'PETS') {
        pushToast(
          price > 0
            ? `已花费 ${price} 金币领养 — 点击它播放动画 Adopted — click it to play`
            : '已领养 — 点击它播放动画 Adopted — click it to play',
        )
      } else {
        pushToast(
          price > 0
            ? `已花费 ${price} 金币摆放 — 拖拽放置 Spent ${price} coins — drag to place`
            : '已添加 — 拖拽放置 Added, drag to place',
        )
      }
    }
    closeModal()
  }

  const pick = (def: ModelDef) => {
    if (modelPrice(def) === 0) {
      place(def, 0)
      return
    }
    setPending(def)
  }

  const confirmPending = () => {
    if (!pending) return
    place(pending, modelPrice(pending))
  }

  const deleteUpload = (def: ModelDef) => {
    removeUpload(def.id)
    void del(MODEL_BLOB_KEY(def.id))
    evictThumbnail(def.id)
    pushToast(`已移除 Removed: ${def.name}`)
  }

  const pendingPrice = pending ? modelPrice(pending) : 0
  const affordable = pendingPrice <= coins

  return (
    <div className="modal-overlay">
      <div className="modal-panel" data-modal="">
        <div className="modal-head">
          <span className="modal-title">{mode === 'swap' ? '换模 Swap model' : '添加家具 Add furniture'}</span>
          <input
            className="input search"
            placeholder="搜索模型 Search models…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <GhostButton onClick={() => openUpload(mode)}>+ 上传模型 Upload model</GhostButton>
          <IconButton title="关闭 Close" onClick={() => closeModal()}>
            ×
          </IconButton>
        </div>

        <BrowserFilters
          brand={brand}
          onBrand={setBrand}
          type={type}
          onType={setType}
          brandCount={brandCount}
          typeCount={typeCount}
        />

        <div className="mb-grid">
          <ParamThumbWorker />
          {visible.map((def) => (
            <Card
              key={def.id}
              def={def}
              mode={mode}
              current={def.id === currentModelId}
              price={modelPrice(def)}
              owned={owned.has(def.id)}
              onPick={() => pick(def)}
              onDelete={def.kind === 'upload' ? () => deleteUpload(def) : undefined}
            />
          ))}
          {visible.length === 0 && (
            <p className="hint" style={{ gridColumn: '1 / -1' }}>
              没有匹配的模型 No models match these filters.
            </p>
          )}
        </div>

        {pending && (
          <div className="mb-confirm">
            <CoinIcon />
            <span className="mb-confirm-text">
              {mode === 'swap' ? '换成' : '摆放'}「{pending.name}」· {pendingPrice} 金币
              {owned.has(pending.id) ? '' : ' · 首次购买收录 Catalog on first buy'}
            </span>
            <GhostButton onClick={() => setPending(null)}>取消 Cancel</GhostButton>
            <PrimaryButton disabled={!affordable} onClick={confirmPending}>
              {affordable
                ? `花费 ${pendingPrice} ${mode === 'swap' ? '更换' : '摆放'} Spend`
                : `还差 ${pendingPrice - coins} 金币 Need more`}
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  )
}
