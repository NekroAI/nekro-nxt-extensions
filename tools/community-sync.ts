import { z } from 'zod'
/** Official repository publication: synchronize intent, respect moderation, then publish independently. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadCatalog, ROOT } from './catalog.js'
import { listingFormFields, listingPatchBody, loadListing, type Listing } from './listing.js'

const StatusSchema = z.object({
  repository: z.literal('NekroAI/nekro-nxt-extensions'),
  version: z.number().int().positive(),
  entries: z.array(
    z.object({
      extensionId: z.string(),
      exists: z.boolean(),
      state: z.enum(['active', 'retired']),
      canPublish: z.boolean(),
      canDistribute: z.boolean(),
      restriction: z.object({ code: z.string(), reason: z.string() }).nullable(),
    }),
  ),
})
export type CatalogStatus = z.infer<typeof StatusSchema>
export interface SyncResult {
  extensionId: string
  name: string
  outcome: 'published' | 'unchanged' | 'listing' | 'retired' | 'skipped' | 'failed'
  message: string
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export const listingDigest = (listing: Listing) => digest(JSON.stringify(listingPatchBody(listing)))
export const prepareSync = (root = ROOT) => {
  const catalog = loadCatalog(root)
  const listings = new Map(
    catalog.entries.flatMap((entry) =>
      entry.state === 'active'
        ? [[entry.extensionId, loadListing(path.join(root, 'extensions', entry.directory))] as const]
        : [],
    ),
  )
  const entries = catalog.entries.map((entry) => {
    if (entry.state === 'retired') return entry
    const lock = JSON.parse(readFileSync(path.join(root, 'extensions', entry.directory, 'release.json'), 'utf8')) as {
      revisionId: string
    }
    return { ...entry, revisionId: lock.revisionId, listingDigest: listingDigest(listings.get(entry.extensionId)!) }
  })
  return { catalog, listings, entries }
}
const POLICY_CODES = new Set(['extension_delisted', 'extension_retired', 'extension_archived'])
export const isPolicySkip = (status: number, code?: string): boolean =>
  status === 403 && code !== undefined && POLICY_CODES.has(code)

export const syncCommunity = async (options: {
  root?: string
  base: string
  token: string
  commitSha: string
  stateOnly?: boolean
  listingOnly?: boolean
  names?: readonly string[]
  fetch?: typeof fetch
}) => {
  const root = options.root ?? ROOT
  const { catalog, listings, entries } = prepareSync(root)
  const selected = options.names ?? []
  for (const name of selected)
    if (![...listings.values()].some((item) => item.name === name))
      throw new Error(`清单中没有这个维护中的扩展：${name}`)
  const fetcher = options.fetch ?? fetch
  const request = async (pathname: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${options.token}`)
    const response = await fetcher(`${options.base.replace(/\/+$/u, '')}/api/v1${pathname}`, { ...init, headers })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    return { response, body }
  }
  const sync = await request('/official/catalog/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...catalog, entries, commitSha: options.commitSha }),
  })
  if (!sync.response.ok || !sync.body || !Array.isArray(sync.body['entries']))
    throw new Error(`同步清单失败（${sync.response.status}）：${JSON.stringify(sync.body)}`)
  const status = StatusSchema.parse(sync.body)
  if (status.version !== catalog.version) throw new Error('社区清单已经更新，请使用最新提交重试。')
  const results: SyncResult[] = []
  const packages: string[] = []
  for (const entry of entries) {
    if (entry.state === 'retired') {
      results.push({
        extensionId: entry.extensionId,
        name: entry.extensionId,
        outcome: 'retired',
        message: entry.reason,
      })
      continue
    }
    const listing = listings.get(entry.extensionId)!
    if (selected.length && !selected.includes(listing.name)) continue
    const state = status.entries.find((item) => item.extensionId === entry.extensionId)
    const record = (outcome: SyncResult['outcome'], message: string) =>
      results.push({ extensionId: entry.extensionId, name: entry.directory, outcome, message })
    if (!state) {
      record('failed', '社区回复缺少这个条目。')
      continue
    }
    if (!state.canPublish) {
      if (!state.restriction || !POLICY_CODES.has(state.restriction.code)) {
        record('failed', '社区返回了未知限制状态。')
        continue
      }
      record('skipped', state.restriction.reason)
      continue
    }
    if (options.stateOnly) {
      record('unchanged', '已同步维护状态')
      continue
    }
    let published = false
    try {
      if (!options.listingOnly) {
        const form = new FormData()
        const filename = `${listing.slug}.nxt-extension`
        form.set('package', new File([readFileSync(path.join(root, 'dist', filename))], filename))
        for (const [key, value] of Object.entries(listingFormFields(listing))) form.set(key, value)
        const lock = JSON.parse(
          readFileSync(path.join(root, 'extensions', entry.directory, 'release.json'), 'utf8'),
        ) as { notes?: string }
        if (lock.notes) form.set('notes', lock.notes)
        const { response, body } = await request('/official/releases', { method: 'POST', body: form })
        const error = body?.['error'] as { code?: string; message?: string } | undefined
        if (isPolicySkip(response.status, error?.code)) {
          record('skipped', error?.message ?? '社区已停止分发')
          continue
        }
        if (response.status !== 201 && !(response.status === 409 && error?.code === 'duplicate_release'))
          throw new Error(`发布失败（${response.status}）：${error?.message ?? '回复格式不正确'}`)
        published = response.status === 201
      } else if (!state.exists) {
        record('failed', '尚未发布，不能只更新介绍。')
        continue
      }
      const patch = await request(`/official/extensions/${encodeURIComponent(entry.extensionId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(listingPatchBody(listing)),
      })
      const error = patch.body?.['error'] as { code?: string; message?: string } | undefined
      if (isPolicySkip(patch.response.status, error?.code)) {
        record('skipped', error?.message ?? '社区已停止分发')
        continue
      }
      const saved = patch.body?.['extension'] as Listing | undefined
      if (!patch.response.ok || !saved || listingDigest(saved) !== entry.listingDigest)
        throw new Error(`介绍没有确认保存（${patch.response.status}）：${error?.message ?? '返回内容不一致'}`)
      record(options.listingOnly ? 'listing' : published ? 'published' : 'unchanged', '介绍已同步')
    } catch (error) {
      record('failed', `${published ? '版本已发布；' : ''}${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Refresh after publication: review or moderation may have changed while CI was running.
  if (!options.stateOnly && !options.listingOnly) {
    try {
      const final = await request('/official/catalog')
      if (!final.response.ok || !Array.isArray(final.body?.['entries']))
        throw new Error('无法确认最终分发状态，不生成发布附件。')
      const latest = StatusSchema.parse(final.body)
      if (latest.version !== catalog.version) throw new Error('发布期间清单已经更新，不生成旧版本附件。')
      for (const state of latest.entries) {
        if (
          state.canDistribute &&
          results.some(
            (result) => result.extensionId === state.extensionId && ['published', 'unchanged'].includes(result.outcome),
          )
        ) {
          const listing = listings.get(state.extensionId)
          if (listing) packages.push(path.join(root, 'dist', `${listing.slug}.nxt-extension`))
        }
      }
    } catch (error) {
      packages.length = 0
      results.push({
        extensionId: '',
        name: '分发状态确认',
        outcome: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    version: catalog.version,
    commitSha: options.commitSha,
    results,
    packages,
    failed: results.some((result) => result.outcome === 'failed'),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  if (args.includes('--dry-run')) {
    const prepared = prepareSync()
    console.log(JSON.stringify({ ...prepared.catalog, entries: prepared.entries }, null, 2))
  } else {
    const token = process.env['COMMUNITY_PUBLISH_TOKEN']
    let report: Awaited<ReturnType<typeof syncCommunity>>
    try {
      if (!token) throw new Error('缺少 COMMUNITY_PUBLISH_TOKEN。')
      report = await syncCommunity({
        base: process.env['COMMUNITY_URL'] ?? 'https://nxt.nekro.ai',
        token,
        commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
        stateOnly: args.includes('--state-only'),
        listingOnly: args.includes('--listing-only'),
        names: args.filter((arg) => !arg.startsWith('--')),
      })
    } catch (error) {
      report = {
        version: 0,
        commitSha: '',
        packages: [],
        failed: true,
        results: [
          {
            extensionId: '',
            name: '仓库同步',
            outcome: 'failed',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }
    mkdirSync(path.join(ROOT, 'dist'), { recursive: true })
    writeFileSync(path.join(ROOT, 'dist/community-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(path.join(ROOT, 'dist/community-assets.txt'), report.packages.join('\n'))
    const summary = report.results.map((result) => `- ${result.name}：${result.outcome} · ${result.message}`).join('\n')
    console.log(summary)
    if (process.env['GITHUB_STEP_SUMMARY']) writeFileSync(process.env['GITHUB_STEP_SUMMARY'], summary)
    if (report.failed) process.exitCode = 1
  }
}
