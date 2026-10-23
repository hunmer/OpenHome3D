import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { aiRender, historyAdd, type AiHttpConfig, type RenderMeta, type RenderRecord } from '../lib/ai'
import { useUI } from '../ui/uiStore'

/** First-run seed for the default preset. */
export const AI_HTTP_DEFAULTS: AiHttpConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-image-1',
}

/** One saved image-API provider preset; the whole list persists in localStorage. */
export interface AiPreset extends AiHttpConfig {
  id: string
  name: string
}

const DEFAULT_PRESET: AiPreset = { id: 'openai', name: 'OpenAI', ...AI_HTTP_DEFAULTS }

/** Live values of the preset editor (what renders actually use). */
export type ApiDraft = AiHttpConfig & { name: string }

interface RenderForm {
  prompt: string | null
  format: string
  framing: 'fit' | 'editor'
  presets: Record<string, string>
  api: ApiDraft
}

export interface RenderInput {
  image: string
  prompt: string
  images: string[]
  aspect: string
  seed: string
  presets: string[]
  api: AiHttpConfig
}

interface AiTaskState {
  phase: 'idle' | 'preparing' | 'running' | 'saving' | 'done' | 'error'
  error: string | null
  result: { meta: RenderMeta; record: RenderRecord } | null
  historyRevision: number
  form: RenderForm
  /** saved provider presets (incl. API keys) — the only persisted slice */
  presets: AiPreset[]
  activePresetId: string | null
  updateForm: (patch: Partial<RenderForm>) => void
  selectPreset: (id: string | null) => void
  newPresetDraft: () => void
  savePreset: () => void
  deletePreset: (id: string) => void
  setResult: (result: AiTaskState['result']) => void
  start: (prepare: () => Promise<RenderInput>) => Promise<void>
  cancel: () => void
}

// The owner lives outside React so closing the panel neither drops a task nor
// lets a stale completion replace the result of a later task.
let owner: AbortController | null = null

export const useAiTask = create<AiTaskState>()(
  persist(
    (set, get) => ({
      phase: 'idle',
      error: null,
      result: null,
      historyRevision: 0,
      form: { prompt: null, format: 'match view', framing: 'fit', presets: {}, api: { name: DEFAULT_PRESET.name, ...AI_HTTP_DEFAULTS } },
      presets: [DEFAULT_PRESET],
      activePresetId: DEFAULT_PRESET.id,
      updateForm: (patch) => set((s) => ({ form: { ...s.form, ...patch } })),
      // null clears the editor for an unsaved draft; an id loads that preset into it.
      selectPreset: (id) => {
        const preset = id ? get().presets.find((p) => p.id === id) : null
        set((s) => ({
          activePresetId: id,
          form: preset
            ? { ...s.form, api: { name: preset.name, baseUrl: preset.baseUrl, apiKey: preset.apiKey, model: preset.model } }
            : { ...s.form, api: { name: '', baseUrl: '', apiKey: '', model: '' } },
        }))
      },
      // Start a new preset from the current values (name cleared) — user edits then saves.
      newPresetDraft: () =>
        set((s) => ({ activePresetId: null, form: { ...s.form, api: { ...s.form.api, name: '' } } })),
      savePreset: () => {
        const { presets, activePresetId, form } = get()
        const { name, ...rest } = form.api
        const saved: AiPreset = {
          id: activePresetId ?? `p${crypto.randomUUID()}`,
          name: name.trim() || `预设 Preset ${presets.length + 1}`,
          baseUrl: rest.baseUrl.trim(),
          apiKey: rest.apiKey.trim(),
          model: rest.model.trim(),
        }
        set({
          presets: presets.some((p) => p.id === saved.id)
            ? presets.map((p) => (p.id === saved.id ? saved : p))
            : [...presets, saved],
          activePresetId: saved.id,
          form: { ...form, api: { name: saved.name, baseUrl: saved.baseUrl, apiKey: saved.apiKey, model: saved.model } },
        })
      },
      deletePreset: (id) => {
        const { presets, activePresetId } = get()
        const next = presets.filter((p) => p.id !== id)
        if (next.length === presets.length) return
        set({ presets: next })
        if (activePresetId === id) get().selectPreset(next[0]?.id ?? null)
      },
      setResult: (result) => set({ result }),
      start: async (prepare) => {
        if (owner) return
        const ctrl = new AbortController()
        owner = ctrl
        const current = () => owner === ctrl && !ctrl.signal.aborted
        set({ phase: 'preparing', error: null })
        try {
          const input = await prepare()
          if (!current()) return
          set({ phase: 'running' })
          const response = await aiRender({
            image: input.image,
            prompt: input.prompt,
            images: input.images,
            aspect: input.aspect,
            ...input.api,
            signal: ctrl.signal,
          })
          if (!current()) return
          if (!response.ok) {
            if (response.code === 'cancelled') {
              set({ phase: 'idle' })
              useUI.getState().pushToast('渲染已取消 Render cancelled')
              return
            }
            throw new Error(response.error)
          }
          const meta: RenderMeta = {
            id: `r${crypto.randomUUID()}`,
            ts: Date.now(),
            model: response.model,
            aspect: response.aspect,
            durationMs: response.durationMs,
            seed: input.seed,
            presets: input.presets,
          }
          const record: RenderRecord = {
            version: 1,
            image: response.image,
            source: input.image,
            prompt: input.prompt,
            referenceImages: input.images,
          }
          // Keep the finished image available even when the browser storage is full.
          set({ result: { meta, record }, phase: 'saving' })
          try {
            await historyAdd(meta, record)
            set((s) => ({ historyRevision: s.historyRevision + 1 }))
          } catch {
            if (current()) set({ error: '效果图已完成，但历史保存失败，请下载图片 Render ready; history could not be saved. Download the image.' })
          }
          set({ phase: 'done' })
          if (current()) useUI.getState().pushToast(`完成 Done · ${(response.durationMs / 1000).toFixed(1)} s`)
        } catch (error) {
          if (!current()) return
          const message = error instanceof Error ? error.message : String(error)
          set({ phase: 'error', error: message })
          useUI.getState().pushToast(`渲染失败 Render failed: ${message}`)
        } finally {
          if (owner === ctrl) owner = null
        }
      },
      cancel: () => {
        if (!owner || (get().phase !== 'preparing' && get().phase !== 'running')) return
        owner.abort() // the server aborts the upstream request on disconnect
        owner = null
        set({ phase: 'idle', error: null })
        useUI.getState().pushToast('已取消 Cancelled')
      },
    }),
    {
      name: 'openhome3d.ai',
      version: 1,
      partialize: (s) => ({ presets: s.presets, activePresetId: s.activePresetId }),
    },
  ),
)

// Rehydrated presets arrive synchronously from localStorage; load the saved
// selection into the editor draft so a reload never resets the provider.
{
  const { presets, activePresetId, selectPreset } = useAiTask.getState()
  const active = presets.find((p) => p.id === activePresetId)
  if (active) selectPreset(active.id)
}
