import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { useUI } from './uiStore'

/* ---------------------------------------------------------------------------
   Shared UI primitives — see styles.css for the class conventions.
--------------------------------------------------------------------------- */

/** Label left, right-aligned control/value. */
export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{children}</span>
    </div>
  )
}

interface NumberInputProps {
  label: ReactNode
  value: number
  onCommit: (v: number) => void
  min?: number
  max?: number
  step?: number
  /** Decimals shown while not editing (default 2). */
  digits?: number
  /** Unit / suffix rendered after the input (may be a node, e.g. "none"/"full"). */
  unit?: ReactNode
}

/**
 * Number row: label left, right-aligned input with muted unit.
 * Commits on blur or Enter; external value changes re-sync while unfocused.
 */
export function NumberInput({
  label,
  value,
  onCommit,
  min,
  max,
  step,
  digits = 2,
  unit,
}: NumberInputProps) {
  const [text, setText] = useState<string | null>(null)

  const commit = (raw: string) => {
    setText(null)
    const v = parseFloat(raw)
    if (Number.isNaN(v)) return
    let c = v
    if (min !== undefined) c = Math.max(min, c)
    if (max !== undefined) c = Math.min(max, c)
    if (c !== value) onCommit(c)
  }

  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value num-input">
        <input
          type="number"
          value={text ?? value.toFixed(digits)}
          min={min}
          max={max}
          step={step}
          onFocus={(e) => setText(e.target.value)}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        {unit !== undefined && <span className="unit">{unit}</span>}
      </span>
    </div>
  )
}

interface SliderProps {
  label?: ReactNode
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  /** Formatted right-hand value, e.g. "85%". Defaults to the raw value. */
  display?: ReactNode
}

export function Slider({ label, value, min, max, step, onChange, display }: SliderProps) {
  const slider = (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(parseFloat(e.target.value))}
    />
  )
  if (label === undefined) {
    return (
      <div className="slider">
        {slider}
        <span className="slider-value">{display ?? value}</span>
      </div>
    )
  }
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value slider" style={{ flex: 1, minWidth: 0 }}>
        {slider}
        <span className="slider-value">{display ?? value}</span>
      </span>
    </div>
  )
}

/** Square checkbox, black fill with white check when on. */
export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="cbx">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="cbx-box" />
      <span>{label}</span>
    </label>
  )
}

/** Sidebar section. With `collapsible`, the ⌄ chevron toggles the body; open state lives in uiStore (session-only, keyed by title). Open by default. */
export function Section({
  title,
  children,
  collapsible = false,
  defaultOpen = true,
  right,
}: {
  title: string
  children: ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
  /** Muted node pinned to the header's right edge (e.g. a room name). */
  right?: ReactNode
}) {
  const storedOpen = useUI((s) => s.sectionOpen[title])
  const toggleSection = useUI((s) => s.toggleSection)
  const open = collapsible ? (storedOpen ?? defaultOpen) : true
  return (
    <div className={`sec${open ? '' : ' closed'}`}>
      <button
        type="button"
        className={`sec-head${collapsible ? '' : ' static'}`}
        onClick={collapsible ? () => toggleSection(title) : undefined}
      >
        <span className="sec-chevron">⌄</span>
        <span>{title}</span>
        {right !== undefined && <span className="sec-right">{right}</span>}
      </button>
      <div className="sec-body">{children}</div>
    </div>
  )
}

/** HOME/ROOM/LIBRARY style tabs: white background, active = black with white text. */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`seg-btn${o.value === value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Pill filter chip with an optional count. */
export function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count?: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`chip${active ? ' active' : ''}`} onClick={onClick}>
      {label}
      {count !== undefined && <span className="chip-n">{count}</span>}
    </button>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }

/** Black primary button. */
export function PrimaryButton({ children, className, ...rest }: ButtonProps) {
  return (
    <button type="button" className={`btn btn-primary${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </button>
  )
}

/** Thin outlined ghost button. */
export function GhostButton({ children, className, ...rest }: ButtonProps) {
  return (
    <button type="button" className={`btn btn-ghost${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </button>
  )
}

/** Small square icon button (SVG or glyph child). */
export function IconButton({
  title,
  onClick,
  children,
  className,
  disabled,
}: {
  title: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
  className?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`icon-btn${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

/** Gold coin glyph for the economy layer: filled disc, ink ring, inner ring. */
export function CoinIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ flex: 'none', verticalAlign: '-2px' }}
    >
      <circle cx="8" cy="8" r="6.6" fill="var(--yellow)" stroke="var(--ink)" strokeWidth="1.8" />
      <circle cx="8" cy="8" r="3.2" fill="none" stroke="var(--ink)" strokeWidth="1.6" />
    </svg>
  )
}

/** Observe when an element scrolls into view (lazy thumbnails). Stays true once seen. */
export function useInView<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (!el || inView) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true)
          io.disconnect()
        }
      },
      { rootMargin: '120px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [el, inView])
  return { ref: setEl, inView }
}
