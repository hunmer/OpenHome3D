import { create } from 'zustand'
import type { Brand } from '../models/registry'

/** Which modal is currently on top. `swap`/`add` = model browser, `upload` nests above it. */
export type ActiveModal =
  | { kind: 'swap' | 'add' }
  | { kind: 'upload' }
  | { kind: 'ai' }
  | { kind: 'storage' }

/** Sidebar panel shown next to the always-visible icon rail. */
export type SidebarPanel = 'plan' | 'furniture' | 'files' | 'selection'

export interface Toast {
  id: number
  text: string
  leaving?: boolean
}

interface UIState {
  activeModal: ActiveModal | null
  /** Browser kind to reopen beneath/after the upload modal. */
  returnTo: 'swap' | 'add' | null
  /** Brand chip to force-active when the browser reopens after an upload. */
  forcedBrand: Brand | null
  /** Sidebar collapsed to the icon rail (edge tab in AppUI). */
  collapsed: boolean
  /** Sidebar panel shown beside the rail; rail picks stay session-only. */
  activePanel: SidebarPanel
  /** Pan mode: drag pans the camera instead of orbiting (TopBar toggle; session-only). */
  panMode: boolean
  /** Move mode: dragging furniture moves it instead of orbiting the camera (TopBar toggle; session-only). */
  moveMode: boolean
  /** Collapsible Section open state, keyed by section title; session-only. */
  sectionOpen: Record<string, boolean>
  /** Opening hovered in the status-bar chip list; the 3D shell shows a ghost highlight (session-only). */
  hoveredOpeningId: string | null
  toasts: Toast[]

  openModal: (m: ActiveModal) => void
  closeModal: () => void
  /** Open the upload modal on top of the model browser it was launched from. */
  openUpload: (from: 'swap' | 'add') => void
  /** Close the upload modal; `added` returns to the browser with MY UPLOADS active. */
  closeUpload: (added: boolean) => void
  consumeForcedBrand: () => Brand | null
  toggleCollapsed: () => void
  /** Switch the panel beside the rail; picking one while collapsed re-expands the sidebar. */
  setPanel: (panel: SidebarPanel) => void
  togglePanMode: () => void
  toggleMoveMode: () => void
  toggleSection: (title: string) => void
  /** Highlight this opening in the 3D shell (null clears); driven by status-bar chip hover. */
  hoverOpening: (id: string | null) => void
  pushToast: (text: string) => void
}

let toastId = 0

export const useUI = create<UIState>()((set, get) => ({
  activeModal: null,
  returnTo: null,
  forcedBrand: null,
  // phones start with the sidebar drawer closed (it overlays the canvas there)
  collapsed: typeof window !== 'undefined' && window.innerWidth <= 720,
  activePanel: 'plan',
  panMode: false,
  // furniture drag-move is opt-in: without it a drag on furniture orbits the camera
  moveMode: false,
  sectionOpen: {},
  hoveredOpeningId: null,
  toasts: [],

  openModal: (m) =>
    set(m.kind === 'upload' ? { activeModal: m } : { activeModal: m, returnTo: null, forcedBrand: null }),

  closeModal: () => set({ activeModal: null, returnTo: null, forcedBrand: null }),

  openUpload: (from) => set({ activeModal: { kind: 'upload' }, returnTo: from }),

  closeUpload: (added) =>
    set((s) => ({
      activeModal: s.returnTo ? { kind: s.returnTo } : null,
      returnTo: null,
      forcedBrand: added ? 'MY UPLOADS' : null,
    })),

  consumeForcedBrand: () => {
    const b = get().forcedBrand
    if (b) set({ forcedBrand: null })
    return b
  },

  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),

  setPanel: (panel) => set({ activePanel: panel, collapsed: false }),

  togglePanMode: () => set((s) => ({ panMode: !s.panMode })),

  toggleMoveMode: () => set((s) => ({ moveMode: !s.moveMode })),

  toggleSection: (title) =>
    set((s) => ({ sectionOpen: { ...s.sectionOpen, [title]: !(s.sectionOpen[title] ?? true) } })),

  hoverOpening: (id) => set({ hoveredOpeningId: id }),

  pushToast: (text) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, text }] }))
    // auto-expire: fade out after 3s, remove after the exit animation
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }))
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, 280)
    }, 3000)
  },
}))
