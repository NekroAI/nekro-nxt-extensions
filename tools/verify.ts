/**
 * 把 `dist/*.nxt-extension` 导入一个正在运行的 NekroNXT，走与用户「工坊 → 导入」完全相同的预检、构建与验证。
 *
 * 环境变量：
 * - `NXT_URL`：NekroNXT 地址，默认 `http://127.0.0.1:4960`；
 * - `NXT_MANAGEMENT_KEY`：服务端的管理密钥。本机桌面版或开发服务没有管理入口时不填。
 *
 * 请使用一次性的数据目录运行 NekroNXT：导入的扩展会留在那个实例中（不会自动启用）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')
const base = (process.env['NXT_URL'] ?? 'http://127.0.0.1:4960').replace(/\/+$/u, '')
const managementKey = process.env['NXT_MANAGEMENT_KEY']

const cookies = new Map<string, string>()
const remember = (response: Response): void => {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';')
    const index = pair?.indexOf('=') ?? -1
    if (pair && index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1))
  }
}

const request = async (pathname: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  if (cookies.size > 0) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '))
  // 管理入口只接受同源请求，与浏览器一样带上来源。
  headers.set('origin', base)
  const csrf = cookies.get('nxt_csrf')
  if (csrf) headers.set('x-nxt-csrf', csrf)
  const response = await fetch(`${base}${pathname}`, { ...init, headers })
  remember(response)
  return response
}

const problem = async (response: Response): Promise<string> => {
  const text = await response.text()
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string } }
    return `${response.status} ${body.error?.code ?? ''} ${body.error?.message ?? text}`.trim()
  } catch {
    return `${response.status} ${text.slice(0, 500)}`
  }
}

const main = async (): Promise<void> => {
  if (managementKey) {
    const login = await request('/api/management/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ managementKey, acknowledgeInsecure: true }),
    })
    if (!login.ok) throw new Error(`登录 NekroNXT 失败：${await problem(login)}`)
  }
  const packages = readdirSync(DIST)
    .filter((name) => name.endsWith('.nxt-extension'))
    .sort()
  if (packages.length === 0) throw new Error('dist 中没有扩展包，请先运行 pnpm build。')
  let failed = 0
  for (const name of packages) {
    const bytes = readFileSync(path.join(DIST, name))
    const inspected = await request('/api/extensions/imports/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': name },
      body: bytes,
    })
    if (!inspected.ok) {
      failed += 1
      console.error(`✗ ${name} 预检失败：${await problem(inspected)}`)
      continue
    }
    const inspection = (await inspected.json()) as { token: string; displayName: string; idempotent: boolean }
    const committed = await request(`/api/extensions/imports/${encodeURIComponent(inspection.token)}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!committed.ok) {
      failed += 1
      console.error(`✗ ${name}（${inspection.displayName}）导入验证失败：${await problem(committed)}`)
      continue
    }
    const result = (await committed.json()) as { revisionId: string; idempotent: boolean }
    console.log(`✓ ${name}（${inspection.displayName}）通过导入验证${result.idempotent ? '（已存在相同版本）' : ''}`)
  }
  if (failed > 0) {
    console.error(`${failed} 个扩展没有通过导入验证。`)
    process.exitCode = 1
  }
}

await main()
