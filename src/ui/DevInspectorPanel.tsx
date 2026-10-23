// 元素定位器面板，仅由 DevInspector.tsx 在 DEV 下动态加载，勿静态引入。
//
// 源码位置有两条解析路径，最终都交给 gotoServerEditor：
//   1. vite.config.ts 中 inspectorTransform 注入的 data-inspector-* 属性
//      （主要路径，精确到 JSX 节点）；
//   2. React Fiber 的 _debugSource 兜底（React 19.2 起已无此字段，
//      保留以兼容旧版 React）。

import { useEffect, useState } from 'react'
import { gotoServerEditor, Inspector } from 'react-dev-inspector'

type ReactFiber = {
  return?: ReactFiber | null
  _debugSource?: {
    fileName?: string
    lineNumber?: number
    columnNumber?: number
  }
  _debugOwner?: ReactFiber | null
}

type FiberElement = HTMLElement & {
  [key: string]: ReactFiber | undefined
}

function getFiber(element: HTMLElement | null): ReactFiber | undefined {
  if (!element) return undefined

  const fiberKey = Object.keys(element).find(
    (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'),
  )

  if (fiberKey) return (element as FiberElement)[fiberKey]
  return getFiber(element.parentElement)
}

function getCodeInfo(element: HTMLElement) {
  const sourceElement = element.closest<HTMLElement>('[data-inspector-relative-path]')

  if (sourceElement?.dataset.inspectorRelativePath) {
    return {
      relativePath: sourceElement.dataset.inspectorRelativePath,
      lineNumber: sourceElement.dataset.inspectorLine ?? '1',
      columnNumber: sourceElement.dataset.inspectorColumn ?? '1',
    }
  }

  let fiber = getFiber(element)

  while (fiber) {
    const source = fiber._debugSource ?? fiber._debugOwner?._debugSource

    if (source?.fileName && source.lineNumber) {
      return {
        absolutePath: source.fileName,
        lineNumber: String(source.lineNumber),
        columnNumber: String(source.columnNumber ?? 1),
      }
    }

    fiber = fiber.return ?? undefined
  }

  return undefined
}

/** 光标定位图标，strokeWidth 2、圆角线帽，与项目内联 SVG 惯例一致。 */
function CursorIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ flex: 'none' }}
    >
      <path
        d="M5 3l14 8-6.5 1.5L9 19 5 3z"
        stroke="var(--ink)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={active ? '#fff' : 'none'}
      />
    </svg>
  )
}

export function DevInspectorPanel() {
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (!active) return

    const handleClick = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()

      const target = event.target
      if (!(target instanceof HTMLElement)) return

      const codeInfo = getCodeInfo(target)
      setActive(false)

      if (codeInfo) {
        gotoServerEditor(codeInfo)
      }
    }

    window.addEventListener('click', handleClick, true)
    return () => window.removeEventListener('click', handleClick, true)
  }, [active])

  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
  const inspectorKeys = isMac
    ? ['Ctrl', 'Shift', 'Command', 'C']
    : ['Ctrl', 'Shift', 'Alt', 'C']
  const hotkey = inspectorKeys.join(' + ')

  return (
    <>
      <Inspector
        keys={inspectorKeys}
        active={active}
        onActiveChange={setActive}
        onClickElement={() => {}}
        onInspectElement={({ codeInfo }) => {
          gotoServerEditor(codeInfo)
        }}
      />
      <button
        type="button"
        className="btn dev-inspector-btn"
        onClick={() => setActive((value) => !value)}
        aria-pressed={active}
        title={`元素定位（${hotkey}）：点击页面元素在编辑器中打开对应源码`}
      >
        <CursorIcon active={active} />
      </button>
    </>
  )
}
