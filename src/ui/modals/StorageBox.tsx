import { useState } from 'react'
import { useStore } from '../../state/store'
import { getModel, type FurnitureInstance, type ModelDef } from '../../models/registry'
import { roomById } from '../../state/home'
import { matchesModelSearch } from '../../models/search'
import { useUI } from '../uiStore'
import { GhostButton, IconButton } from '../components'
import {
  BrowserFilters,
  CardThumb,
  ParamThumbWorker,
  type BrandFilter,
  type TypeFilter,
} from './ModelBrowser'

/**
 * 储物箱 Storage box: furniture stashed from the status bar. Reuses the model
 * browser's filter UI (search + brand/type chips) over stored instances;
 * placing an item back is free, preferring the original room and falling back
 * to the active room when it no longer exists.
 */
export default function StorageBox() {
  const closeModal = useUI((s) => s.closeModal)
  const pushToast = useUI((s) => s.pushToast)
  const storage = useStore((s) => s.storage)
  const home = useStore((s) => s.home)
  const placeFromStorage = useStore((s) => s.placeFromStorage)

  const [search, setSearch] = useState('')
  const [brand, setBrand] = useState<BrandFilter>('ALL')
  const [type, setType] = useState<TypeFilter>('ALL')

  const items = storage.map((inst: FurnitureInstance): { inst: FurnitureInstance; def?: ModelDef } => ({
    inst,
    def: getModel(inst.modelId),
  }))
  const q = search.trim().toLowerCase()
  const searchFiltered = items.filter(
    ({ inst, def }) => (def ? matchesModelSearch(def, search) : false) || inst.label.toLowerCase().includes(q),
  )
  const brandFiltered = searchFiltered.filter(({ def }) => brand === 'ALL' || def?.brand === brand)
  const visible = brandFiltered.filter(({ def }) => type === 'ALL' || def?.type === type)

  const brandCount = (b: BrandFilter) =>
    b === 'ALL' ? items.length : items.filter(({ def }) => def?.brand === b).length
  const typeCount = (t: TypeFilter) =>
    t === 'ALL' ? brandFiltered.length : brandFiltered.filter(({ def }) => def?.type === t).length

  return (
    <div className="modal-overlay">
      <div className="modal-panel" data-modal="">
        <div className="modal-head">
          <span className="modal-title">储物箱 Storage</span>
          <input
            className="input search"
            placeholder="搜索 Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <span className="caption">{storage.length} 件 · 摆放免费 free to place</span>
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
          {visible.map(({ inst, def }) => {
            const room = roomById(home, inst.roomId)
            return (
              <div className="card" key={inst.id} title={inst.label}>
                {def && <CardThumb def={def} />}
                <div className="card-name">{inst.label}</div>
                <div className="caption card-room">
                  {room ? room.name : '原房间已删 original room gone'}
                </div>
                <GhostButton
                  className="card-place"
                  onClick={() => {
                    placeFromStorage(inst.id)
                    pushToast(`已摆放 Placed: ${inst.label}`)
                  }}
                >
                  摆放 Place
                </GhostButton>
              </div>
            )
          })}
          {visible.length === 0 && (
            <p className="hint" style={{ gridColumn: '1 / -1' }}>
              {storage.length === 0
                ? '储物箱是空的：选中家具后点状态栏「收进储物箱」。Empty — store items from the status bar.'
                : '没有匹配的储物 No stored items match these filters.'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
