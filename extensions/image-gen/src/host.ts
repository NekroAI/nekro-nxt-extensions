import { defineHostExtension } from '@nekro-nxt/extension-sdk'

/** 图片生成：凭据只从宿主读取，生成文件只返回 Asset，不直接在频道发言。 */
const SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const
type Size = (typeof SIZES)[number]
type Quality = 'low' | 'medium' | 'high'
type GenerateArgs = { readonly prompt?: string; readonly size?: Size }
type GenerateConfig = {
  readonly endpoint?: string
  readonly model?: string
  readonly size?: Size
  readonly quality?: Quality
}
type GenerateResult =
  | { readonly ok: true; readonly assetId: string; readonly mediaType: string; readonly size: Size }
  | { readonly ok: false; readonly message: string }

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const isSize = (value: unknown): value is Size => SIZES.some((size) => size === value)

export default defineHostExtension(async ({ harness }) => ({
  inject: ['tools', 'nxt'],
  apply(ctx) {
    const nxt = ctx.nxt
    if (!nxt) throw new Error('图片生成需要宿主能力 nxt。')
    harness.registerTool(
      ctx,
      harness.defineTool<GenerateArgs, GenerateResult>({
        name: 'generate_image',
        description:
          '按 prompt 生成一张 PNG 图片，返回 assetId，由智能体用 send_channel_message 的 image 块发送。size 可选 1024x1024、1024x1536、1536x1024，默认取配置；按服务商计费，使用用户自己的 API Key。',
        parameters: {
          prompt: { type: 'string', required: true, description: '非空的图片描述，包含主体、风格和构图' },
          size: { type: 'string', enum: [...SIZES], description: '图片尺寸，默认取配置值 1024x1024' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.ok
                ? `图片已生成（${value.size}，${value.mediaType}），assetId：${value.assetId}。请用 send_channel_message 的 image 块携带此 assetId 发送图片。`
                : value.message,
            },
          ],
        },
        execute: async ({ prompt, size }) => {
          const description = typeof prompt === 'string' ? prompt.trim() : ''
          // 空输入验证即使在未来提供凭据也不会触发付费请求。
          if (!description) return { ok: false, message: '请提供非空的图片描述 prompt。' }
          if (size !== undefined && !isSize(size))
            return { ok: false, message: 'size 只能是 1024x1024、1024x1536 或 1536x1024。' }
          const config = (harness.config?.() ?? {}) as GenerateConfig
          let endpoint: URL
          try {
            endpoint = new URL(config.endpoint ?? 'https://api.openai.com/v1')
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
              message: '图片服务地址无效，请填写 http/https API 基础地址，不要包含账号、密码、查询参数或片段。',
            }
          }
          const model = config.model?.trim() || 'gpt-image-1'
          const wanted = size ?? config.size ?? '1024x1024'
          const quality = config.quality ?? 'medium'
          try {
            const apiKey = await nxt.secrets.get('apiKey')
            if (!apiKey?.trim())
              return { ok: false, message: '还没有配置图片服务的 API Key，请在扩展配置中填写后再生成。' }
            endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/images/generations`
            const response = await nxt.http.fetch(endpoint.toString(), {
              method: 'POST',
              headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
              // GPT Image 默认返回 b64_json，不接受旧式 response_format 参数。
              body: JSON.stringify({
                model,
                prompt: description,
                size: wanted,
                quality,
                n: 1,
                output_format: 'png',
              }),
            })
            if (response.status === 401 || response.status === 403)
              return { ok: false, message: '图片服务拒绝了请求，请检查 API Key 和模型访问权限。' }
            if (response.status === 429)
              return { ok: false, message: '图片服务额度不足或请求过于频繁，请检查余额或稍后再试。' }
            if (response.status < 200 || response.status >= 300)
              return { ok: false, message: `图片服务返回 HTTP ${response.status}，请检查模型与尺寸是否受支持。` }
            let body: Record<string, unknown>
            try {
              body = record(JSON.parse(response.text ?? ''))
            } catch {
              return { ok: false, message: '图片服务没有返回有效的 JSON 结果。' }
            }
            const image = record(Array.isArray(body['data']) ? body['data'][0] : undefined)
            const base64 = image['b64_json']
            if (typeof base64 !== 'string' || !base64) {
              return {
                ok: false,
                message:
                  typeof image['url'] === 'string' && image['url']
                    ? '图片服务只返回了 URL；本扩展需要 b64_json 格式的 PNG，不支持跨域下载，请使用兼容的服务或模型。'
                    : '图片服务没有返回图片数据，请确认支持 data[0].b64_json 格式。',
              }
            }
            const asset = await nxt.assets.create({ base64, mediaType: 'image/png', name: 'generated-image.png' })
            return { ok: true, assetId: asset.assetId, mediaType: asset.mediaType, size: wanted }
          } catch (error) {
            const reason = String(error instanceof Error ? error.message : error)
            // 宿主请求超时只说明没有等到响应，服务端可能仍在生成并计费。
            const timedOut = /无响应|timeout/iu.test(reason)
            return {
              ok: false,
              message: `生成图片失败：${reason.slice(0, 200)}${timedOut ? '。服务端可能仍在生成并已计费，重试前请先确认；可改用较低的质量或较小的尺寸。' : ''}`,
            }
          }
        },
      }),
    )
  },
}))
