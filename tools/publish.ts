/**
 * 把 `dist/*.nxt-extension` 发布到 NekroNXT 社区，作为官方扩展。
 *
 * 环境变量：
 * - `COMMUNITY_URL`：社区地址，默认 `https://nxt.nekro.ai`；
 * - `COMMUNITY_PUBLISH_TOKEN`：社区后台「扩展 → 官方发布令牌」创建的令牌。
 *
 * 内容没有变化的包社区会回复「已经发布过」，这里按跳过处理；更新说明取自各扩展 `release.json` 的 `notes`。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')
const EXTENSIONS = path.join(ROOT, 'extensions')
const base = (process.env['COMMUNITY_URL'] ?? 'https://nxt.nekro.ai').replace(/\/+$/u, '')
const token = process.env['COMMUNITY_PUBLISH_TOKEN']

/** slug → 更新说明。 */
const notesBySlug = (): Map<string, string> => {
  const notes = new Map<string, string>()
  for (const name of readdirSync(EXTENSIONS)) {
    const definition = path.join(EXTENSIONS, name, 'extension.json')
    const lock = path.join(EXTENSIONS, name, 'release.json')
    if (!existsSync(definition) || !existsSync(lock)) continue
    const { slug } = JSON.parse(readFileSync(definition, 'utf8')) as { slug: string }
    const { notes: text } = JSON.parse(readFileSync(lock, 'utf8')) as { notes?: string }
    if (text) notes.set(slug, text)
  }
  return notes
}

const main = async (): Promise<void> => {
  if (!token) throw new Error('缺少 COMMUNITY_PUBLISH_TOKEN。')
  const notes = notesBySlug()
  const packages = readdirSync(DIST)
    .filter((name) => name.endsWith('.nxt-extension'))
    .sort()
  let failed = 0
  for (const name of packages) {
    const form = new FormData()
    form.set('package', new File([readFileSync(path.join(DIST, name))], name))
    const note = notes.get(name.replace(/\.nxt-extension$/u, ''))
    if (note) form.set('notes', note)
    const response = await fetch(`${base}/api/v1/official/releases`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string }
      release?: { reviewStatus?: string }
      extension?: { displayName?: string }
    }
    if (response.status === 201) {
      console.log(
        `✓ ${name}（${body.extension?.displayName ?? ''}）已发布，审查状态：${body.release?.reviewStatus ?? '未知'}`,
      )
    } else if (response.status === 409 && body.error?.code === 'duplicate_release') {
      console.log(`- ${name} 内容没有变化，跳过`)
    } else {
      failed += 1
      console.error(`✗ ${name} 发布失败：${response.status} ${body.error?.message ?? ''}`)
    }
  }
  if (failed > 0) process.exitCode = 1
}

await main()
