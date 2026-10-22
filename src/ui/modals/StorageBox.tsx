import { useStore } from '../../state/store'
import { getModel } from '../../models/registry'
import { roomById } from '../../state/home'
import { useUI } from '../uiStore'
import { GhostButton, IconButton } from '../components'
import { GlbThumb, ParamThumb, ParamThumbWorker } from './ModelBrowser'

/**
 * 储物箱 Storage box: furniture stashed from the status bar. Placing an item
 * back is free; the original room is preferred and falls back to the active
 * room when it no longer exists.
 */
export default function StorageBox() {
  const closeModal = useUI((s) => s.closeModal)
  const pushToast = useUI((s) => s.pushToast)
  const storage = useStore((s) => s.storage)
  const home = useStore((s) => s.home)
  const placeFromStorage = useStore((s) => s.placeFromStorage)

  return (
    <div className="modal-overlay">
      <div className="modal-panel" data-modal="">
        <div className="modal-head">
          <span className="modal-title">储物箱 Storage</span>
          <span className="caption">{storage.length} 件 · 摆放免费 free to place</span>
          <IconButton title="关闭 Close" onClick={() => closeModal()}>
            ×
          </IconButton>
        </div>
        <div className="mb-grid">
          <ParamThumbWorker />
          {storage.map((inst) => {
            const def = getModel(inst.modelId)
            const room = roomById(home, inst.roomId)
            return (
              <div className="card" key={inst.id} title={inst.label}>
                <div className="card-thumb">
                  {def && (def.kind === 'parametric' ? <ParamThumb def={def} /> : <GlbThumb def={def} />)}
                </div>
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
          {storage.length === 0 && (
            <p className="hint" style={{ gridColumn: '1 / -1' }}>
              储物箱是空的：选中家具后点状态栏「收进储物箱」。Empty — store items from the status bar.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
