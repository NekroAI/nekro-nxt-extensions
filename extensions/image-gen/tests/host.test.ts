import { describe, expect, it, vi } from 'vitest'
import { ConfigSchemaDocumentSchema, validateConfigValue } from '@nekro-nxt/contracts'
import type { NxtFetchInit } from '@nekro-nxt/extension-sdk'
import { createTestHost, respond, type FetchHandler } from '../../../tools/testing.js'
import factory from '../src/host.js'
import definition from '../extension.json' with { type: 'json' }

// 虚构的图片数据，测试不会调用真实服务。
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2kAAAAASUVORK5CYII='
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64')
const secrets = { apiKey: 'sk-fixture' }
const nekro = 'https://api.nekro.ai/v1'

const bodyOf = (init: unknown) => JSON.parse((init as NxtFetchInit).body ?? '') as Record<string, unknown>
const headersOf = (init: unknown) => (init as NxtFetchInit).headers ?? {}
const imagesOk: FetchHandler = () => respond({ data: [{ b64_json: png }] })
const geminiOk: FetchHandler = () =>
  respond({
    candidates: [
      {
        content: {
          parts: [
            { text: '草稿', thought: true },
            { inlineData: { mimeType: 'image/png', data: png }, thought: true },
            { text: '好的，这是图片。' },
            { inlineData: { mimeType: 'image/jpeg', data: jpeg } },
          ],
        },
        finishReason: 'STOP',
      },
    ],
  })

const hostSchema = ConfigSchemaDocumentSchema.parse(definition.config.host.schema)
const agentSchema = ConfigSchemaDocumentSchema.parse(definition.config.agent.schema)
/** 宿主升级时的规则：旧配置（去掉凭据字段）通过新 schema 校验才原样保留，否则整体重置为默认值。 */
const carry = (schema: typeof hostSchema, previous: Record<string, string>) =>
  validateConfigValue(schema, previous, { skipKeys: ['apiKey'] })

