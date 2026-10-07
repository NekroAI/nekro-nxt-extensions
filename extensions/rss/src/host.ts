import { defineHostExtension, type NxtHostService } from '@nekro-nxt/extension-sdk'

/**
 * RSS 订阅：示范频道作用域存储、运行时周期任务与 factory 阶段的 onJob。
 *
 * 示范要点：
 * - 订阅列表与每个源的去重状态分开保存，避免单值接近 256 KiB 上限；
 * - 周期任务到期时先由 onJob 检查，没有新内容返回 `{ wake: false }`，不唤醒智能体；
 * - 运行时任务可能被管理员或智能体删除，读取列表时核对并重建缺失的任务；
 * - 同一频道的读改写串行执行，取回限时 8 秒，留在宿主 onJob 的 15 秒限制之内。
 */
const MAX_FEEDS = 20
const MAX_SEEN = 200
const MAX_ITEMS = 5
const BATCH = 4
const WARN_AFTER = 3
const FETCH_TIMEOUT_MS = 8000
const LIST_KEY = 'rss.feeds'
const CHANNEL = { scope: 'channel' } as const
const CRONS: Readonly<Record<number, string>> = {
  15: '*/15 * * * *',
  30: '*/30 * * * *',
  60: '0 * * * *',
  180: '0 */3 * * *',
}

type Failure = { readonly ok: false; readonly message: string }
type Item = { readonly title: string; readonly link?: string; readonly published?: number }
type Subscription = {
  readonly url: string
  readonly label: string
  readonly jobId: string
  readonly intervalMinutes: number
}
/** `seenIds` 缺失表示还没有基线：下一次成功检查只记录已有条目，不推送。 */
type FeedState = {
  readonly seenIds?: readonly string[]
  readonly failures: number
  readonly lastCheckedAt: number
  readonly latest?: Item
  readonly warned?: boolean
}
type FeedView = Subscription & {
  readonly index: number
  readonly failures: number
  readonly lastCheckedAt: number
  readonly latest?: Item
}
type FeedCheck = {
  readonly url: string
  readonly label: string
  readonly ok: boolean
  readonly newCount: number
  readonly items: readonly Item[]
  readonly message?: string
  readonly warn?: boolean
}
type SubscribeResult = { readonly ok: true; readonly feed: Subscription; readonly message: string } | Failure
type ListResult = { readonly ok: true; readonly feeds: readonly FeedView[] } | Failure
type UnsubscribeResult = { readonly ok: true; readonly message: string } | Failure
type CheckResult = { readonly ok: boolean; readonly message?: string; readonly checks: readonly FeedCheck[] } | Failure

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const clip = (value: string, max: number): string => value.replaceAll(/\s+/gu, ' ').trim().slice(0, max)
const errorText = (error: unknown): string =>
  `RSS 操作失败：${clip(error instanceof Error ? error.message : String(error), 200)}`
const text = (value: string) => [{ type: 'text' as const, text: value }]
const URL_ERROR: Failure = {
  ok: false,
  message: '请提供完整的 http:// 或 https:// 订阅源地址（最多 2048 字，不能含账号密码）。',
}

