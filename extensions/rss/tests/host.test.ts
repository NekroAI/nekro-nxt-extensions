import type { NxtFeed, NxtFeedItem, NxtFetchResponse } from '@nekro-nxt/extension-sdk'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestHost, respond } from '../../../tools/testing.js'
import factory from '../src/host.js'

const URL = 'https://news.example.com/feed.xml'
const article = (id: string): NxtFeedItem => ({
  id,
  title: `示例文章 ${id}`,
  link: `https://news.example.com/articles/${id}`,
  published: 1_791_378_000_000,
})

/** 网络和解析全部通过仓库测试宿主提供，不调用真实网站。 */
const fixture = async (config: Readonly<Record<string, number>> = {}) => {
  let items: readonly NxtFeedItem[] = [article('old')]
  let status = 200
  let broken = false
  const host = await createTestHost(factory, {
    config,
    fetch: () => {
      if (broken) throw new Error('示例网络不可用')
      return respond('<rss/>', { status, contentType: 'application/xml' })
    },
    parseFeed: (): NxtFeed => ({ kind: 'rss2', title: '示例新闻', items }),
  })
  return {
    host,
    setItems: (next: readonly NxtFeedItem[]) => {
      items = next
    },
    setStatus: (next: number) => {
      status = next
    },
    setBroken: (next: boolean) => {
      broken = next
    },
  }
}
const subscribe = async (host: Awaited<ReturnType<typeof createTestHost>>, url = URL) => {
  const result = await host.call('subscribe_feed', { url })
  expect(result.value).toMatchObject({ ok: true })
  const job = [...host.jobs.values()].find((entry) => (entry.payload as { url?: string })?.url === url)
  if (!job) throw new Error('没有创建测试任务。')
  return job
}
const stateKey = (url: string) => `rss.state.${createHash('sha256').update(url).digest('hex')}`
const savedState = async (host: Awaited<ReturnType<typeof createTestHost>>, url = URL) =>
  (await host.nxt.storage.get(stateKey(url), { scope: 'channel' })) as {
    seenIds: string[]
    failures: number
    lastCheckedAt: number
    latest?: { title: string; link?: string }
  }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RSS 订阅', () => {
  it('subscribes with channel storage, a 30-minute cron and no historical latest content', async () => {
    const { host } = await fixture()
    expect([...host.tools.keys()]).toEqual(['subscribe_feed', 'list_feeds', 'unsubscribe_feed', 'check_feed_now'])
    const { value, text } = await host.call('subscribe_feed', { url: URL, label: '自定名称' })
    expect(value).toMatchObject({ ok: true, feed: { label: '自定名称', intervalMinutes: 30 } })
    expect(text).toContain('现有文章已标记为已见')
    const job = [...host.jobs.values()][0]!
    expect(job).toMatchObject({ cron: '*/30 * * * *', payload: { url: URL } })
    const state = await savedState(host)
    expect(state.seenIds).toHaveLength(1)
    expect(state.seenIds[0]).toMatch(/^[a-f0-9]{64}$/u)
    expect(state.latest).toBeUndefined()
    expect([...host.storage.keys()].every((key) => key.startsWith('channel:'))).toBe(true)
    expect((await host.call('list_feeds')).value).toMatchObject({
      ok: true,
      feeds: [{ index: 1, label: '自定名称', failures: 0 }],
    })
  })

  it('does not push history on the first due job or manual check', async () => {
    const { host } = await fixture()
    const job = await subscribe(host)
    expect(await host.due(job)).toEqual({ wake: false })
    expect((await host.call('check_feed_now')).value).toMatchObject({ ok: true, checks: [{ newCount: 0, items: [] }] })
    expect((await host.call('list_feeds')).text).toContain('尚无新内容')
  })

  it('deduplicates normalized addresses without a second fetch or job', async () => {
    const { host } = await fixture()
    await subscribe(host)
    const result = await host.call('subscribe_feed', {
      url: ' HTTPS://NEWS.EXAMPLE.COM:443/feed.xml#section ',
      label: '另一个名称',
    })
    expect(result.text).toContain('无需重复添加')
    expect(host.jobs.size).toBe(1)
    expect(host.calls).toHaveLength(1)
    expect(result.value).toMatchObject({ feed: { label: '示例新闻' } })
  })

  it('serializes concurrent subscriptions to the same address', async () => {
    const { host } = await fixture()
    const results = await Promise.all([
      host.call('subscribe_feed', { url: URL }),
      host.call('subscribe_feed', { url: URL }),
    ])
    expect(results.every((result) => (result.value as { ok: boolean }).ok)).toBe(true)
    expect(host.jobs.size).toBe(1)
    expect(host.calls).toHaveLength(1)
  })

  it('enforces the 20-feed limit even with concurrent additions', async () => {
    const { host } = await fixture()
    const results = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        host.call('subscribe_feed', { url: `https://news.example.com/feed-${index}.xml` }),
      ),
    )
    expect(results.filter((result) => (result.value as { ok: boolean }).ok)).toHaveLength(20)
    expect(results[20]?.text).toContain('最多订阅 20')
    expect(host.jobs.size).toBe(20)
    expect(host.calls).toHaveLength(20)
  })

  it.each([
    [15, '*/15 * * * *'],
    [30, '*/30 * * * *'],
    [60, '0 * * * *'],
    [180, '0 */3 * * *'],
  ] as const)('uses the configured %i-minute interval', async (intervalMinutes, cron) => {
    const { host } = await fixture({ intervalMinutes })
    const job = await subscribe(host)
    expect(job.cron).toBe(cron)
  })

  it('rejects unsupported interval configuration before fetching or writing', async () => {
    const { host } = await fixture({ intervalMinutes: 45 })
    expect((await host.call('subscribe_feed', { url: URL })).text).toContain('15、30、60 或 180')
    expect(host.calls).toEqual([])
    expect(host.storage.size).toBe(0)
    expect(host.jobs.size).toBe(0)
  })

  it.each([
    '',
    'bad-url',
    'file:///example.xml',
    'ftp://example.test/feed',
    'https://fixture:secret@example.test/feed',
    'https://example.test/' + 'x'.repeat(2048),
  ])('rejects invalid or credential-bearing address %s', async (url) => {
    const { host } = await fixture()
    for (const name of ['subscribe_feed', 'unsubscribe_feed', 'check_feed_now']) {
      expect((await host.call(name, { url })).value).toMatchObject({ ok: false })
    }
    expect(host.calls).toEqual([])
    expect(host.storage.size).toBe(0)
    expect(host.jobs.size).toBe(0)
  })

  it('rejects invalid labels and uses the feed address when no title is provided', async () => {
    const { host } = await fixture()
    expect((await host.call('subscribe_feed', { url: URL, label: '名'.repeat(81) })).value).toMatchObject({ ok: false })
    const untitled = await createTestHost(factory, {
      fetch: () => respond('<feed/>'),
      parseFeed: () => ({ kind: 'atom', items: [] }),
    })
    expect((await untitled.call('subscribe_feed', { url: URL })).value).toMatchObject({
      ok: true,
      feed: { label: URL },
    })
  })

  it('returns new titles, links and publication times once and preserves latest content', async () => {
    const { host, setItems } = await fixture()
    const job = await subscribe(host)
    setItems([article('new'), article('old')])
    const due = await host.due(job)
    expect(due?.note).toContain('示例文章 new')
    expect(due?.note).toContain('https://news.example.com/articles/new')
    expect(due?.note).toContain('2026-10-07T13:00:00.000Z')
    expect(due?.wake).not.toBe(false)
    expect(await host.due(job)).toEqual({ wake: false })
    expect((await host.call('check_feed_now', { url: URL })).text).toBe('没有发现新内容。')
    expect((await host.call('list_feeds')).text).toContain('最近新内容：示例文章 new')
  })

  it('caps a due note at five new items and marks all new IDs as seen', async () => {
    const { host, setItems } = await fixture()
    const job = await subscribe(host)
    setItems(Array.from({ length: 8 }, (_, index) => article(`new-${index}`)))
    const note = (await host.due(job))?.note ?? ''
    expect(note.match(/发布时间：/gu)).toHaveLength(5)
    expect(note).not.toContain('示例文章 new-5')
    expect(note.length).toBeLessThanOrEqual(2000)
    expect(note).toContain('其余已标记为已见')
    expect((await savedState(host)).seenIds).toHaveLength(9)
    expect(await host.due(job)).toEqual({ wake: false })
  })

  it('handles duplicate IDs, missing metadata and unsafe links', async () => {
    const { host, setItems } = await fixture()
    const job = await subscribe(host)
    setItems([{ id: 'new', link: 'javascript:alert(1)' }, { id: 'new' }, { id: '' }])
    const note = (await host.due(job))?.note ?? ''
    expect(note).toContain('未命名条目')
    expect(note).toContain('未提供链接')
    expect(note).toContain('发布时间：未提供')
    expect(note).not.toContain('javascript:')
    expect((await savedState(host)).seenIds).toHaveLength(2)
  })

  it('remembers at most 200 IDs across changing feeds, including long IDs', async () => {
    const { host, setItems } = await fixture()
    const job = await subscribe(host)
    for (let page = 0; page < 3; page += 1) {
      setItems(Array.from({ length: 100 }, (_, index) => ({ id: `page-${page}-${index}-${'长'.repeat(1000)}` })))
      await host.call('check_feed_now')
    }
    const state = await savedState(host)
    expect(state.seenIds).toHaveLength(200)
    expect(new Set(state.seenIds).size).toBe(200)
    expect(state.seenIds.every((id) => id.length === 64)).toBe(true)
    expect(await host.due(job)).toEqual({ wake: false })
  })

  it('retains IDs temporarily absent from the feed', async () => {
    const { host, setItems } = await fixture()
    const job = await subscribe(host)
    setItems([])
    expect(await host.due(job)).toEqual({ wake: false })
    setItems([article('old')])
    expect(await host.due(job)).toEqual({ wake: false })
  })

  it('warns only on the third consecutive failure and resets after success', async () => {
    const { host, setItems, setBroken } = await fixture()
    const job = await subscribe(host)
    setItems([article('new')])
    await host.due(job)
    setBroken(true)
    expect(await host.due(job)).toEqual({ wake: false })
    expect(await host.due(job)).toEqual({ wake: false })
    expect((await host.due(job))?.note).toContain('连续 3 次取回失败')
    expect(await host.due(job)).toEqual({ wake: false })
    expect((await savedState(host)).failures).toBe(4)
    expect((await host.call('list_feeds')).text).toContain('最近新内容：示例文章 new')
    setBroken(false)
    expect(await host.due(job)).toEqual({ wake: false })
    expect((await savedState(host)).failures).toBe(0)
    setBroken(true)
    await host.due(job)
    await host.due(job)
    expect((await host.due(job))?.note).toContain('请提醒用户检查订阅源')
  })

  it('continues manual checks after an HTTP failure and returns successful results', async () => {
    let failed = false
    let fresh = false
    const host = await createTestHost(factory, {
      fetch: (url) => respond(url, { status: failed && url === URL ? 503 : 200 }),
      parseFeed: (xml) => ({ kind: 'rss1', items: fresh && xml !== URL ? [article('new')] : [article('old')] }),
    })
    const first = await subscribe(host)
    await subscribe(host, 'https://other.example.com/feed.xml')
    failed = true
    fresh = true
    const result = await host.call('check_feed_now')
    expect(result.value).toMatchObject({ ok: false, checks: [{ ok: false }, { ok: true, newCount: 1 }] })
    expect(result.text).toContain('HTTP 503')
    expect(result.text).toContain('示例文章 new')
    expect((await savedState(host)).failures).toBe(1)
  })

  it('checks only the requested subscription and consumes its new content', async () => {
    const { host, setItems } = await fixture()
    const job = await subscribe(host)
    await subscribe(host, 'https://other.example.com/feed.xml')
    setItems([article('new')])
    const result = await host.call('check_feed_now', { url: URL })
    expect((result.value as { checks: unknown[] }).checks).toHaveLength(1)
    expect(host.calls).toHaveLength(3)
    expect(await host.due(job)).toEqual({ wake: false })
    expect((await host.call('check_feed_now', { url: 'https://unknown.example.com/feed' })).value).toMatchObject({
      ok: false,
    })
  })

  it('counts manual failures and does not claim there were no updates when checks failed', async () => {
    const { host, setBroken } = await fixture()
    const job = await subscribe(host)
    setBroken(true)
    const first = await host.call('check_feed_now')
    expect(first.value).toMatchObject({ ok: false })
    expect(first.text).toContain('暂时无法确认是否有新内容')
    expect(first.text).not.toContain('没有发现新内容')
    await host.call('check_feed_now')
    expect((await host.due(job))?.note).toContain('连续 3 次取回失败')
    expect((await savedState(host)).failures).toBe(3)
  })

  it('warns only once per failure streak even after manual failures pass the threshold', async () => {
    const { host, setBroken } = await fixture()
    const job = await subscribe(host)
    setBroken(true)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await host.call('check_feed_now')).text).not.toContain('连续 3 次')
    }
    expect((await host.due(job))?.note).toContain('连续 3 次取回失败')
    expect(await host.due(job)).toEqual({ wake: false })
  })

  it('rebuilds a baseline instead of failing when one feed state is missing', async () => {
    const { host, setItems } = await fixture()
    const job = await subscribe(host)
    await subscribe(host, 'https://other.example.com/feed.xml')
    await host.nxt.storage.delete(stateKey(URL), { scope: 'channel' })
    expect((await host.call('list_feeds')).value).toMatchObject({ ok: true, feeds: [{ failures: 0 }, {}] })
    expect((await host.call('list_feeds')).text).toContain('最近检查：尚未检查')
    setItems([article('new'), article('old')])
    const result = await host.call('check_feed_now')
    expect(result.value).toMatchObject({
      ok: true,
      checks: [
        { ok: true, newCount: 0 },
        { ok: true, newCount: 1 },
      ],
    })
    expect((await savedState(host)).seenIds).toHaveLength(2)
    setItems([article('newer'), article('new'), article('old')])
    expect((await host.due(job))?.note).toContain('示例文章 newer')
  })

  it('recreates periodic jobs deleted outside the extension', async () => {
    const { host } = await fixture()
    const job = await subscribe(host)
    await host.nxt.jobs.cancel(job.jobId)
    expect(host.jobs.size).toBe(0)
    const listed = (await host.call('list_feeds')).value as { feeds: { jobId: string }[] }
    expect(host.jobs.size).toBe(1)
    expect(host.jobs.get(listed.feeds[0]!.jobId)).toMatchObject({ cron: '*/30 * * * *', payload: { url: URL } })
    await host.nxt.jobs.cancel(listed.feeds[0]!.jobId)
    const again = await host.call('subscribe_feed', { url: URL })
    expect(again.text).toContain('已恢复定时检查')
    expect(host.jobs.size).toBe(1)
    expect((await host.call('subscribe_feed', { url: URL })).text).toContain('无需重复添加')
    await host.nxt.jobs.cancel([...host.jobs.keys()][0]!)
    await host.call('check_feed_now', { url: URL })
    expect(host.jobs.size).toBe(1)
    expect(host.calls).toHaveLength(2)
  })

  it('checks all feeds in batches of at most four', async () => {
    let active = 0
    let peak = 0
    const host = await createTestHost(factory, {
      fetch: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return respond('<rss/>')
      },
      parseFeed: () => ({ kind: 'rss2', items: [article('old')] }),
    })
    for (let index = 0; index < 6; index += 1) await subscribe(host, `https://news.example.com/feed-${index}.xml`)
    peak = 0
    const result = await host.call('check_feed_now')
    expect((result.value as { checks: unknown[] }).checks).toHaveLength(6)
    expect(peak).toBe(4)
  })

  it('serializes concurrent manual checks so new content is returned once', async () => {
    const { host, setItems } = await fixture()
    await subscribe(host)
    setItems([article('new')])
    const results = await Promise.all([host.call('check_feed_now'), host.call('check_feed_now')])
    expect(results.map((result) => (result.value as { checks: { newCount: number }[] }).checks[0]!.newCount)).toEqual([
      1, 0,
    ])
  })

  it('cancels subscriptions by URL or index and discards stale due jobs', async () => {
    const { host } = await fixture()
    const first = await subscribe(host)
    const second = await subscribe(host, 'https://other.example.com/feed.xml')
    expect((await host.call('unsubscribe_feed', { index: 1 })).text).toContain('对应的周期任务')
    expect(host.jobs.has(first.jobId)).toBe(false)
    expect(await savedState(host)).toBeUndefined()
    expect((await host.call('list_feeds')).value).toMatchObject({
      feeds: [{ index: 1, url: 'https://other.example.com/feed.xml' }],
    })
    expect(
      (await host.call('unsubscribe_feed', { url: 'https://other.example.com/feed.xml#fragment' })).value,
    ).toMatchObject({ ok: true })
    expect(host.jobs.has(second.jobId)).toBe(false)
    expect(await host.due(first)).toEqual({ wake: false })
    expect(host.calls).toHaveLength(2)
    expect((await host.call('list_feeds')).text).toBe('当前频道还没有订阅。')
  })

  it('rejects ambiguous, missing and out-of-range unsubscribe targets', async () => {
    const { host } = await fixture()
    for (const args of [
      {},
      { url: URL, index: 1 },
      { index: 0 },
      { index: 21 },
      { index: 1.5 },
      { index: 1 },
      { url: URL },
    ]) {
      expect((await host.call('unsubscribe_feed', args)).value).toMatchObject({ ok: false })
    }
    expect(host.jobs.size).toBe(0)
  })

  it('returns readable fetch, XML parsing and missing-body errors without creating a job', async () => {
    const { host, setStatus } = await fixture()
    setStatus(503)
    expect((await host.call('subscribe_feed', { url: URL })).text).toContain('HTTP 503')
    expect(host.jobs.size).toBe(0)
    const invalid = await createTestHost(factory, {
      fetch: () => respond('<html/>'),
      parseFeed: () => {
        throw new Error('没有识别到 RSS 或 Atom 订阅源。')
      },
    })
    expect((await invalid.call('subscribe_feed', { url: URL })).text).toContain('没有识别到 RSS 或 Atom')
    expect(invalid.jobs.size).toBe(0)
    const empty = await createTestHost(factory, { fetch: () => respond('') })
    expect((await empty.call('subscribe_feed', { url: URL })).text).toContain('没有返回 XML 文本')
    expect(empty.storage.size).toBe(0)
  })

  it('returns job quota errors and cleans up jobs when storage fails', async () => {
    const { host } = await fixture()
    const schedule = vi.spyOn(host.nxt.jobs, 'schedule').mockRejectedValueOnce(new Error('已达到示例任务配额'))
    expect((await host.call('subscribe_feed', { url: URL })).text).toContain('任务配额')
    expect(host.storage.size).toBe(0)
    schedule.mockRestore()
    const set = vi.spyOn(host.nxt.storage, 'set')
    const original = set.getMockImplementation()!
    set.mockImplementation(async (key, value, options) => {
      if (key === 'rss.feeds') throw new Error('示例存储不可用')
      return original(key, value, options)
    })
    expect((await host.call('subscribe_feed', { url: URL })).value).toMatchObject({ ok: false })
    expect(host.jobs.size).toBe(0)
    expect(host.storage.size).toBe(0)
  })

  it('does not remove a subscription when job cancellation fails', async () => {
    const { host } = await fixture()
    const job = await subscribe(host)
    vi.spyOn(host.nxt.jobs, 'cancel').mockRejectedValueOnce(new Error('示例任务取消失败'))
    expect((await host.call('unsubscribe_feed', { index: 1 })).text).toContain('任务取消失败')
    expect(host.jobs.has(job.jobId)).toBe(true)
    expect((await host.call('list_feeds')).value).toMatchObject({ feeds: [{ jobId: job.jobId }] })
  })

  it('times out before the host job deadline, skips busy jobs and ignores late responses', async () => {
    let slow = false
    let resolveLate: ((response: NxtFetchResponse) => void) | undefined
    const host = await createTestHost(factory, {
      fetch: () =>
        slow
          ? new Promise<NxtFetchResponse>((resolve) => {
              resolveLate = resolve
            })
          : respond('<rss/>'),
      parseFeed: () => ({ kind: 'rss2', items: slow ? [article('late')] : [article('old')] }),
    })
    const job = await subscribe(host)
    vi.useFakeTimers()
    slow = true
    const checking = host.call('check_feed_now')
    await vi.advanceTimersByTimeAsync(0)
    expect(await host.due(job)).toEqual({ wake: false })
    await vi.advanceTimersByTimeAsync(8001)
    expect((await checking).text).toContain('8 秒')
    const afterTimeout = await savedState(host)
    expect(afterTimeout.failures).toBe(1)
    vi.useRealTimers()
    resolveLate?.(respond('<rss/>'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await savedState(host)).toEqual(afterTimeout)
  })

  it('runs every manifest verification input without side effects', async () => {
    const { host } = await fixture()
    const definition = JSON.parse(readFileSync(new globalThis.URL('../extension.json', import.meta.url), 'utf8')) as {
      contributions: {
        kind: string
        name?: string
        verificationInput?: Record<string, string | number>
      }[]
    }
    for (const contribution of definition.contributions) {
      if (contribution.kind === 'tool') await host.call(contribution.name!, contribution.verificationInput)
    }
    expect(host.calls).toEqual([])
    expect(host.jobs.size).toBe(0)
    expect(host.storage.size).toBe(0)
  })
})
