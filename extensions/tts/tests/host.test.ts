import { describe, expect, it, vi } from 'vitest'
import { createTestHost, respond } from '../../../tools/testing.js'
import factory from '../src/host.js'
import definition from '../extension.json' with { type: 'json' }

const secrets = { apiKey: 'sk-fixture' }
const audio = Buffer.from('ID3-fixture-audio').toString('base64')
const success = () => ({
  url: 'https://speech.example.com/v1/audio/speech',
  status: 200,
  headers: {},
  contentType: 'audio/mpeg',
  base64: audio,
})

describe('语音合成', () => {
  it('never bills verification samples even with credentials', async () => {
    const host = await createTestHost(factory, { secrets })
    expect([...host.tools.keys()]).toEqual(['speak'])
    expect((await host.call('speak', definition.contributions[0]!.verificationInput)).text).toContain('text')
    expect(host.calls).toEqual([])
    expect(host.assets).toEqual([])
  })

  it('requires a secret and ignores credentials in ordinary configuration', async () => {
    for (const options of [{}, { secrets: { apiKey: ' ' } }, { config: { apiKey: 'not-a-secret' } }]) {
      const host = await createTestHost(factory, options)
      expect((await host.call('speak', { text: '示例朗读' })).text).toContain('还没有配置')
      expect(host.calls).toEqual([])
    }
  })

  it('posts defaults and saves MP3 for audio delivery', async () => {
    const host = await createTestHost(factory, { secrets, fetch: success })
    const { value, text } = await host.call('speak', { text: ' 示例朗读 ' })
    expect(host.calls[0]).toMatchObject({
      target: 'https://api.openai.com/v1/audio/speech',
      input: { method: 'POST', headers: { authorization: 'Bearer sk-fixture', accept: 'audio/mpeg' } },
    })
    expect(JSON.parse((host.calls[0]?.input as { body: string }).body)).toEqual({
      model: 'tts-1',
      input: '示例朗读',
      voice: 'alloy',
      response_format: 'mp3',
    })
    expect(host.assets).toEqual([
      expect.objectContaining({ assetId: 'ast_1', base64: audio, mediaType: 'audio/mpeg', name: 'speech.mp3' }),
    ])
    expect(value).toEqual({ ok: true, assetId: 'ast_1', mediaType: 'audio/mpeg' })
    expect(text).toContain('send_channel_message 的 audio')
    expect(text).not.toContain(audio)
    expect(text).not.toContain('示例朗读')
  })

  it('preserves base paths and respects configured voice and overrides', async () => {
    const host = await createTestHost(factory, {
      secrets,
      config: { endpoint: 'https://speech.example.com/proxy/v1///', model: 'fixture-tts', voice: 'fixture-voice' },
      fetch: success,
    })
    await host.call('speak', { text: '示例' })
    await host.call('speak', { text: '示例', voice: ' fixture-other ' })
    expect(host.calls[0]?.target).toBe('https://speech.example.com/proxy/v1/audio/speech')
    expect(JSON.parse((host.calls[0]?.input as { body: string }).body)).toMatchObject({
      model: 'fixture-tts',
      voice: 'fixture-voice',
    })
    expect(JSON.parse((host.calls[1]?.input as { body: string }).body)).toMatchObject({ voice: 'fixture-other' })
  })

  it.each(['文'.repeat(1000), '🦊'.repeat(1000)])('accepts exactly 1000 Unicode characters', async (text) => {
    const host = await createTestHost(factory, { secrets, fetch: success })
    expect((await host.call('speak', { text })).value).toMatchObject({ ok: true })
    expect(JSON.parse((host.calls[0]?.input as { body: string }).body).input).toBe(text)
  })

  it.each([
    {},
    { text: '' },
    { text: ' ' },
    { text: 42 },
    { text: '文'.repeat(1001) },
    { text: '示例', voice: '' },
    { text: '示例', voice: 42 },
    { text: '示例', voice: null },
  ])('rejects invalid input without fetching', async (args) => {
    const host = await createTestHost(factory, { secrets })
    expect((await host.call('speak', args)).value).toMatchObject({ ok: false })
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
    const host = await createTestHost(factory, { secrets, config: { endpoint } })
    expect((await host.call('speak', { text: '示例' })).text).toContain('服务地址无效')
    expect(host.calls).toEqual([])
  })

  it('falls back to default model and voice when they are blank', async () => {
    const host = await createTestHost(factory, { secrets, config: { model: ' ', voice: '' }, fetch: success })
    await host.call('speak', { text: '示例' })
    expect(JSON.parse((host.calls[0]?.input as { body: string }).body)).toMatchObject({
      model: 'tts-1',
      voice: 'alloy',
    })
  })

  it('reports the media type recognized by the host', async () => {
    const host = await createTestHost(factory, { secrets, fetch: success })
    vi.spyOn(host.nxt.assets, 'create').mockResolvedValueOnce({
      assetId: 'ast_9',
      byteSize: 17,
      mediaType: 'audio/ogg',
    })
    expect((await host.call('speak', { text: '示例' })).value).toEqual({
      ok: true,
      assetId: 'ast_9',
      mediaType: 'audio/ogg',
    })
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
    expect((await host.call('speak', { text: '示例' })).text).toContain(String(message))
    expect(host.calls).toHaveLength(1)
    expect(host.assets).toEqual([])
  })

  it.each(['audio/mpeg; charset=binary', 'audio/mp3', 'application/octet-stream'])(
    'accepts MP3 response type %s',
    async (contentType) => {
      const host = await createTestHost(factory, { secrets, fetch: () => ({ ...success(), contentType }) })
      expect((await host.call('speak', { text: '示例' })).value).toMatchObject({ ok: true, mediaType: 'audio/mpeg' })
    },
  )

  it.each(['application/json', 'text/plain', 'audio/wav', 'text/event-stream'])(
    'rejects response type %s',
    async (contentType) => {
      const host = await createTestHost(factory, { secrets, fetch: () => ({ ...success(), contentType }) })
      expect((await host.call('speak', { text: '示例' })).text).toContain('没有返回 MP3')
      expect(host.assets).toEqual([])
    },
  )

  it('rejects empty audio', async () => {
    const host = await createTestHost(factory, { secrets, fetch: () => ({ ...success(), base64: '' }) })
    expect((await host.call('speak', { text: '示例' })).text).toContain('音频为空')
    expect(host.assets).toEqual([])
  })

  it('explains failures with the cause and warns about billing only on timeouts', async () => {
    const network = await createTestHost(factory, {
      secrets,
      fetch: () => {
        throw new Error('连接被拒绝')
      },
    })
    expect((await network.call('speak', { text: '示例' })).value).toEqual({
      ok: false,
      message: '语音合成失败：连接被拒绝',
    })
    expect(network.calls).toHaveLength(1)
    for (const reason of ['外部服务 30 秒无响应', 'Request Timeout']) {
      const slow = await createTestHost(factory, {
        secrets,
        fetch: () => {
          throw new Error(reason)
        },
      })
      const { text } = await slow.call('speak', { text: '示例' })
      expect(text).toContain(`语音合成失败：${reason}`)
      expect(text).toContain('服务端可能仍在生成并已计费')
    }
    const long = await createTestHost(factory, {
      secrets,
      fetch: () => {
        throw new Error('错'.repeat(300))
      },
    })
    expect((await long.call('speak', { text: '示例' })).value).toEqual({
      ok: false,
      message: `语音合成失败：${'错'.repeat(200)}`,
    })
    const host = await createTestHost(factory, { secrets, fetch: success })
    vi.spyOn(host.nxt.assets, 'create').mockRejectedValueOnce(new Error('保存失败'))
    expect((await host.call('speak', { text: '示例' })).value).toEqual({ ok: false, message: '语音合成失败：保存失败' })
    expect(host.calls).toHaveLength(1)
  })
})
