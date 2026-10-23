// 开发环境专用的 React 元素定位器入口，生产构建下不加载、不渲染任何内容。
//
// 真正的面板在 DevInspectorPanel.tsx，只在 DEV 下经动态 import 加载：
// `if (import.meta.env.DEV)` 在生产构建被静态替换为 `if (false)`，
// Rollup 会整块移除，面板模块（react-dev-inspector 及其依赖）完全不进
// 生产依赖图。使用方式：dev 模式下按快捷键（Win/Linux 为
// Ctrl+Shift+Alt+C，macOS 为 Ctrl+Shift+Command+C）或点击右下角悬浮的
// 光标按钮进入定位模式，悬停高亮元素后点击，即可在编辑器中打开该组件
// 的源码位置。编辑器通过 REACT_EDITOR 环境变量指定，默认 `code`（VS Code）。

import { useEffect, useState, type ComponentType } from 'react'

export function DevInspector() {
  const [Panel, setPanel] = useState<ComponentType | null>(null)

  useEffect(() => {
    if (import.meta.env.DEV) {
      import('./DevInspectorPanel').then(
        (m) => setPanel(() => m.DevInspectorPanel),
        () => {},
      )
    }
  }, [])

  if (!Panel) return null
  return <Panel />
}
