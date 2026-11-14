import { describe, expect, it, vi } from 'vitest'
import { createTestHost, respond } from '../../../tools/testing.js'
import factory from '../src/host.js'

describe('网页搜索', () => {
  it('adds a static guide and asks for an API key when the host has none to fill in', async () => {
    const fetch = vi.fn(() => respond({}))
    const host = await createTestHost(factory, { fetch })
    const get = vi.spyOn(host.hostNxt.secrets, 'get')
    expect(host.prompts.static.get('web-search-guide')).toContain('web_search')
    const { value } = await host.call('web_search', { query: '今天的新闻' })
    expect(value).toEqual({
      ok: false,
      message:
        '搜索失败：凭据字段 apiKey 还没有设置，或者绑定的凭据不对当前智能体开放。如果还没有填写博查的 API Key，请在扩展配置中填写。',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('relays why the host refused the credential', async () => {
    const host = await createTestHost(factory, {
      secrets: { apiKey: 'tvly-fixture' },
      hostConfig: { endpoint: 'https://api.tavily.com' },
      fetch: () => {
        throw new Error('访问被拒：凭据不允许发往 api.tavily.com。')
      },
    })
    expect((await host.call('web_search', { query: 'q' })).text).toContain(
      '搜索失败：访问被拒：凭据不允许发往 api.tavily.com。',
    )
  })

  it('searches Bocha with the secret and trims results', async () => {
    const host = await createTestHost(factory, {
      secrets: { apiKey: 'sk-fixture' },
      hostConfig: { endpoint: 'https://api.bochaai.com' },
      config: { maxResults: 2 },
      fetch: () =>
        respond({
          code: 200,
          data: {
            webPages: {
              value: [
                {
                  name: '示例新闻',
                  url: 'https://news.example.com/a',
                  summary: '摘要'.repeat(200),
                  datePublished: '2026-10-01T08:00:00Z',
                },
                { name: '第二条', url: 'https://news.example.com/b', snippet: '片段' },
                { name: '第三条', url: 'https://news.example.com/c', snippet: '不应出现' },
                { name: '无效链接', url: 'javascript:alert(1)' },
              ],
            },
          },
        }),
    })
    const { value, text } = await host.call('web_search', { query: '示例', freshness: 'week' })
    const request = host.calls[0]
    expect(request?.target).toBe('https://api.bochaai.com/v1/web-search')
    expect(request?.input).toMatchObject({ headers: { authorization: 'Bearer {{nxt-credential:apiKey}}' } })
    expect(JSON.stringify(host.calls)).not.toContain('sk-fixture')
    expect(JSON.parse(String((request?.input as { body: string }).body))).toMatchObject({
      query: '示例',
      count: 2,
      freshness: 'oneWeek',
    })
    expect(value).toMatchObject({ ok: true, provider: '博查' })
    expect((value as { results: unknown[] }).results).toHaveLength(2)
    expect(text).toContain('1. 示例新闻（2026-10-01）')
    expect(text).not.toContain('第三条')
    expect(text.length).toBeLessThan(800)
  })

  it('supports Tavily and SearXNG by address', async () => {
    const tavily = await createTestHost(factory, {
      secrets: { apiKey: 'tvly-fixture' },
      hostConfig: { endpoint: 'https://api.tavily.com' },
      fetch: () => respond({ results: [{ title: 'T', url: 'https://t.example.com', content: '内容' }] }),
    })
    expect((await tavily.call('web_search', { query: 'q', count: 3 })).text).toContain('（Tavily）')
    expect(tavily.calls[0]).toMatchObject({
      target: 'https://api.tavily.com/search',
      input: { headers: { authorization: 'Bearer {{nxt-credential:apiKey}}' } },
    })

    const searx = await createTestHost(factory, {
      hostConfig: { endpoint: 'http://192.0.2.10:8080/searx' },
      fetch: () => respond({ results: [{ title: 'S', url: 'https://s.example.com', content: '内容' }] }),
    })
    expect((await searx.call('web_search', { query: '关键词', freshness: 'day' })).text).toContain('（SearXNG）')
    // SearXNG 不需要 API Key，请求里也不带凭据。
    expect(JSON.stringify(searx.calls)).not.toContain('nxt-credential')
    expect(searx.calls[0]?.target).toBe(
      'http://192.0.2.10:8080/searx/search?q=%E5%85%B3%E9%94%AE%E8%AF%8D&format=json&time_range=day',
    )
  })

  it('explains provider errors and empty results', async () => {
    const denied = await createTestHost(factory, {
      secrets: { apiKey: 'bad' },
      fetch: () => respond('no', { status: 401 }),
    })
    expect((await denied.call('web_search', { query: 'q' })).text).toContain('检查 API Key')
    const empty = await createTestHost(factory, { secrets: { apiKey: 'k' }, fetch: () => respond({ data: {} }) })
    expect((await empty.call('web_search', { query: '无结果' })).text).toBe('没有找到与「无结果」相关的结果。')
    const broken = await createTestHost(factory, {
      secrets: { apiKey: 'k' },
      fetch: () => {
        throw new Error('网络不可用')
      },
    })
    expect((await broken.call('web_search', { query: 'q' })).text).toBe(
      '搜索失败：网络不可用。如果还没有填写博查的 API Key，请在扩展配置中填写。',
    )
    const searxDown = await createTestHost(factory, {
      hostConfig: { endpoint: 'http://192.0.2.10:8080' },
      fetch: () => {
        throw new Error('网络不可用')
      },
    })
    expect((await searxDown.call('web_search', { query: 'q' })).text).toBe('搜索失败：网络不可用。')
    const invalid = await createTestHost(factory, { hostConfig: { endpoint: 'not a url' } })
    expect((await invalid.call('web_search', { query: 'q' })).text).toContain('地址无效')
  })
})
