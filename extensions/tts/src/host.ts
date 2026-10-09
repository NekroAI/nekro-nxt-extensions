import { defineHostExtension } from '@nekro-nxt/extension-sdk'

/**
 * 语音合成：把服务返回的 MP3 二进制交给宿主保存，结果不包含原文或凭据。
 *
 * 服务地址、API Key 与模型是本机配置（`config.host`），请求经本机层 `nxt` 发出；默认音色是每个智能体
 * 自己的配置（`config.agent`）。
 */
type SpeakArgs = { readonly text?: string; readonly voice?: string }
type ServiceConfig = { readonly endpoint?: string; readonly model?: string }
type AgentConfig = { readonly voice?: string }
type SpeakResult =
  | { readonly ok: true; readonly assetId: string; readonly mediaType: string }
  | { readonly ok: false; readonly message: string }

export default defineHostExtension(async ({ harness, nxt: host }) => ({
  inject: ['tools', 'nxt'],
  apply(ctx) {
    const nxt = ctx.nxt
    if (!nxt) throw new Error('语音合成需要宿主能力 nxt。')
    harness.registerTool(
      ctx,
      harness.defineTool<SpeakArgs, SpeakResult>({
        name: 'speak',
        description:
          '将非空文本合成为 MP3，text 最多 1000 字，voice 默认取配置（alloy）。返回 assetId，由智能体用 send_channel_message 的 audio 块发送；按服务商计费，使用用户自己的 API Key。',
        parameters: {
          text: {
            type: 'string',
            required: true,
            description: '要朗读的非空文本，最多 1000 字（按 Unicode 码点计数）',
          },
          voice: { type: 'string', description: '服务商支持的音色名称，默认取配置值 alloy' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.ok
                ? `语音已生成，assetId：${value.assetId}。请用 send_channel_message 的 audio 块携带此 assetId 以音频发送。`
                : value.message,
            },
          ],
        },
        execute: async ({ text, voice }) => {
          const input = typeof text === 'string' ? text.trim() : ''
          if (!input) return { ok: false, message: '请提供非空的朗读文本 text。' }
          if (Array.from(input).length > 1000) return { ok: false, message: '朗读文本最多 1000 字，请缩短后再试。' }
          if (voice !== undefined && (typeof voice !== 'string' || !voice.trim()))
            return { ok: false, message: 'voice 需要是非空的音色名称。' }
          const service = harness.config() as ServiceConfig
          const preference = ctx.config() as AgentConfig
          let endpoint: URL
          try {
            endpoint = new URL(service.endpoint ?? 'https://api.openai.com/v1')
            if (
              !['http:', 'https:'].includes(endpoint.protocol) ||
              endpoint.username ||
              endpoint.password ||
              endpoint.search ||
              endpoint.hash
            )
              throw new Error('invalid endpoint')
          } catch {
            return {
              ok: false,
              message: '语音服务地址无效，请填写 http/https API 基础地址，不要包含账号、密码、查询参数或片段。',
            }
          }
          const model = service.model?.trim() || 'tts-1'
          const wantedVoice = voice?.trim() || preference.voice?.trim() || 'alloy'
          try {
            const apiKey = await host.secrets.get('apiKey')
            if (!apiKey?.trim())
              return { ok: false, message: '还没有配置语音服务的 API Key，请在扩展配置中填写后再合成。' }
            endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/audio/speech`
            const response = await host.http.fetch(endpoint.toString(), {
              method: 'POST',
              headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'audio/mpeg' },
              body: JSON.stringify({ model, input, voice: wantedVoice, response_format: 'mp3' }),
            })
            if (response.status === 401 || response.status === 403)
              return { ok: false, message: '语音服务拒绝了请求，请检查 API Key 和模型访问权限。' }
            if (response.status === 429)
              return { ok: false, message: '语音服务额度不足或请求过于频繁，请检查余额或稍后再试。' }
            if (response.status < 200 || response.status >= 300)
              return { ok: false, message: `语音服务返回 HTTP ${response.status}，请检查模型与音色是否受支持。` }
            const mediaType = response.contentType.split(';')[0]?.trim().toLowerCase()
            if (!['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(mediaType ?? ''))
              return { ok: false, message: '语音服务没有返回 MP3 音频，请确认支持 response_format: mp3 的二进制响应。' }
            const base64 = response.base64
            if (!base64) return { ok: false, message: '语音服务返回的音频为空。' }
            const asset = await nxt.assets.create({ base64, mediaType: 'audio/mpeg', name: 'speech.mp3' })
            return { ok: true, assetId: asset.assetId, mediaType: asset.mediaType }
          } catch (error) {
            const reason = String(error instanceof Error ? error.message : error)
            // 宿主请求超时只说明没有等到响应，服务端可能仍在合成并计费。
            const timedOut = /无响应|timeout/iu.test(reason)
            return {
              ok: false,
              message: `语音合成失败：${reason.slice(0, 200)}${timedOut ? '。服务端可能仍在生成并已计费，重试前请先确认。' : ''}`,
            }
          }
        },
      }),
    )
  },
}))