/** 统一主机大小写、默认端口和片段；保留路径与查询参数，因为它们可能区分不同订阅源。 */
const normalizeUrl = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return undefined
  try {
    const url = new URL(raw.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/** 条目 id 与订阅地址都以 SHA-256 摘要保存：长 GUID 不会撑大存储，也不需要截断。 */
const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
const stateKey = async (url: string): Promise<string> => `rss.state.${await digest(url)}`

const readFeeds = async (nxt: NxtHostService): Promise<readonly Subscription[]> => {
  const saved = await nxt.storage.get(LIST_KEY, CHANNEL)
  return Array.isArray(saved) ? (saved as readonly Subscription[]) : []
}
/** 状态读不到时按「尚无基线」处理，而不是让整个列表失败。 */
const readState = async (nxt: NxtHostService, url: string): Promise<FeedState> => {
  const saved = await nxt.storage.get(await stateKey(url), CHANNEL)
  return saved && typeof saved === 'object' && !Array.isArray(saved)
    ? (saved as FeedState)
    : { failures: 0, lastCheckedAt: 0 }
}
const writeState = async (nxt: NxtHostService, url: string, state: FeedState): Promise<void> =>
  nxt.storage.set(await stateKey(url), state, CHANNEL)

const scheduleJob = (nxt: NxtHostService, url: string, label: string, intervalMinutes: number) =>
  nxt.jobs.schedule({
    label: `RSS：${label}`,
    cron: CRONS[intervalMinutes] ?? '*/30 * * * *',
    timezone: 'UTC',
    payload: { url },
  })

/** 重建被外部删除的周期任务，返回更新后的列表与恢复了任务的地址。 */
const restoreJobs = async (nxt: NxtHostService, saved: readonly Subscription[]) => {
  const restored = new Set<string>()
  if (saved.length === 0) return { feeds: saved, restored }
  const alive = new Set((await nxt.jobs.list()).map((job) => job.jobId))
  const feeds: Subscription[] = []
  for (const feed of saved) {
    if (alive.has(feed.jobId)) {
      feeds.push(feed)
      continue
    }
    const job = await scheduleJob(nxt, feed.url, feed.label, feed.intervalMinutes)
    feeds.push({ ...feed, jobId: job.jobId })
    restored.add(feed.url)
  }
  if (restored.size > 0) await nxt.storage.set(LIST_KEY, feeds, CHANNEL)
  return { feeds, restored }
}

const fetchFeed = async (nxt: NxtHostService, url: string) => {
  const load = async () => {
    const response = await nxt.http.fetch(url, {
      headers: { accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' },
    })
    if (response.status < 200 || response.status >= 300) throw new Error(`订阅源返回 HTTP ${response.status}。`)
    if (!response.text?.trim()) throw new Error('订阅源没有返回 XML 文本。')
    const parsed = await nxt.parse.feed(response.text, { url: response.url || url })
    const entries = new Map<string, Item>()
    for (const entry of parsed.items.slice(0, 100)) {
      if (!entry.id.trim()) continue
      const id = await digest(entry.id)
      if (entries.has(id)) continue
      const link = normalizeUrl(entry.link)
      const published = entry.published
      entries.set(id, {
        title: clip(entry.title ?? '', 120) || '未命名条目',
        ...(link ? { link } : {}),
        ...(typeof published === 'number' && Number.isFinite(published) ? { published } : {}),
      })
    }
    return { title: clip(parsed.title ?? '', 80), entries }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // 超时只包围取回与解析；晚到的响应不会再写存储。
    return await Promise.race([
      load(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('订阅源在 8 秒内没有完成取回与解析，请稍后再试。')), FETCH_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const failedCheck = (feed: Subscription, error: unknown, warn = false): FeedCheck => ({
  url: feed.url,
  label: feed.label,
  ok: false,
  newCount: 0,
  items: [],
  message: errorText(error),
  warn,
})

/** 检查一个源并保存状态。只有周期任务（`periodic`）在连续失败达到 3 次时提醒一次。 */
const checkOne = async (nxt: NxtHostService, feed: Subscription, periodic: boolean): Promise<FeedCheck> => {
  const state = await readState(nxt, feed.url)
  const lastCheckedAt = Date.now()
  let fetched: Awaited<ReturnType<typeof fetchFeed>>
  try {
    fetched = await fetchFeed(nxt, feed.url)
  } catch (error) {
    const failures = state.failures + 1
    const warn = periodic && failures >= WARN_AFTER && !state.warned
    await writeState(nxt, feed.url, { ...state, lastCheckedAt, failures, warned: Boolean(state.warned) || warn })
    return failedCheck(feed, error, warn)
  }
  const ids = [...fetched.entries.keys()]
  // 没有基线（首次或状态丢失）时，当前条目全部视为已见，这次不推送。
  const seen = new Set(state.seenIds ?? ids)
  const fresh = [...fetched.entries].filter(([id]) => !seen.has(id)).map(([, item]) => item)
  const latest = fresh[0] ?? state.latest
  await writeState(nxt, feed.url, {
    // 当前源里的 id 优先保留，再补旧 id，防止暂时消失的条目再次推送。
    seenIds: [...new Set([...ids, ...(state.seenIds ?? [])])].slice(0, MAX_SEEN),
    failures: 0,
    lastCheckedAt,
    ...(latest ? { latest } : {}),
  })
  return { url: feed.url, label: feed.label, ok: true, newCount: fresh.length, items: fresh.slice(0, MAX_ITEMS) }
}

const itemText = (entry: Item): string =>
  `${entry.title}\n${entry.link ?? '未提供链接'}\n发布时间：${entry.published === undefined ? '未提供' : new Date(entry.published).toISOString()}`

/** 宿主把 note 截到 2000 字，这里同样截断即可。 */
const jobNote = (check: FeedCheck): string => {
  const rest = check.newCount > check.items.length ? `，以下展示 ${check.items.length} 条，其余已标记为已见` : ''
  const head = `「${check.label}」有 ${check.newCount} 条新内容${rest}，由智能体决定如何转述。`
  return [head, ...check.items.map(itemText)].join('\n\n').slice(0, 2000)
}

const renderChecks = (value: CheckResult): string => {
  if (!('checks' in value)) return value.message
  const { checks } = value
  if (checks.length === 0) return '当前频道还没有订阅。'
  const items = checks.flatMap((check) => check.items.map((entry) => `「${check.label}」${itemText(entry)}`))
  const total = checks.reduce((sum, check) => sum + check.newCount, 0)
  const errors = checks.filter((check) => !check.ok).map((check) => `「${check.label}」：${check.message}`)
  let summary = '没有发现新内容。'
  if (total > 0) {
    const shown = Math.min(items.length, MAX_ITEMS)
    summary = `检测到 ${total} 条新内容${total > shown ? `，本次展示 ${shown} 条，其余已标记为已见` : ''}。`
  } else if (errors.length === checks.length) summary = '检查失败，暂时无法确认是否有新内容。'
  else if (errors.length > 0) summary = '已成功检查的订阅源没有新内容。'
  return [summary, ...items.slice(0, MAX_ITEMS), ...errors].join('\n\n').slice(0, 6000)
}

const renderFeeds = (value: ListResult): string => {
  if (!value.ok) return value.message
  if (value.feeds.length === 0) return '当前频道还没有订阅。'
  const lines = value.feeds.map((feed) => {
    const checked = feed.lastCheckedAt ? new Date(feed.lastCheckedAt).toISOString() : '尚未检查'
    const latest = feed.latest ? `最近新内容：${itemText(feed.latest)}` : '尚无新内容。'
    return `${feed.index}. ${feed.label}（每 ${feed.intervalMinutes} 分钟）\n${feed.url}\n最近检查：${checked}；连续失败：${feed.failures}\n${latest}`
  })
  return lines.join('\n\n').slice(0, 6000)
}

export default defineHostExtension(async ({ harness }) => {
  // 同一频道的读改写串行执行，避免并发订阅超过上限、并发检查重复返回同一条目。
  const pending = new Map<string, Promise<unknown>>()
  const run = async <T>(channelId: string, action: () => Promise<T>): Promise<T> => {
    const next = (pending.get(channelId) ?? Promise.resolve()).catch(() => undefined).then(action)
    pending.set(channelId, next)
    try {
      return await next
    } finally {
      if (pending.get(channelId) === next) pending.delete(channelId)
    }
  }
  const guarded = async <T>(nxt: NxtHostService, action: () => Promise<T>): Promise<T | Failure> => {
    try {
      return await run((await nxt.context.current()).channel.id, action)
    } catch (error) {
      return { ok: false, message: errorText(error) }
    }
  }

  harness.onJob?.(async (job, nxt) => {
    // 手动操作正在进行时静默跳过这次到期，避免排队超过宿主的 15 秒限制。
    if (pending.has(job.channel.id)) return { wake: false }
    try {
      return await run(job.channel.id, async () => {
        const feed = (await readFeeds(nxt)).find(
          (entry) => entry.jobId === job.jobId && entry.url === record(job.payload)['url'],
        )
        if (!feed) return { wake: false }
        const checked = await checkOne(nxt, feed, true)
        if (checked.warn) {
          return {
            note: `「${feed.label}」已连续 ${WARN_AFTER} 次取回失败，请提醒用户检查订阅源地址或服务状态。\n${feed.url}\n${checked.message}`,
          }
        }
        return checked.items.length > 0 ? { note: jobNote(checked) } : { wake: false }
      })
    } catch {
      // 存储异常不能把一次无内容的轮询变成模型调用。
      return { wake: false }
    }
  })

  return {
    inject: ['tools', 'nxt'],
    apply(ctx) {
      const nxt = ctx.nxt
      if (!nxt) throw new Error('RSS 订阅需要宿主能力 nxt。')

      harness.registerTool(
        ctx,
        harness.defineTool<{ readonly url?: string; readonly label?: string }, SubscribeResult>({
          name: 'subscribe_feed',
          description:
            '在当前频道订阅 RSS 或 Atom；每频道最多 20 个，同地址不重复。首次只记录历史，不推送旧文章；按配置间隔检查，默认 30 分钟。',
          parameters: {
            url: {
              type: 'string',
              required: true,
              description: '完整的 http:// 或 https:// 订阅源地址，最多 2048 字，不能含账号密码',
            },
            label: { type: 'string', description: '可选名称，最多 80 字；默认使用订阅源标题或地址' },
          },
          output: { schema: { type: 'json' }, render: (_args, value) => text(value.message) },
          execute: async ({ url: raw, label }) => {
            const url = normalizeUrl(raw)
            if (!url) return URL_ERROR
            if (label !== undefined && (typeof label !== 'string' || label.trim().length > 80))
              return { ok: false, message: '订阅名称需要是最多 80 字的文字。' }
            return guarded(nxt, async (): Promise<SubscribeResult> => {
              const { feeds, restored } = await restoreJobs(nxt, await readFeeds(nxt))
              const existing = feeds.find((entry) => entry.url === url)
              if (existing) {
                const message = restored.has(url)
                  ? `「${existing.label}」的定时检查任务已丢失，已恢复定时检查。`
                  : `「${existing.label}」已订阅，无需重复添加。`
                return { ok: true, feed: existing, message }
              }
              if (feeds.length >= MAX_FEEDS)
                return { ok: false, message: '每个频道最多订阅 20 个源，请先取消不需要的订阅。' }
              const interval = record(harness.config?.() ?? {})['intervalMinutes'] ?? 30
              if (typeof interval !== 'number' || !CRONS[interval])
                return { ok: false, message: '检查间隔只能设置为 15、30、60 或 180 分钟。' }
              const fetched = await fetchFeed(nxt, url)
              const name = clip(label?.trim() || fetched.title || url, 80)
              const job = await scheduleJob(nxt, url, name, interval)
              const feed: Subscription = { url, label: name, jobId: job.jobId, intervalMinutes: interval }
              try {
                await nxt.storage.set(LIST_KEY, [...feeds, feed], CHANNEL)
              } catch (error) {
                // 存储与任务没有事务，列表保存失败时撤销刚创建的任务。
                await nxt.jobs.cancel(job.jobId).catch(() => undefined)
                throw error
              }
              // 基线写入失败也不影响订阅：下次检查会重新建立基线。
              await writeState(nxt, url, {
                seenIds: [...fetched.entries.keys()].slice(0, MAX_SEEN),
                failures: 0,
                lastCheckedAt: Date.now(),
              }).catch(() => undefined)
              const message = `已订阅「${name}」，每 ${interval} 分钟检查一次；现有文章已标记为已见。`
              return { ok: true, feed, message }
            })
          },
        }),
      )

      harness.registerTool(
        ctx,
        harness.defineTool<Record<string, never>, ListResult>({
          name: 'list_feeds',
          description: '列出当前频道的 RSS 订阅、序号、最近检查时间、连续失败次数与最近一条新内容；无参数。',
          parameters: {},
          output: { schema: { type: 'json' }, render: (_args, value) => text(renderFeeds(value)) },
          execute: () =>
            guarded(nxt, async (): Promise<ListResult> => {
              const { feeds } = await restoreJobs(nxt, await readFeeds(nxt))
              const views = await Promise.all(
                feeds.map(async (feed, index): Promise<FeedView> => {
                  const { failures, lastCheckedAt, latest } = await readState(nxt, feed.url)
                  return { ...feed, index: index + 1, failures, lastCheckedAt, ...(latest ? { latest } : {}) }
                }),
              )
              return { ok: true, feeds: views }
            }),
        }),
      )

      harness.registerTool(
        ctx,
        harness.defineTool<{ readonly url?: string; readonly index?: number }, UnsubscribeResult>({
          name: 'unsubscribe_feed',
          description:
            '取消当前频道的一个 RSS 订阅并取消周期任务；url 和 index 必须且只能提供一个。序号以最近一次 list_feeds 为准。',
          parameters: {
            url: { type: 'string', description: '要取消的完整订阅地址，不能与 index 同时填写' },
            index: { type: 'integer', description: 'list_feeds 返回的序号，1 到 20，不能与 url 同时填写' },
          },
          output: { schema: { type: 'json' }, render: (_args, value) => text(value.message) },
          execute: async ({ url: raw, index }) => {
            if ((raw === undefined) === (index === undefined))
              return { ok: false, message: '请提供订阅地址或序号，且只能选择一种。' }
            const url = raw === undefined ? undefined : normalizeUrl(raw)
            if (raw !== undefined && !url) return URL_ERROR
            if (index !== undefined && (!Number.isInteger(index) || index < 1 || index > MAX_FEEDS))
              return { ok: false, message: '序号需要是 1 到 20 的整数。' }
            return guarded(nxt, async (): Promise<UnsubscribeResult> => {
              const feeds = await readFeeds(nxt)
              const feed = url ? feeds.find((entry) => entry.url === url) : feeds[(index ?? 0) - 1]
              if (!feed) return { ok: false, message: '当前频道没有找到这个订阅，请先用 list_feeds 查看。' }
              await nxt.jobs.cancel(feed.jobId)
              const rest = feeds.filter((entry) => entry.url !== feed.url)
              await nxt.storage.set(LIST_KEY, rest, CHANNEL)
              await nxt.storage.delete(await stateKey(feed.url), CHANNEL)
              return { ok: true, message: `已取消「${feed.label}」及对应的周期任务。` }
            })
          },
        }),
      )

      harness.registerTool(
        ctx,
        harness.defineTool<{ readonly url?: string }, CheckResult>({
          name: 'check_feed_now',
          description:
            '立即检查当前频道的 RSS 订阅并返回新内容；url 省略时检查全部订阅。每个源最多返回 5 条，全部新条目均标记为已见，不等待周期任务。',
          parameters: { url: { type: 'string', description: '已订阅的完整地址；省略时检查本频道全部订阅' } },
          output: { schema: { type: 'json' }, render: (_args, value) => text(renderChecks(value)) },
          execute: async ({ url: raw }) => {
            const url = raw === undefined ? undefined : normalizeUrl(raw)
            if (raw !== undefined && !url) return URL_ERROR
            return guarded(nxt, async (): Promise<CheckResult> => {
              const { feeds: all } = await restoreJobs(nxt, await readFeeds(nxt))
              const feeds = all.filter((entry) => url === undefined || entry.url === url)
              if (url && feeds.length === 0)
                return { ok: false, message: '当前频道没有订阅这个地址，请先订阅或用 list_feeds 查看。' }
              // 每批最多并发检查 4 个源，既不逐个串行，也不一次压满网络。
              const checks: FeedCheck[] = []
              for (let start = 0; start < feeds.length; start += BATCH) {
                const batch = feeds
                  .slice(start, start + BATCH)
                  .map((feed) => checkOne(nxt, feed, false).catch((error) => failedCheck(feed, error)))
                checks.push(...(await Promise.all(batch)))
              }
              return checks.every((check) => check.ok)
                ? { ok: true, checks }
                : { ok: false, message: '部分订阅源检查失败，成功的结果仍已保存。', checks }
            })
          },
        }),
      )
    },
  }
})
