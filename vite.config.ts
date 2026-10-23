import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { transformAsync, type BabelFileResult } from '@babel/core'
import { inspectorServer } from '@react-dev-inspector/vite-plugin'
import { pickPort } from './scripts/pick-port.mjs'
import { aiApi } from './scripts/ai-api.mjs'

// 给每个 JSX 节点注入 data-inspector-line/-column/-relative-path 源码位置
// 属性，src/ui/DevInspector.tsx 的点击定位依赖它们。仅 dev serve 生效，
// 生产构建不受影响。路径统一用正斜杠：Windows 反斜杠经过多轮转义不稳定，
// 且正斜杠在 path.resolve 与编辑器 CLI 中跨平台通用。
function inspectorTransform(): Plugin {
  return {
    name: 'react-dev-inspector-transform',
    apply: 'serve',
    enforce: 'pre',
    async transform(code, id) {
      const [file] = id.split('?')
      if (!/\.tsx?$/.test(file) || file.includes('node_modules')) return
      // R3F 会把 dash-case 属性当作穿透赋值解析（data-inspector-column →
      // data.inspector-column），注入会让 applyProps 抛错、整页 3D 崩溃。
      // 跳过 3D 场景目录与参数化家具定义（后者经 <Edged>/<Rounded> 的
      // spread 把属性转发给 <mesh>），再兜底跳过 import three 生态的文件；
      // 新增使用 R3F 的目录时需同步扩这里的跳过条件。
      const normalized = file.replaceAll('\\', '/')
      if (/src\/(three|models\/parametric)\//.test(normalized)) return
      if (/@react-three\/|from ['"]three(\/[^'"]*)?['"]/.test(code)) return
      const relativePath = path.relative(process.cwd(), file).replaceAll('\\', '/')
      const result: BabelFileResult | null = await transformAsync(code, {
        filename: file,
        sourceType: 'module',
        parserOpts: { plugins: ['typescript', 'jsx', 'decorators-legacy'] },
        plugins: [
          ({ types: t }: { types: typeof import('@babel/core').types }) => ({
            visitor: {
              JSXOpeningElement(nodePath: any) {
                const name = nodePath.node.name
                if (
                  (t.isJSXIdentifier(name) && name.name.endsWith('Fragment')) ||
                  (t.isJSXMemberExpression(name) && name.property.name.endsWith('Fragment'))
                ) {
                  return
                }
                const line = nodePath.node.loc?.start.line
                const column = nodePath.node.loc?.start.column
                if (line == null || column == null) return
                nodePath.node.attributes.unshift(
                  t.jsxAttribute(
                    t.jsxIdentifier('data-inspector-line'),
                    t.stringLiteral(String(line)),
                  ),
                  t.jsxAttribute(
                    t.jsxIdentifier('data-inspector-column'),
                    t.stringLiteral(String(column)),
                  ),
                  t.jsxAttribute(
                    t.jsxIdentifier('data-inspector-relative-path'),
                    t.stringLiteral(relativePath),
                  ),
                )
              },
            },
          }),
        ],
        sourceMaps: true,
      })
      if (!result?.code) return
      return { code: result.code, map: result.map ?? null }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), aiApi(), inspectorTransform(), inspectorServer()],
  server: {
    host: '127.0.0.1',
    port: pickPort(),
    strictPort: true,
  },
})
