import { describe, expect, it, vi } from 'vitest'
import { createTestHost, respond } from '../../../tools/testing.js'
import factory from '../src/host.js'

const html = '<html><title>示例文章</title><body><p>示例正文</p></body></html>'
const parsed = { title: '示例文章', markdown: '示例正文', truncated: false, links: [] }

describe('网页阅读', () => {
  it('reads HTML and uses the final URL and default article options', async () => {
    const host = await createTestHost(factory, {
      fetch: () => ({
        ...respond(html, { contentType: 'text/html; charset=utf-8' }),
        url: 'https://example.com/final/',
      }),
      parseHtml: (input) => {
        expect(input).toBe(html)
        return parsed
      },
    })
    const spy = vi.spyOn(host.nxt.parse, 'html')
    const { value, text } = await host.call('read_webpage', { url: ' https://example.com/ ' })
    expect([...host.tools.keys()]).toEqual(['read_webpage'])
    expect(host.calls[0]).toMatchObject({
      target: 'https://example.com/',
      input: { headers: { accept: 'text/html, application/xhtml+xml' } },
    })
    expect(spy).toHaveBeenCalledWith(html, { url: 'https://example.com/final/', mode: 'article', maxChars: 6000 })
    expect(value).toMatchObject({ ok: true, url: 'https://example.com/final/', ...parsed })
    expect(text).toContain('示例文章')
    expect(text).toContain('外部网页内容')
    expect(text).not.toContain('正文已截断')
  })

  it('supports full mode and XHTML and bounds parser suffixes and links', async () => {
    const host = await createTestHost(factory, {
      fetch: () => respond(html, { contentType: 'application/xhtml+xml' }),
      parseHtml: () => ({
        title: '题'.repeat(300),
        markdown: '文'.repeat(20) + '\n…',
        truncated: true,
        links: Array.from({ length: 8 }, (_, i) => ({ text: '链'.repeat(200), url: `https://example.com/${i}` })),
      }),
    })
    const spy = vi.spyOn(host.nxt.parse, 'html')
    const { value, text } = await host.call('read_webpage', { url: 'http://example.com/', mode: 'full', maxChars: 20 })
    expect(spy).toHaveBeenCalledWith(html, { url: 'https://example.test/', mode: 'full', maxChars: 20 })
    expect(value).toMatchObject({ ok: true, markdown: '文'.repeat(20), truncated: true, title: '题'.repeat(200) })
    const links = (value as { links: { text: string }[] }).links
    expect(links).toHaveLength(5)
    expect(links[0]?.text).toHaveLength(100)
    expect(text).toContain('正文已截断')
    expect(text).not.toContain('https://example.com/5')
  })

  it.each([1, 6000, 20000])('strictly limits Markdown to %i characters', async (maxChars) => {
    const host = await createTestHost(factory, {
      fetch: () => respond(html, { contentType: 'text/html' }),
      parseHtml: () => ({
        markdown: '文'.repeat(20001),
        truncated: false,
        links: [{ text: '', url: 'https://example.com/link' }],
      }),
    })
    const { value, text } = await host.call('read_webpage', { url: 'https://example.com/', maxChars })
    expect(value).toMatchObject({ ok: true, title: '无标题网页', truncated: true, markdown: '文'.repeat(maxChars) })
    expect(text).toContain('链接：https://example.com/link')
  })

  it.each([
    {},
    { url: '' },
    { url: 42 },
    { url: 'bad url' },
    { url: 'ftp://example.com/' },
    { url: 'file:///test' },
    { url: 'https://user:password@example.com/' },
  ])('rejects invalid addresses %j without fetching', async (args) => {
    const host = await createTestHost(factory)
    expect((await host.call('read_webpage', args)).value).toMatchObject({ ok: false })
    expect(host.calls).toEqual([])
  })

  it.each([
    [0, 1],
    [20001, 20000],
    [1.5, 2],
  ])('clamps maxChars %d to %d', async (maxChars, expected) => {
    const host = await createTestHost(factory, {
      fetch: () => respond(html, { contentType: 'text/html' }),
      parseHtml: () => parsed,
    })
    const spy = vi.spyOn(host.nxt.parse, 'html')
    await host.call('read_webpage', { url: 'https://example.com/', maxChars })
    expect(spy).toHaveBeenCalledWith(html, { url: 'https://example.test/', mode: 'article', maxChars: expected })
  })

  it('decodes XHTML that the host returns only as base64', async () => {
    const xhtml = '<html><title>示例文章</title><body><p>中文正文</p></body></html>'
    const host = await createTestHost(factory, {
      fetch: () => ({
        url: 'https://example.com/page.xhtml',
        status: 200,
        headers: {},
        contentType: 'application/xhtml+xml',
        base64: Buffer.from(xhtml).toString('base64'),
      }),
      parseHtml: (input) => {
        expect(input).toBe(xhtml)
        return parsed
      },
    })
    const { value } = await host.call('read_webpage', { url: 'https://example.com/page.xhtml' })
    expect(value).toMatchObject({ ok: true, url: 'https://example.com/page.xhtml', title: '示例文章' })
  })

  it.each([403, 404, 500, 302])('explains HTTP %i without parsing', async (status) => {
    const host = await createTestHost(factory, { fetch: () => respond(html, { status, contentType: 'text/html' }) })
    expect((await host.call('read_webpage', { url: 'https://example.com/' })).text).toContain(`HTTP ${status}`)
  })

  it.each(['application/pdf', 'image/png', 'application/json', 'text/plain', ''])(
    'rejects non-HTML %s',
    async (contentType) => {
      const host = await createTestHost(factory, { fetch: () => respond('文件', { contentType }) })
      expect((await host.call('read_webpage', { url: 'https://example.com/' })).text).toContain('不是 HTML')
    },
  )

  it('explains empty HTML and empty parsed content', async () => {
    const emptyHtml = await createTestHost(factory, { fetch: () => respond(' ', { contentType: 'text/html' }) })
    expect((await emptyHtml.call('read_webpage', { url: 'https://example.com/' })).text).toContain('没有返回')
    const emptyBody = await createTestHost(factory, {
      fetch: () => respond(html, { contentType: 'text/html' }),
      parseHtml: () => ({ ...parsed, markdown: '' }),
    })
    expect((await emptyBody.call('read_webpage', { url: 'https://example.com/' })).text).toContain('mode: full')
  })

  it('returns readable failures with the cause for network and parser exceptions', async () => {
    const network = await createTestHost(factory, {
      fetch: () => {
        throw new Error('网络不可用')
      },
    })
    expect((await network.call('read_webpage', { url: 'https://example.com/' })).value).toEqual({
      ok: false,
      message: '读取网页失败：网络不可用',
    })
    const parser = await createTestHost(factory, {
      fetch: () => respond(html, { contentType: 'text/html' }),
      parseHtml: () => {
        throw new Error('解' + '析'.repeat(300))
      },
    })
    const { value } = await parser.call('read_webpage', { url: 'https://example.com/' })
    expect((value as { message: string }).message).toBe(`读取网页失败：解${'析'.repeat(199)}`)
  })
})
