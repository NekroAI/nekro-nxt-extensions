import { describe, expect, it, vi } from 'vitest'
import { createTestHost, respond } from '../../../tools/testing.js'
import factory from '../src/host.js'
import definition from '../extension.json' with { type: 'json' }

// 虚构的一像素 PNG，测试不会调用真实服务。
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2kAAAAASUVORK5CYII='
const secrets = { apiKey: 'sk-fixture' }
const success = () => respond({ data: [{ b64_json: png }] })

describe('图片生成', () => {
  it('never bills verification samples even with credentials', async () => {
    const host = await createTestHost(factory, { secrets })
    expect([...host.tools.keys()]).toEqual(['generate_image'])
    expect((await host.call('generate_image', definition.contributions[0]!.verificationInput)).text).toContain('prompt')
    expect(host.calls).toEqual([])
    expect(host.assets).toEqual([])
  })

  it('requests a key without network access', async () => {
    for (const options of [{}, { secrets: { apiKey: ' ' } }, { hostConfig: { apiKey: 'not-a-secret' } }]) {
      const host = await createTestHost(factory, options)
      expect((await host.call('generate_image', { prompt: '虚构狐狸' })).text).toContain('还没有配置')
      expect(host.calls).toEqual([])
    }
  })

  it('uses default settings, sends one PNG request and returns an asset', async () => {
    const host = await createTestHost(factory, { secrets, fetch: success })
    const { value, text } = await host.call('generate_image', { prompt: ' 虚构狐狸 ' })
    expect(host.calls[0]).toMatchObject({
      target: 'https://api.openai.com/v1/images/generations',
      input: { method: 'POST', headers: { authorization: 'Bearer sk-fixture' } },
    })
    expect(JSON.parse((host.calls[0]?.input as { body: string }).body)).toEqual({
      model: 'gpt-image-1',
      prompt: '虚构狐狸',
      size: '1024x1024',
      quality: 'medium',
      n: 1,
      output_format: 'png',
    })
    expect(host.assets).toEqual([
      expect.objectContaining({ assetId: 'ast_1', base64: png, mediaType: 'image/png', name: 'generated-image.png' }),
    ])
    expect(value).toEqual({ ok: true, assetId: 'ast_1', mediaType: 'image/png', size: '1024x1024' })
    expect(text).toContain('send_channel_message 的 image')
    expect(text).not.toContain(png)
    expect(text).not.toContain('sk-fixture')
  })

  it('preserves base paths and respects configured size and overrides', async () => {
    const host = await createTestHost(factory, {
      secrets,
      hostConfig: { endpoint: 'https://images.example.com/proxy/v1///', model: 'fixture-image' },
      config: { size: '1024x1536', quality: 'high' },
      fetch: success,
    })
    expect((await host.call('generate_image', { prompt: '示例' })).value).toMatchObject({ size: '1024x1536' })
    expect((await host.call('generate_image', { prompt: '示例', size: '1536x1024' })).value).toMatchObject({
      size: '1536x1024',
    })
    expect(host.calls[0]?.target).toBe('https://images.example.com/proxy/v1/images/generations')
    expect(JSON.parse((host.calls[1]?.input as { body: string }).body)).toMatchObject({
      model: 'fixture-image',
      size: '1536x1024',
      quality: 'high',
    })
  })

  it.each([
    {},
    { prompt: '' },
    { prompt: ' ' },
    { prompt: 42 },
    { prompt: '示例', size: '512x512' },
    { prompt: '示例', size: null },
  ])('rejects invalid inputs %j without fetching', async (args) => {
    const host = await createTestHost(factory, { secrets })
    expect((await host.call('generate_image', args)).value).toMatchObject({ ok: false })
    expect(host.calls).toEqual([])
  })

  it.each([
    'bad url',
    '',
    'ftp://example.com/v1',
    'https://user:password@example.com/',
    'https://example.com/v1?token=fixture',
    'https://example.com/v1#fragment',
  ])('rejects invalid service address %s', async (endpoint) => {
    const host = await createTestHost(factory, { secrets, hostConfig: { endpoint } })
    expect((await host.call('generate_image', { prompt: '示例' })).text).toContain('服务地址无效')
    expect(host.calls).toEqual([])
  })

  it('falls back to the default model when it is blank', async () => {
    const host = await createTestHost(factory, { secrets, hostConfig: { model: ' ' }, fetch: success })
    await host.call('generate_image', { prompt: '示例' })
    expect(JSON.parse((host.calls[0]?.input as { body: string }).body)).toMatchObject({ model: 'gpt-image-1' })
  })

  it('reports the media type recognized by the host', async () => {
    const host = await createTestHost(factory, { secrets, fetch: success })
    vi.spyOn(host.nxt.assets, 'create').mockResolvedValueOnce({
      assetId: 'ast_9',
      byteSize: 68,
      mediaType: 'image/webp',
    })
    const { value, text } = await host.call('generate_image', { prompt: '示例' })
    expect(value).toMatchObject({ ok: true, assetId: 'ast_9', mediaType: 'image/webp' })
    expect(text).toContain('image/webp')
  })

  it.each([
    [401, '检查 API Key'],
    [403, '访问权限'],
    [429, '额度不足'],
    [500, 'HTTP 500'],
    [302, 'HTTP 302'],
  ])('explains provider status %i without saving or retrying', async (status, message) => {
    const host = await createTestHost(factory, {
      secrets,
      fetch: () => respond('敏感服务错误', { status: Number(status) }),
    })
    expect((await host.call('generate_image', { prompt: '示例' })).text).toContain(String(message))
    expect(host.calls).toHaveLength(1)
    expect(host.assets).toEqual([])
  })

  it.each([
    ['not JSON', '有效的 JSON'],
    [{}, '没有返回图片数据'],
    [{ data: [] }, '没有返回图片数据'],
    [{ data: [null] }, '没有返回图片数据'],
    [{ data: [{ url: 'https://cdn.example.com/image.png' }] }, '不支持跨域下载'],
  ])('explains malformed response %j', async (body, message) => {
    const host = await createTestHost(factory, { secrets, fetch: () => respond(body) })
    expect((await host.call('generate_image', { prompt: '示例' })).text).toContain(String(message))
    expect(host.assets).toEqual([])
    expect(host.calls).toHaveLength(1)
  })

  it('explains failures with the cause and warns about billing only on timeouts', async () => {
    const network = await createTestHost(factory, {
      secrets,
      fetch: () => {
        throw new Error('连接被拒绝')
      },
    })
    const failure = await network.call('generate_image', { prompt: '示例' })
    expect(failure.value).toEqual({ ok: false, message: '生成图片失败：连接被拒绝' })
    expect(network.calls).toHaveLength(1)
    for (const reason of ['外部服务 30 秒无响应', 'Request Timeout']) {
      const slow = await createTestHost(factory, {
        secrets,
        fetch: () => {
          throw new Error(reason)
        },
      })
      const { text } = await slow.call('generate_image', { prompt: '示例' })
      expect(text).toContain(`生成图片失败：${reason}`)
      expect(text).toContain('服务端可能仍在生成并已计费')
    }
    const long = await createTestHost(factory, {
      secrets,
      fetch: () => {
        throw new Error('错'.repeat(300))
      },
    })
    expect((await long.call('generate_image', { prompt: '示例' })).value).toEqual({
      ok: false,
      message: `生成图片失败：${'错'.repeat(200)}`,
    })
    const host = await createTestHost(factory, { secrets, fetch: success })
    vi.spyOn(host.nxt.assets, 'create').mockRejectedValueOnce(new Error('保存失败'))
    expect((await host.call('generate_image', { prompt: '示例' })).value).toEqual({
      ok: false,
      message: '生成图片失败：保存失败',
    })
    expect(host.calls).toHaveLength(1)
  })
})