describe('图片生成', () => {
  it('never bills verification samples even with credentials', async () => {
    const host = await createTestHost(factory, { secrets })
    expect([...host.tools.keys()]).toEqual(['generate_image'])
    expect((await host.call('generate_image', definition.contributions[0]!.verificationInput)).text).toContain('prompt')
    expect(host.calls).toEqual([])
    expect(host.assets).toEqual([])
  })

  it('asks for the API Key when the host has none to fill in, without reading it in code', async () => {
    for (const options of [{}, { hostConfig: { apiKey: 'not-a-secret' } }]) {
      const fetch = vi.fn(geminiOk)
      const host = await createTestHost(factory, { ...options, fetch })
      const get = vi.spyOn(host.hostNxt.secrets, 'get')
      expect((await host.call('generate_image', { prompt: '虚构狐狸' })).value).toEqual({
        ok: false,
        message:
          '生成图片失败：凭据字段 apiKey 还没有设置，或者绑定的凭据不对当前智能体开放。如果还没有填写 API Key，请在扩展配置中填写。',
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(get).not.toHaveBeenCalled()
      expect(host.assets).toEqual([])
    }
  })

  it('relays why the host refused the credential', async () => {
    const host = await createTestHost(factory, {
      secrets,
      fetch: () => {
        throw new Error('访问被拒：凭据不允许发往 api.nekro.ai。')
      },
    })
    expect((await host.call('generate_image', { prompt: '虚构狐狸' })).text).toBe(
      '生成图片失败：访问被拒：凭据不允许发往 api.nekro.ai。如果还没有填写 API Key，请在扩展配置中填写。',
    )
  })

  it('puts the credential placeholder, never the key, into every interface', async () => {
    const chatOk: FetchHandler = () =>
      respond({ choices: [{ message: { content: `![](data:image/png;base64,${png})` } }] })
    const cases = [
      { model: 'gpt-image-2', fetch: imagesOk, target: `${nekro}/images/generations`, references: [] },
      { model: 'gpt-image-2', fetch: imagesOk, target: `${nekro}/images/edits`, references: ['ast_ref1'] },
      { model: 'fixture-chat-image', api: 'chat', fetch: chatOk, target: `${nekro}/chat/completions`, references: [] },
    ]
    for (const { model, api, fetch, target, references } of cases) {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model, ...(api ? { api } : {}) },
        fetch,
      })
      host.addPicture('ast_ref1', { channels: ['chn_TEST'], base64: png })
      const { value } = await host.call('generate_image', { prompt: '示例', reference_images: references })
      expect(value).toMatchObject({ ok: true })
      expect(host.calls[0]!.target).toBe(target)
      expect(headersOf(host.calls[0]!.input)['authorization']).toBe('Bearer {{nxt-credential:apiKey}}')
      expect(JSON.stringify(host.calls)).not.toContain('sk-fixture')
    }
  })

  describe('默认预设：NekroAPI 与 Gemini 接口', () => {
    it('sends a generateContent request with the ratio and a 1K size', async () => {
      const host = await createTestHost(factory, { secrets, fetch: geminiOk })
      const { value, text } = await host.call('generate_image', { prompt: ' 虚构狐狸 ' })
      const call = host.calls[0]!
      expect(call.target).toBe('https://api.nekro.ai/v1beta/models/gemini-nano-banana-2.1:generateContent')
      expect(headersOf(call.input)).toMatchObject({
        authorization: 'Bearer {{nxt-credential:apiKey}}',
        'x-goog-api-key': '{{nxt-credential:apiKey}}',
      })
      expect((call.input as NxtFetchInit).timeoutMs).toBe(180_000)
      expect(bodyOf(call.input)).toEqual({
        contents: [{ role: 'user', parts: [{ text: '虚构狐狸' }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '1:1' },
        },
      })
      // 跳过思考草稿，取最终图片，并按文件头识别格式。
      expect(host.assets).toEqual([
        expect.objectContaining({
          assetId: 'ast_1',
          base64: jpeg,
          mediaType: 'image/jpeg',
          name: 'generated-image.jpg',
        }),
      ])
      expect(value).toEqual({
        ok: true,
        assetId: 'ast_1',
        mediaType: 'image/jpeg',
        model: 'gemini-nano-banana-2.1',
        aspectRatio: '1:1',
        seconds: 1,
      })
      expect(text).toContain('模型 gemini-nano-banana-2.1，画幅 1:1，用时 1 秒')
      expect(text).toContain('send_channel_message 的 image')
      expect(text).not.toContain(jpeg)
      expect(text).not.toContain('sk-fixture')
      expect(host.progress).toEqual(['正在用 gemini-nano-banana-2.1 生成图片'])
    })

    it('uses the ratio argument, the high-quality size and omits imageSize for models without it', async () => {
      const pro = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'gemini-3-pro-image' },
        config: { quality: 'high', size: '9:16' },
        fetch: geminiOk,
      })
      await pro.call('generate_image', { prompt: '示例' })
      await pro.call('generate_image', { prompt: '示例', aspect_ratio: '4:3' })
      expect(bodyOf(pro.calls[0]!.input)['generationConfig']).toMatchObject({
        imageConfig: { aspectRatio: '9:16', imageSize: '2K' },
      })
      expect(bodyOf(pro.calls[1]!.input)['generationConfig']).toMatchObject({ imageConfig: { aspectRatio: '4:3' } })
      const banana = await createTestHost(factory, {
        secrets,
        hostConfig: { preset: 'gemini-nano-banana-2.1' },
        config: { quality: 'high' },
        fetch: geminiOk,
      })
      await banana.call('generate_image', { prompt: '示例' })
      expect(bodyOf(banana.calls[0]!.input)['generationConfig']).toMatchObject({
        imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
      })
      const other = await createTestHost(factory, {
        secrets,
        hostConfig: { preset: 'custom', model: 'fixture-gemini-image' },
        config: { quality: 'high' },
        fetch: geminiOk,
      })
      await other.call('generate_image', { prompt: '示例' })
      expect(bodyOf(other.calls[0]!.input)['generationConfig']).toEqual({
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '1:1' },
      })
    })

    it('explains a text-only or blocked reply', async () => {
      const host = await createTestHost(factory, {
        secrets,
        fetch: () =>
          respond({ candidates: [{ content: { parts: [{ text: '无法生成这类内容' }] }, finishReason: 'SAFETY' }] }),
      })
      expect((await host.call('generate_image', { prompt: '示例' })).text).toBe(
        '图片服务没有返回图片，只回复了文字：无法生成这类内容（SAFETY）',
      )
      expect(host.assets).toEqual([])
    })
  })

  describe('OpenAI 生图接口', () => {
    it('asks GPT Image for b64 and maps ratios to supported sizes', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'gpt-image-2' },
        config: { quality: 'medium' },
        fetch: imagesOk,
      })
      const square = await host.call('generate_image', { prompt: '示例' })
      expect(host.calls[0]!.target).toBe(`${nekro}/images/generations`)
      expect(bodyOf(host.calls[0]!.input)).toEqual({
        model: 'gpt-image-2',
        prompt: '示例',
        n: 1,
        size: '1024x1024',
        quality: 'medium',
        response_format: 'b64_json',
      })
      expect(square.value).toMatchObject({ ok: true, mediaType: 'image/png', aspectRatio: '1:1' })
      expect(square.text).not.toContain('最接近')
      const wide = await host.call('generate_image', { prompt: '示例', aspect_ratio: '16:9' })
      expect(bodyOf(host.calls[1]!.input)).toMatchObject({ size: '1536x1024' })
      expect(wide.text).toContain('已按最接近的 3:2 生成')
    })

    it('retries once without response_format when the service rejects it, then downloads a same-host URL', async () => {
      const replies = [
        respond({ error: { message: "Unknown parameter: 'response_format'." } }, { status: 400 }),
        respond({ data: [{ url: 'https://api.nekro.ai/files/fixture.png' }] }),
      ]
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'gpt-image-2' },
        fetch: () => replies.shift()!,
        fromUrl: () => ({ base64: png, mediaType: 'image/png' }),
      })
      expect((await host.call('generate_image', { prompt: '示例' })).value).toMatchObject({ ok: true })
      expect(bodyOf(host.calls[0]!.input)).toMatchObject({ response_format: 'b64_json' })
      expect(bodyOf(host.calls[1]!.input)).not.toHaveProperty('response_format')
      expect(host.calls[2]).toMatchObject({ target: 'https://api.nekro.ai/files/fixture.png' })
    })

    it('does not retry other client errors', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'gpt-image-2' },
        fetch: () => respond({ error: { message: 'invalid size' } }, { status: 400 }),
      })
      expect((await host.call('generate_image', { prompt: '示例' })).text).toContain('HTTP 400：invalid size')
      expect(host.calls).toHaveLength(1)
    })

    it('keeps only the first picture when the service returns more than asked', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'gpt-image-2' },
        fetch: () => respond({ data: [{ b64_json: png }, { b64_json: jpeg }] }),
      })
      await host.call('generate_image', { prompt: '示例' })
      expect(host.assets).toEqual([expect.objectContaining({ base64: png, mediaType: 'image/png' })])
    })

    it('asks Seedream for b64 at a 2K size', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'doubao-seedream-5-0-260128' },
        fetch: () => respond({ data: [{ b64_json: jpeg }] }),
      })
      expect((await host.call('generate_image', { prompt: '示例', aspect_ratio: '3:4' })).value).toMatchObject({
        ok: true,
        mediaType: 'image/jpeg',
      })
      expect(bodyOf(host.calls[0]!.input)).toEqual({
        model: 'doubao-seedream-5-0-260128',
        prompt: '示例',
        n: 1,
        size: '1728x2304',
        response_format: 'b64_json',
      })
    })

    it('writes the ratio into the prompt for models without a size parameter', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'grok-imagine-image-2.0' },
        fetch: imagesOk,
      })
      await host.call('generate_image', { prompt: '示例', aspect_ratio: '16:9' })
      expect(bodyOf(host.calls[0]!.input)).toEqual({
        model: 'grok-imagine-image-2.0',
        prompt: '示例\n\n画幅：横版 16:9。',
        n: 1,
        response_format: 'b64_json',
      })
    })

    it('downloads a URL result on the service host into an Asset', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'doubao-seedream-5-0-260128' },
        fetch: () => respond({ data: [{ url: 'https://api.nekro.ai/files/fixture.jpeg' }] }),
        fromUrl: () => ({ base64: jpeg, mediaType: 'image/jpeg' }),
      })
      const { value } = await host.call('generate_image', { prompt: '示例' })
      expect(value).toMatchObject({ ok: true, assetId: 'ast_1', mediaType: 'image/jpeg' })
      expect(host.calls[1]).toMatchObject({
        target: 'https://api.nekro.ai/files/fixture.jpeg',
        input: { fromUrl: true },
      })
      expect(host.assets[0]).toMatchObject({ base64: jpeg, name: 'generated-image' })
    })

    it('downloads a URL result on another domain, which the network permission covers', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'grok-imagine-image-2.0' },
        fetch: () => respond({ data: [{ url: 'https://imgen.example.com/fixture.png' }] }),
        fromUrl: () => ({ base64: png, mediaType: 'image/png' }),
      })
      expect((await host.call('generate_image', { prompt: '示例' })).value).toMatchObject({
        ok: true,
        assetId: 'ast_1',
      })
      expect(host.calls[1]).toMatchObject({ target: 'https://imgen.example.com/fixture.png', input: { fromUrl: true } })
      expect(definition.permissions.host.network).toMatchObject({ mode: 'unrestricted', fields: ['endpoint'] })
    })

    it('explains a failed download of a generated picture', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'grok-imagine-image-2.0' },
        fetch: () => respond({ data: [{ url: 'https://imgen.example.com/fixture.png' }] }),
        fromUrl: () => {
          throw new Error('HTTP 404')
        },
      })
      const { text } = await host.call('generate_image', { prompt: '示例' })
      expect(text).toBe('图片已生成，但下载失败：HTTP 404。这次生成可能已经计费，重试前请先确认。')
      expect(host.assets).toEqual([])
    })
  })

  describe('图片数据的 data URL 前缀', () => {
    const webp = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1').toString('base64')
    it.each([
      ['plain PNG', png, png, 'image/png'],
      ['prefixed JPEG', `data:image/jpeg;base64,${jpeg}`, jpeg, 'image/jpeg'],
      ['prefixed jpg alias', `data:image/jpg;base64,${jpeg}`, jpeg, 'image/jpeg'],
      [
        'prefixed PNG with whitespace',
        ` data:image/png;base64,${png.slice(0, 20)}\n${png.slice(20)} `,
        png,
        'image/png',
      ],
      ['prefixed WebP', `DATA:image/webp;base64,${webp}`, webp, 'image/webp'],
      // 前缀里的类型优先于按文件头猜测。
      ['prefix wins over sniffing', `data:image/webp;base64,${png}`, png, 'image/webp'],
    ])('saves a %s b64_json as pure base64', async (_label, b64, expected, mediaType) => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { model: 'doubao-seedream-5-0-260128' },
        fetch: () => respond({ data: [{ b64_json: b64 }] }),
      })
      expect((await host.call('generate_image', { prompt: '示例' })).value).toMatchObject({ ok: true, mediaType })
      expect(host.assets[0]).toMatchObject({ base64: expected, mediaType })
    })

    it('strips the prefix from Gemini inlineData as well', async () => {
      const host = await createTestHost(factory, {
        secrets,
        fetch: () =>
          respond({
            candidates: [
              {
                content: { parts: [{ inlineData: { mimeType: 'image/png', data: `data:image/jpeg;base64,${jpeg}` } }] },
              },
            ],
          }),
      })
      await host.call('generate_image', { prompt: '示例' })
      expect(host.assets[0]).toMatchObject({ base64: jpeg, mediaType: 'image/jpeg' })
    })
  })

  describe('对话接口返回图片', () => {
    const chat =
      (content: unknown, extra: Record<string, unknown> = {}): FetchHandler =>
      () =>
        respond({ choices: [{ message: { role: 'assistant', content, ...extra } }] })

    it.each([
      ['Markdown data URL', chat(`好的：\n![图](data:image/png;base64,${png})`), png],
      ['bare data URL', chat(`data:image/jpeg;base64,${jpeg}`), jpeg],
      ['content parts', chat([{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }]), png],
      [
        'images field',
        chat('', { images: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg}` } }] }),
        jpeg,
      ],
    ])('saves the picture from a %s', async (_label, fetch, expected) => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { endpoint: 'https://llm.example.com/v1', model: 'fixture-chat-image', api: 'chat' },
        fetch,
      })
      const { value } = await host.call('generate_image', { prompt: '示例', aspect_ratio: '2:3' })
      expect(value).toMatchObject({ ok: true, model: 'fixture-chat-image' })
      expect(host.assets[0]).toMatchObject({ base64: expected })
      expect(host.calls[0]!.target).toBe('https://llm.example.com/v1/chat/completions')
      expect(bodyOf(host.calls[0]!.input)).toEqual({
        model: 'fixture-chat-image',
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'text', text: '示例\n\n画幅：竖版 2:3。只输出一张图片。' }] }],
      })
    })

    it('downloads a Markdown image link and reports a text-only reply', async () => {
      const linked = await createTestHost(factory, {
        secrets,
        hostConfig: { endpoint: 'https://llm.example.com/v1', model: 'fixture-chat-image', api: 'chat' },
        fetch: chat('![结果](https://llm.example.com/out/fixture.png)'),
        fromUrl: () => ({ base64: png, mediaType: 'image/png' }),
      })
      expect((await linked.call('generate_image', { prompt: '示例' })).value).toMatchObject({ ok: true })
      expect(linked.calls[1]!.target).toBe('https://llm.example.com/out/fixture.png')
      const refused = await createTestHost(factory, {
        secrets,
        hostConfig: { endpoint: 'https://llm.example.com/v1', model: 'fixture-chat-image', api: 'chat' },
        fetch: chat('抱歉，我只能回答文字问题。'),
      })
      expect((await refused.call('generate_image', { prompt: '示例' })).text).toContain('只回复了文字：抱歉')
    })
  })

  describe('其他 OpenAI 兼容或 Gemini 服务', () => {
    it('keeps base paths and infers the interface from the model name', async () => {
      const cases: [string, string][] = [
        ['fixture-gemini-image', 'https://images.example.com/proxy/v1beta/models/fixture-gemini-image:generateContent'],
        ['fixture-banana', 'https://images.example.com/proxy/v1beta/models/fixture-banana:generateContent'],
        ['gpt-image-9', 'https://images.example.com/proxy/v1/images/generations'],
        ['fixture-flux', 'https://images.example.com/proxy/v1/images/generations'],
      ]
      for (const [model, target] of cases) {
        const host = await createTestHost(factory, {
          secrets,
          hostConfig: { endpoint: 'https://images.example.com/proxy/v1///', model },
          fetch: (url, init) => (url.includes('generateContent') ? geminiOk(url, init) : imagesOk(url, init)),
        })
        expect((await host.call('generate_image', { prompt: '示例' })).value).toMatchObject({ ok: true, model })
        expect(host.calls[0]!.target).toBe(target)
      }
    })

    it('falls back to the OpenAI images interface with b64 for unknown models', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { endpoint: 'https://images.example.com/v1', model: 'fixture-image' },
        fetch: imagesOk,
      })
      await host.call('generate_image', { prompt: '示例' })
      expect(bodyOf(host.calls[0]!.input)).toEqual({
        model: 'fixture-image',
        prompt: '示例',
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      })
    })

    it('honours an explicit interface choice', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: { endpoint: 'https://images.example.com/v1', model: 'fixture-gemini-image', api: 'images' },
        fetch: imagesOk,
      })
      await host.call('generate_image', { prompt: '示例' })
      expect(host.calls[0]!.target).toBe('https://images.example.com/v1/images/generations')
      const gemini = await createTestHost(factory, {
        secrets,
        hostConfig: { endpoint: 'https://images.example.com', model: 'fixture-image', api: 'gemini' },
        fetch: geminiOk,
      })
      await gemini.call('generate_image', { prompt: '示例' })
      expect(gemini.calls[0]!.target).toBe('https://images.example.com/v1beta/models/fixture-image:generateContent')
    })

    it('falls back to the default model when it is blank', async () => {
      const host = await createTestHost(factory, { secrets, hostConfig: { model: ' ' }, fetch: geminiOk })
      await host.call('generate_image', { prompt: '示例' })
      expect(host.calls[0]!.target).toContain('gemini-nano-banana-2.1:generateContent')
    })

    it('asks for a model name when 其他模型 is chosen without one', async () => {
      const host = await createTestHost(factory, { secrets, hostConfig: { preset: 'custom' }, fetch: geminiOk })
      expect((await host.call('generate_image', { prompt: '示例' })).text).toContain('还没有填写模型名')
      expect(host.calls).toEqual([])
      expect(host.tools.get('generate_image')!.description).toContain('还没有选好模型')
    })
  })

  describe('参考图与改图', () => {
    const withPictures = async (model: string, fetch: FetchHandler) => {
      const host = await createTestHost(factory, { secrets, hostConfig: { model }, fetch })
      host.addPicture('ast_ref1', { channels: ['chn_TEST'], base64: png })
      host.addPicture('ast_ref2', { channels: ['chn_TEST'], base64: jpeg, info: { mediaType: 'image/jpeg' } })
      return host
    }

    it('sends reference pictures to Gemini as inlineData', async () => {
      const host = await withPictures('gemini-3.1-flash-image', geminiOk)
      const { value } = await host.call('generate_image', {
        prompt: '把背景换成海边',
        reference_images: ['ast_ref1', 'ast_ref2', 'ast_ref1'],
      })
      expect(value).toMatchObject({ ok: true })
      expect(bodyOf(host.calls[0]!.input)['contents']).toEqual([
        {
          role: 'user',
          parts: [
            { text: '把背景换成海边' },
            { inlineData: { mimeType: 'image/png', data: png } },
            { inlineData: { mimeType: 'image/jpeg', data: jpeg } },
          ],
        },
      ])
    })

    it('uploads reference pictures to the GPT Image edits endpoint as multipart', async () => {
      const host = await withPictures('gpt-image-2', imagesOk)
      await host.call('generate_image', { prompt: '加一顶帽子', reference_images: ['ast_ref1', 'ast_ref2'] })
      const call = host.calls[0]!
      expect(call.target).toBe(`${nekro}/images/edits`)
      const contentType = headersOf(call.input)['content-type']!
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/u)
      const boundary = contentType.split('boundary=')[1]!
      const raw = Buffer.from((call.input as NxtFetchInit).bodyBase64!, 'base64')
      const text = raw.toString('latin1')
      expect(text).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-2\r\n`)
      expect(raw.toString('utf8')).toContain('name="prompt"\r\n\r\n加一顶帽子\r\n')
      expect(text).toContain('name="image[]"; filename="reference-1.png"\r\nContent-Type: image/png')
      expect(text).toContain('name="image[]"; filename="reference-2.jpg"\r\nContent-Type: image/jpeg')
      expect(raw.includes(Buffer.from(png, 'base64'))).toBe(true)
      expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true)
      expect((call.input as NxtFetchInit).body).toBeUndefined()
    })

    it('uses a single image field for one reference picture', async () => {
      const host = await withPictures('gpt-image-2', imagesOk)
      await host.call('generate_image', { prompt: '加一顶帽子', reference_images: ['ast_ref1'] })
      const text = Buffer.from((host.calls[0]!.input as NxtFetchInit).bodyBase64!, 'base64').toString('latin1')
      expect(text).toContain('name="image"; filename="reference-1.png"')
    })

    it('passes Seedream references as data URLs and the chat interface as image parts', async () => {
      const seedream = await withPictures('doubao-seedream-5-0-260128', imagesOk)
      await seedream.call('generate_image', { prompt: '示例', reference_images: ['ast_ref2'] })
      expect(seedream.calls[0]!.target).toBe(`${nekro}/images/generations`)
      expect(bodyOf(seedream.calls[0]!.input)['image']).toBe(`data:image/jpeg;base64,${jpeg}`)
      await seedream.call('generate_image', { prompt: '示例', reference_images: ['ast_ref1', 'ast_ref2'] })
      expect(bodyOf(seedream.calls[1]!.input)['image']).toEqual([
        `data:image/png;base64,${png}`,
        `data:image/jpeg;base64,${jpeg}`,
      ])
      const chat = await createTestHost(factory, {
        secrets,
        hostConfig: { endpoint: 'https://llm.example.com/v1', model: 'fixture', api: 'chat' },
        fetch: () => respond({ choices: [{ message: { content: `![](data:image/png;base64,${png})` } }] }),
      })
      chat.addPicture('ast_ref1', { channels: ['chn_TEST'], base64: png })
      await chat.call('generate_image', { prompt: '示例', reference_images: ['ast_ref1'] })
      expect(bodyOf(chat.calls[0]!.input)['messages']).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: '示例\n\n画幅：方形 1:1。只输出一张图片。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
          ],
        },
      ])
    })

    it('sends Grok Imagine references to the edits endpoint', async () => {
      const host = await withPictures('grok-imagine-image-2.0', imagesOk)
      await host.call('generate_image', { prompt: '示例', reference_images: ['ast_ref1'] })
      expect(host.calls[0]!.target).toBe(`${nekro}/images/edits`)
      const text = Buffer.from((host.calls[0]!.input as NxtFetchInit).bodyBase64!, 'base64').toString('latin1')
      expect(text).toContain('name="response_format"\r\n\r\nb64_json\r\n')
      expect(text).toContain('name="image"; filename="reference-1.png"')
    })

    it('explains unreadable, non-image or oversized references without billing', async () => {
      const host = await withPictures('gemini-3.1-flash-image', geminiOk)
      host.addPicture('ast_doc', { channels: ['chn_TEST'], base64: png, info: { mediaType: 'application/pdf' } })
      host.addPicture('ast_other', { channels: ['chn_OTHER'], base64: png })
      expect((await host.call('generate_image', { prompt: '示例', reference_images: ['ast_other'] })).text).toContain(
        '读不到参考图 ast_other',
      )
      expect((await host.call('generate_image', { prompt: '示例', reference_images: ['ast_doc'] })).text).toContain(
        '不是图片',
      )
      vi.spyOn(host.nxt.assets, 'read').mockResolvedValueOnce({
        base64: png,
        eof: false,
        byteSize: 9 * 1024 * 1024,
        mediaType: 'image/png',
      })
      expect((await host.call('generate_image', { prompt: '示例', reference_images: ['ast_ref1'] })).text).toContain(
        '超过 8 MB',
      )
      expect(host.calls).toEqual([])
    })

    it('reads large references in chunks until eof', async () => {
      const host = await withPictures('gemini-3.1-flash-image', geminiOk)
      const bytes = Buffer.alloc(5 * 1024 * 1024, 7)
      bytes.set([0x89, 0x50, 0x4e, 0x47])
      host.addPicture('ast_big', { channels: ['chn_TEST'], base64: bytes.toString('base64') })
      const read = vi.spyOn(host.nxt.assets, 'read')
      await host.call('generate_image', { prompt: '示例', reference_images: ['ast_big'] })
      expect(read.mock.calls.map(([, range]) => range?.offset)).toEqual([0, 4 * 1024 * 1024])
      const contents = bodyOf(host.calls[0]!.input)['contents'] as { parts: { inlineData?: { data: string } }[] }[]
      expect(contents[0]!.parts[1]!.inlineData!.data).toBe(bytes.toString('base64'))
    })
  })

  describe('已安装用户的旧配置', () => {
    // 旧版安装时宿主按当时的默认值把每个字段都存了下来；最早的版本还没有「调用方式」。
    const oldHost = { endpoint: 'https://api.openai.com/v1', model: 'gpt-image-1' }
    const oldAgent = { size: '1024x1536', quality: 'medium' }
    const oldHosts = [
      oldHost,
      { endpoint: nekro, model: 'gemini-3.1-flash-image', api: 'auto' },
      { endpoint: 'https://images.example.com/v1', model: 'fixture-chat-image', api: 'chat' },
      { endpoint: nekro, model: 'gpt-image-2.6-sunburst', api: 'images' },
    ]

    it('stays valid under the new schema, so the host keeps it instead of resetting to defaults', () => {
      for (const previous of oldHosts) {
        const host = carry(hostSchema, previous)
        expect(host.issues).toEqual([])
        expect(host.value).toEqual({ api: 'auto', ...previous, preset: 'gemini-nano-banana-2.1' })
      }
      const agent = carry(agentSchema, oldAgent)
      expect(agent.issues).toEqual([])
      expect(agent.value).toEqual(oldAgent)
      for (const size of ['1024x1024', '1536x1024'])
        expect(carry(agentSchema, { size, quality: 'high' }).issues).toEqual([])
    })

    it('keeps calling the old service and model with the old size', async () => {
      const host = await createTestHost(factory, {
        secrets,
        hostConfig: carry(hostSchema, oldHost).value,
        config: carry(agentSchema, oldAgent).value,
        fetch: imagesOk,
      })
      const { value } = await host.call('generate_image', { prompt: '示例' })
      expect(host.calls[0]!.target).toBe('https://api.openai.com/v1/images/generations')
      expect(bodyOf(host.calls[0]!.input)).toEqual({
        model: 'gpt-image-1',
        prompt: '示例',
        n: 1,
        size: '1024x1536',
        quality: 'medium',
        response_format: 'b64_json',
      })
      expect(value).toMatchObject({ ok: true, aspectRatio: '2:3', model: 'gpt-image-1' })
    })

    it('keeps any saved model name, including the old default and the chat interface', async () => {
      const expected = [
        'https://api.openai.com/v1/images/generations',
        'https://api.nekro.ai/v1beta/models/gemini-3.1-flash-image:generateContent',
        'https://images.example.com/v1/chat/completions',
        'https://api.nekro.ai/v1/images/generations',
      ]
      for (const [index, previous] of oldHosts.entries()) {
        const host = await createTestHost(factory, {
          secrets,
          hostConfig: carry(hostSchema, previous).value,
          fetch: (url) =>
            url.includes('generateContent')
              ? geminiOk(url, {})
              : url.includes('chat')
                ? respond({ choices: [{ message: { content: `![](data:image/png;base64,${png})` } }] })
                : imagesOk(url, {}),
        })
        const { value } = await host.call('generate_image', { prompt: '示例' })
        expect(value).toMatchObject({ ok: true, model: previous.model })
        expect(host.calls[0]!.target).toBe(expected[index])
        expect(host.tools.get('generate_image')!.description).toContain(previous.model)
      }
    })

    it('switches once the user picks another model, and goes back to the default after clearing the old name', async () => {
      const upgraded = carry(hostSchema, { endpoint: nekro, model: 'gemini-3.1-flash-image', api: 'auto' }).value
      const picked = await createTestHost(factory, {
        secrets,
        hostConfig: { ...upgraded, preset: 'gpt-image-2.6-flare' },
        fetch: imagesOk,
      })
      expect((await picked.call('generate_image', { prompt: '示例' })).value).toMatchObject({
        model: 'gpt-image-2.6-flare',
      })
      const cleared = await createTestHost(factory, {
        secrets,
        hostConfig: { ...upgraded, model: '' },
        fetch: geminiOk,
      })
      expect((await cleared.call('generate_image', { prompt: '示例' })).value).toMatchObject({
        model: 'gemini-nano-banana-2.1',
      })
      const custom = await createTestHost(factory, {
        secrets,
        hostConfig: { ...upgraded, preset: 'custom', model: 'fixture-image' },
        fetch: imagesOk,
      })
      expect((await custom.call('generate_image', { prompt: '示例' })).value).toMatchObject({ model: 'fixture-image' })
    })

    it('gives new installs the NekroAPI preset, Nano Banana 2.1 and low quality', async () => {
      const fresh = carry(hostSchema, {}).value
      expect(fresh).toEqual({ endpoint: nekro, preset: 'gemini-nano-banana-2.1', api: 'auto' })
      expect(carry(agentSchema, {}).value).toEqual({ size: '1:1', quality: 'low' })
      const host = await createTestHost(factory, { secrets, hostConfig: fresh, fetch: geminiOk })
      await host.call('generate_image', { prompt: '示例' })
      expect(host.calls[0]!.target).toBe('https://api.nekro.ai/v1beta/models/gemini-nano-banana-2.1:generateContent')
    })
  })

  describe('配置页与工具说明', () => {
    const presetField = definition.config.host.schema.dict.preset
    const presetValues = presetField.list.map((option) => option.value)
    const builtins = presetValues.filter((value) => value !== 'custom')

    it('offers every built-in model in the model menu, plus 其他模型', () => {
      expect(presetValues.at(-1)).toBe('custom')
      expect(presetField.meta.default).toBe('gemini-nano-banana-2.1')
      for (const option of presetField.list.filter((entry) => entry.value !== 'custom'))
        expect(option.meta.description).toMatch(/^[^：]+：.+(秒|分半)$/u)
      // 服务地址、调用方式、其他模型名收在「高级」里。
      const dict = definition.config.host.schema.dict
      expect([dict.endpoint, dict.model, dict.api].map((field) => field.meta.advanced)).toEqual([true, true, true])
      expect(definition.config.agent.schema.dict.quality.list.map((option) => option.meta.description)).toEqual([
        '低（默认）：最快',
        '中',
        '高：更慢，可能更贵',
      ])
    })

    it('names the configured model and its style in the tool description', async () => {
      const descriptions = new Set<string>()
      for (const preset of builtins) {
        const host = await createTestHost(factory, { secrets, hostConfig: { preset } })
        const tool = host.tools.get('generate_image')!
        const label = presetField.list.find((option) => option.value === preset)!.meta.description
        // 下拉选项里的名字与工具说明里的一致。
        expect(tool.description).toContain(`当前模型是 ${label.split('：')[0]}（${preset}）`)
        expect(tool.description).toContain('海报、信息图')
        expect(tool.description).toContain('不要用 HTML 截图代替')
        expect(tool.description).toContain('只改 X，保留')
        descriptions.add(tool.description)
      }
      expect(descriptions.size).toBe(builtins.length)
      const custom = await createTestHost(factory, {
        secrets,
        hostConfig: { preset: 'custom', model: 'fixture-image' },
      })
      expect(custom.tools.get('generate_image')!.description).toContain(
        '当前模型是 fixture-image，不在内置列表里，擅长什么以服务商的说明为准。',
      )
    })

    it('keeps the tool description short enough to sit in every turn', async () => {
      const host = await createTestHost(factory, { secrets })
      expect(host.tools.get('generate_image')!.description.length).toBeLessThan(600)
    })

    it('says in the ratio parameter when a model only has three sizes', async () => {
      const ratio = async (preset: string) => {
        const host = await createTestHost(factory, { secrets, hostConfig: { preset } })
        const parameters = host.tools.get('generate_image')!.parameters as Record<string, { description?: string }>
        return parameters['aspect_ratio']!.description
      }
      expect(await ratio('gpt-image-2.6-sunburst')).toContain('只出 1:1、2:3、3:2')
      expect(await ratio('gemini-nano-banana-2.1')).not.toContain('只出')
      expect(await ratio('doubao-seedream-5-0-260128')).not.toContain('只出')
    })
  })

  it.each([
    {},
    { prompt: '' },
    { prompt: ' ' },
    { prompt: 42 },
    { prompt: '示例', aspect_ratio: '1024x1024' },
    { prompt: '示例', aspect_ratio: null },
    { prompt: '示例', reference_images: 'ast_ref1' },
    { prompt: '示例', reference_images: [''] },
    { prompt: '示例', reference_images: ['a', 'b', 'c', 'd', 'e'] },
  ])('rejects invalid inputs %j without fetching', async (args) => {
    const host = await createTestHost(factory, { secrets })
    expect((await host.call('generate_image', args)).value).toMatchObject({ ok: false })
    expect(host.calls).toEqual([])
  })

  it.each([
    'bad url',
    'ftp://example.com/v1',
    'https://user:password@example.com/',
    'https://example.com/v1?token=fixture',
    'https://example.com/v1#fragment',
  ])('rejects invalid service address %s', async (endpoint) => {
    const host = await createTestHost(factory, { secrets, hostConfig: { endpoint } })
    expect((await host.call('generate_image', { prompt: '示例' })).text).toContain('服务地址无效')
    expect(host.calls).toEqual([])
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
    const { text } = await host.call('generate_image', { prompt: '示例' })
    expect(text).toContain(String(message))
    expect(text).not.toContain('敏感服务错误')
    expect(host.calls).toHaveLength(1)
    expect(host.assets).toEqual([])
  })

  it('quotes the provider error message briefly', async () => {
    const host = await createTestHost(factory, {
      secrets,
      fetch: () => respond({ error: { message: `invalid size ${'x'.repeat(300)}` } }, { status: 400 }),
    })
    const { text } = await host.call('generate_image', { prompt: '示例' })
    expect(text).toContain('HTTP 400：invalid size')
    expect(text.length).toBeLessThan(260)
  })

  it.each([
    ['not JSON', '有效的 JSON'],
    [{}, '没有返回图片数据'],
    [{ candidates: [] }, '没有返回图片数据'],
    [{ data: [null] }, '没有返回图片数据'],
  ])('explains malformed response %j', async (body, message) => {
    const host = await createTestHost(factory, { secrets, fetch: () => respond(body) })
    expect((await host.call('generate_image', { prompt: '示例' })).text).toContain(String(message))
    expect(host.assets).toEqual([])
    expect(host.calls).toHaveLength(1)
  })

  it('reports the media type recognized by the host', async () => {
    const host = await createTestHost(factory, { secrets, fetch: geminiOk })
    vi.spyOn(host.nxt.assets, 'create').mockResolvedValueOnce({
      assetId: 'ast_9',
      byteSize: 68,
      mediaType: 'image/webp',
    })
    const { value, text } = await host.call('generate_image', { prompt: '示例' })
    expect(value).toMatchObject({ ok: true, assetId: 'ast_9', mediaType: 'image/webp' })
  })

  it('explains failures with the cause and warns about billing only on timeouts', async () => {
    const network = await createTestHost(factory, {
      secrets,
      fetch: () => {
        throw new Error('连接被拒绝')
      },
    })
    expect((await network.call('generate_image', { prompt: '示例' })).value).toEqual({
      ok: false,
      message: '生成图片失败：连接被拒绝。如果还没有填写 API Key，请在扩展配置中填写。',
    })
    for (const reason of ['外部服务 180 秒无响应', 'Request Timeout']) {
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
      message: `生成图片失败：${'错'.repeat(200)}。如果还没有填写 API Key，请在扩展配置中填写。`,
    })
    const host = await createTestHost(factory, { secrets, fetch: geminiOk })
    vi.spyOn(host.nxt.assets, 'create').mockRejectedValueOnce(new Error('保存失败'))
    expect((await host.call('generate_image', { prompt: '示例' })).value).toEqual({
      ok: false,
      message: '生成图片失败：保存失败',
    })
  })
})
