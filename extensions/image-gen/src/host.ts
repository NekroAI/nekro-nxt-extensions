import { defineHostExtension } from '@nekro-nxt/extension-sdk'
import type { NxtFetchResponse, NxtHostService } from '@nekro-nxt/extension-sdk'

/**
 * 图片生成：API Key 用 `secrets.placeholder` 放进请求头，由宿主在发出时填入，代码不接触原文，「只用于网络请求」的
 * 凭据也能用；生成文件只返回 Asset，不直接在频道发言。
 *
 * 服务地址、API Key 与模型是本机配置（`config.host`），所有智能体共用一份，请求经本机层 `nxt` 发出；
 * 画幅与质量是每个智能体自己的偏好（`config.agent`），生成的图片保存为该智能体当前频道的 Asset，
 * 参考图通过智能体层 `ctx.nxt.assets.read` 读取。
 *
 * 不同模型的出图接口不同，按内置模型表选择调用方式；表里没有的模型按名字推断，推断不出时走 OpenAI 生图接口。
 * 配置要向后兼容：宿主升级时旧配置仍符合新 schema 才会原样保留，否则整体重置为默认值（服务地址会变），
 * 所以字段只加不删、旧取值保持有效，tests 里有旧配置升级的用例。
 */

/** 三种调用方式：OpenAI 生图接口、对话接口返回图片、Gemini generateContent。 */
type Api = 'images' | 'chat' | 'gemini'
/** 生图接口上的参考图传法：multipart 改图接口，或生成接口 JSON 里的 image 字段。 */
type EditMode = 'multipart' | 'json-image'
/** 生图接口的 size 写法：GPT Image 三种尺寸、Seedream 2K 尺寸，或不传（画幅写进描述）。 */
type SizeStyle = 'gpt' | 'seedream' | 'none'

interface ModelProfile {
  readonly api: Api
  readonly sizes?: SizeStyle
  /** 生图接口：是否发送 quality。 */
  readonly quality?: boolean
  readonly edit?: EditMode
  /** Gemini：高质量时是否发送 imageConfig.imageSize: '2K'；默认不传，由模型按 1K 出图。 */
  readonly imageSize?: boolean
}

const GPT_IMAGE: ModelProfile = { api: 'images', sizes: 'gpt', quality: true, edit: 'multipart' }
const GEMINI: ModelProfile = { api: 'gemini' }
const SEEDREAM: ModelProfile = { api: 'images', sizes: 'seedream', edit: 'json-image' }
const GROK: ModelProfile = { api: 'images', sizes: 'none', edit: 'multipart' }
/** 其他 OpenAI 兼容生图模型的兜底参数。 */
const GENERIC_IMAGES: ModelProfile = { api: 'images', sizes: 'gpt', edit: 'multipart' }

/**
 * 内置模型表：NekroAPI 当前的画图模型，2026-11-14 实测过（R-343）。所有模型都直接返回 b64，没有返回网址的。
 * - GPT Image：/v1/images/generations，b64 PNG；gpt-image-2 低质量也要八十多秒，2.6 两款约 20 秒；
 *   n=1 时偶尔返回两张，只取第一张；参考图走 /v1/images/edits（multipart）。
 * - Gemini 图片模型：/v1beta/models/{model}:generateContent，图片在 inlineData，9～21 秒；对话接口也能出图，
 *   但控制不了比例，所以用 generateContent。参考图放进 inlineData。
 * - Seedream：/v1/images/generations，b64 JPEG，约 13 秒；尺寸按它的 2K 规则（传 1024x1024 也会给 2048x2048）；
 *   参考图放在同一请求的 image 字段（data URL）。
 * - Grok Imagine：/v1/images/generations，b64 PNG，约 10 秒；参考图走 /v1/images/edits。
 * 实测只用了 1:1，其他比例、多张参考图和 Gemini 的 2K（imageSize）按公开协议实现。
 */
const MODELS: Readonly<Record<string, ModelProfile>> = {
  'gpt-image-2': GPT_IMAGE,
  'gpt-image-2.6-flare': GPT_IMAGE,
  'gpt-image-2.6-sunburst': GPT_IMAGE,
  'gemini-3-pro-image': { api: 'gemini', imageSize: true },
  'gemini-3.1-flash-image': { api: 'gemini', imageSize: true },
  'gemini-nano-banana-2.1': GEMINI,
  'doubao-seedream-5-0-260128': SEEDREAM,
  'grok-imagine-image-2.0': GROK,
}

/** 表里没有的模型按名字推断调用方式；都不像时走 OpenAI 生图接口。 */
const inferProfile = (model: string): ModelProfile => {
  const known = MODELS[model]
  if (known) return known
  const name = model.toLowerCase()
  if (/gemini|banana/u.test(name)) return GEMINI
  if (/gpt-image/u.test(name)) return GPT_IMAGE
  if (/seedream|seededit/u.test(name)) return SEEDREAM
  if (/grok/u.test(name)) return GROK
  return GENERIC_IMAGES
}

const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'] as const
type Ratio = (typeof RATIOS)[number]
/** 旧版的像素尺寸配置仍然有效，分别等同于一个比例。 */
const LEGACY_SIZES: Readonly<Record<string, Ratio>> = { '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2' }
type Quality = 'low' | 'medium' | 'high'

/** GPT Image 只接受三种尺寸，按画幅取最接近的一种。 */
const GPT_SIZES: Readonly<Record<Ratio, string>> = {
  '1:1': '1024x1024',
  '2:3': '1024x1536',
  '3:4': '1024x1536',
  '9:16': '1024x1536',
  '3:2': '1536x1024',
  '4:3': '1536x1024',
  '16:9': '1536x1024',
}
/** Seedream 推荐的 2K 尺寸。 */
const SEEDREAM_SIZES: Readonly<Record<Ratio, string>> = {
  '1:1': '2048x2048',
  '2:3': '1664x2496',
  '3:2': '2496x1664',
  '3:4': '1728x2304',
  '4:3': '2304x1728',
  '9:16': '1600x2848',
  '16:9': '2848x1600',
}
const RATIO_WORDS: Readonly<Record<Ratio, string>> = {
  '1:1': '方形 1:1',
  '2:3': '竖版 2:3',
  '3:2': '横版 3:2',
  '3:4': '竖版 3:4',
  '4:3': '横版 4:3',
  '9:16': '竖版 9:16',
  '16:9': '横版 16:9',
}

const MAX_REFERENCES = 4
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
/**
 * 宿主单次请求默认 100 秒收不到数据就超时，出图慢的模型放宽到 180 秒。默认参数（低质量、1K）下实测最慢的 gpt-image-2 约 84 秒；
 * 不支持 timeoutMs 的旧宿主会忽略它。
 */
const REQUEST_TIMEOUT_MS = 180_000
const DEFAULT_ENDPOINT = 'https://api.nekro.ai/v1'
const DEFAULT_MODEL = 'gemini-3.1-flash-image'

type GenerateArgs = {
  readonly prompt?: string
  readonly aspect_ratio?: Ratio
  readonly reference_images?: readonly string[]
}
type ServiceConfig = { readonly endpoint?: string; readonly model?: string; readonly api?: 'auto' | Api }
type AgentConfig = { readonly size?: string; readonly quality?: Quality }
type GenerateResult =
  | {
      readonly ok: true
      readonly assetId: string
      readonly mediaType: string
      readonly model: string
      readonly aspectRatio: Ratio
      /** 实际画幅与要求不同时的说明。 */
      readonly note?: string
    }
  | { readonly ok: false; readonly message: string }

/** 一张待保存的图片：base64 内容，或需要下载的网址。 */
type Picture = { readonly base64: string; readonly mediaType?: string } | { readonly url: string }
type Reference = { readonly base64: string; readonly mediaType: string }

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : undefined)

const isRatio = (value: unknown): value is Ratio => RATIOS.some((ratio) => ratio === value)

/** 配置里的画幅：新的比例，或旧版像素尺寸。 */
const configuredRatio = (value: unknown): Ratio =>
  isRatio(value) ? value : typeof value === 'string' && LEGACY_SIZES[value] ? LEGACY_SIZES[value] : '1:1'

/** 已经写成给用户看的说明的错误。 */
class ServiceError extends Error {
  constructor(
    message: string,
    /** 服务返回的错误说明，用来判断是不是某个参数不受支持。 */
    readonly detail = '',
  ) {
    super(message)
  }
}

/** 宿主请求超时只说明没有等到响应，服务端可能仍在生成并计费。 */
const TIMEOUT_REASON = /无响应|超时|timeout/iu
const TIMEOUT_ADVICE = '服务端可能仍在生成并已计费，重试前请先确认；可以改用较低的质量、更快的模型，或不带参考图。'

/**
 * 请求没有拿到响应时给用户的说明。宿主在发出前检查凭据：API Key 没有填写和所选凭据不对这个智能体开放报的是同一个原因，
 * 凭据不允许发往服务地址时说明被拒的主机；网络问题与超时也走这里。扩展分不出前两种，所以转述宿主的原因，再提示没填时去哪里填。
 */
const requestFailed = (error: unknown): ServiceError => {
  const reason = String(error instanceof Error ? error.message : error)
    .replace(/[。.\s]+$/u, '')
    .slice(0, 200)
  return new ServiceError(
    TIMEOUT_REASON.test(reason)
      ? `生成图片失败：${reason}。${TIMEOUT_ADVICE}`
      : `生成图片失败：${reason}。如果还没有填写 API Key，请在扩展配置中填写。`,
  )
}

const DATA_URL = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/iu
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?(data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)>]+)>?\s*\)/u
const BARE_IMAGE =
  /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)"'<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)"'<>]*)?/iu

/** 把图片网址或 data URL 变成待保存的图片。 */
const pictureFromUrl = (url: string): Picture => {
  const data = DATA_URL.exec(url.trim())
  return data ? { base64: data[2]!.replaceAll(/\s+/gu, ''), mediaType: data[1]! } : { url: url.trim() }
}

/** 一段内容里的图片：多模态片段、inline_data，或文字中的 Markdown 图片 / data URL / 图片链接。 */
const pictureInContent = (content: unknown): Picture | undefined => {
  if (typeof content === 'string') {
    const found = MARKDOWN_IMAGE.exec(content)?.[1] ?? BARE_IMAGE.exec(content)?.[0]
    return found ? pictureFromUrl(found) : undefined
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      const found = pictureInContent(part)
      if (found) return found
    }
    return undefined
  }
  const part = record(content)
  const imageUrl = part['image_url']
  if (typeof imageUrl === 'string') return pictureFromUrl(imageUrl)
  const nestedUrl = record(imageUrl)['url']
  if (typeof nestedUrl === 'string') return pictureFromUrl(nestedUrl)
  const inline = record(part['inline_data'] ?? part['inlineData'])
  if (typeof inline['data'] === 'string' && inline['data']) {
    const mediaType = inline['mime_type'] ?? inline['mimeType']
    return { base64: inline['data'], ...(typeof mediaType === 'string' ? { mediaType } : {}) }
  }
  if (typeof part['b64_json'] === 'string' && part['b64_json']) return { base64: part['b64_json'] }
  if (typeof part['text'] === 'string') return pictureInContent(part['text'])
  return undefined
}

/** OpenAI 生图接口：data[0].b64_json，其次 data[0].url。 */
const parseImagesResponse = (body: Record<string, unknown>): Picture | undefined => {
  const image = record(first(body['data']))
  if (typeof image['b64_json'] === 'string' && image['b64_json']) return { base64: image['b64_json'] }
  if (typeof image['url'] === 'string' && image['url']) return pictureFromUrl(image['url'])
  return undefined
}

const chatMessage = (body: Record<string, unknown>) => record(record(first(body['choices']))['message'])

/** 对话接口：message.images（OpenRouter 等中转的写法），其次 message.content。 */
const parseChatResponse = (body: Record<string, unknown>): Picture | undefined => {
  const message = chatMessage(body)
  return pictureInContent(message['images']) ?? pictureInContent(message['content'])
}

/** 对话接口没有出图时的文字回复，用来说明原因。 */
const chatText = (body: Record<string, unknown>): string => {
  const content = chatMessage(body)['content']
  return typeof content === 'string' ? content.trim() : ''
}

const geminiParts = (body: Record<string, unknown>): unknown[] => {
  const parts = record(record(first(body['candidates']))['content'])['parts']
  return Array.isArray(parts) ? parts : []
}

/** Gemini：candidates[0].content.parts[] 中第一张不是思考草稿的 inlineData。 */
const parseGeminiResponse = (body: Record<string, unknown>): Picture | undefined =>
  pictureInContent(
    geminiParts(body)
      .filter((part) => record(part)['thought'] !== true)
      .map((part) => {
        // Gemini 的文字片段不当作图片来源，避免把说明里的链接误当成图片。
        const { text: _text, ...rest } = record(part)
        return rest
      }),
  )

const geminiText = (body: Record<string, unknown>): string => {
  const text = geminiParts(body)
    .map((part) => record(part)['text'])
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .trim()
  const reason = record(first(body['candidates']))['finishReason'] ?? record(body['promptFeedback'])['blockReason']
  return `${text}${typeof reason === 'string' && reason !== 'STOP' ? `（${reason}）` : ''}`.trim()
}

/** 按文件头识别图片格式；识别不出时沿用服务给出的类型。 */
const sniffMediaType = (base64: string, declared?: string): string => {
  let head = ''
  try {
    head = atob(base64.slice(0, 24))
  } catch {
    // 交给宿主保存时报错。
  }
  if (head.startsWith('\u0089PNG')) return 'image/png'
  if (head.startsWith('ÿØÿ')) return 'image/jpeg'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp'
  if (head.startsWith('GIF8')) return 'image/gif'
  return declared?.startsWith('image/') ? declared : 'image/png'
}

/**
 * 各种调用方式拿到的 base64 都经过这里再保存：有的服务（如 Seedream）在 b64_json 里也带 data URL 前缀，
 * 宿主只收纯 base64。前缀里的类型优先，其次按文件头识别，最后用服务声明的类型。
 */
const imageData = (raw: string, declared?: string): { readonly base64: string; readonly mediaType: string } => {
  const data = DATA_URL.exec(raw.trim())
  const base64 = (data ? data[2]! : raw).replaceAll(/\s+/gu, '')
  const prefixed = data?.[1]!.toLowerCase().replace(/^image\/jpg$/u, 'image/jpeg')
  return { base64, mediaType: prefixed ?? sniffMediaType(base64, declared) }
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
const base64ToBytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

const concat = (pieces: readonly Uint8Array[]): Uint8Array => {
  const all = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0))
  let at = 0
  for (const piece of pieces) {
    all.set(piece, at)
    at += piece.length
  }
  return all
}

/** 读一张参考图的全部字节：宿主每次最多给 4 MiB，按 offset 续读到 eof。 */
const readReference = async (nxt: NxtHostService, assetId: string, signal: AbortSignal): Promise<Reference> => {
  const chunks: Uint8Array[] = []
  let offset = 0
  let mediaType = ''
  for (;;) {
    const chunk = await nxt.assets.read(assetId, { offset, signal })
    mediaType = chunk.mediaType
    if (!mediaType.startsWith('image/')) throw new ServiceError(`参考图 ${assetId} 不是图片（${mediaType}）。`)
    if (chunk.byteSize > MAX_REFERENCE_BYTES) throw new ServiceError(`参考图 ${assetId} 超过 8 MB，请换一张较小的图。`)
    const bytes = base64ToBytes(chunk.base64)
    chunks.push(bytes)
    offset += bytes.length
    if (chunk.eof || bytes.length === 0) break
  }
  return { base64: bytesToBase64(concat(chunks)), mediaType }
}

/** multipart/form-data 请求体，供 /images/edits 上传参考图。 */
const multipart = (
  fields: Readonly<Record<string, string>>,
  files: readonly { readonly name: string; readonly reference: Reference; readonly filename: string }[],
): { readonly bodyBase64: string; readonly contentType: string } => {
  const boundary = `nxt-image-gen-${Math.random().toString(36).slice(2)}`
  const encoder = new TextEncoder()
  const pieces: Uint8Array[] = []
  for (const [name, value] of Object.entries(fields))
    pieces.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  for (const file of files) {
    pieces.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.reference.mediaType}\r\n\r\n`,
      ),
      base64ToBytes(file.reference.base64),
      encoder.encode('\r\n'),
    )
  }
  pieces.push(encoder.encode(`--${boundary}--\r\n`))
  return { bodyBase64: bytesToBase64(concat(pieces)), contentType: `multipart/form-data; boundary=${boundary}` }
}

const joinPath = (endpoint: URL, path: string): string => {
  const url = new URL(endpoint.toString())
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`
  return url.toString()
}

/** 把服务基础地址末尾的 /v1 换成 /v1beta，得到 Gemini 接口地址；主机不变，网络权限仍然覆盖。 */
const geminiUrl = (endpoint: URL, model: string): string => {
  const url = new URL(endpoint.toString())
  const base = url.pathname.replace(/\/+$/u, '')
  const root = /\/v1$/u.test(base) ? base.replace(/\/v1$/u, '/v1beta') : `${base}/v1beta`
  url.pathname = `${root}/models/${encodeURIComponent(model)}:generateContent`
  return url.toString()
}

const dataUrl = (reference: Reference) => `data:${reference.mediaType};base64,${reference.base64}`

export default defineHostExtension(async ({ harness, nxt: host }) => ({
  inject: ['tools', 'nxt'],
  apply(ctx) {
    const nxt = ctx.nxt
    if (!nxt) throw new Error('图片生成需要宿主能力 nxt。')

    /** 发出一次请求并解析 JSON；状态码错误转成给用户看的说明。 */
    const post = async (
      url: string,
      headers: Readonly<Record<string, string>>,
      payload: { readonly body: string } | { readonly bodyBase64: string },
    ): Promise<Record<string, unknown>> => {
      let response: NxtFetchResponse
      try {
        response = await host.http.fetch(url, {
          method: 'POST',
          headers,
          ...payload,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
      } catch (error) {
        throw requestFailed(error)
      }
      if (response.status === 401 || response.status === 403)
        throw new ServiceError('图片服务拒绝了请求，请检查 API Key 和模型访问权限。')
      if (response.status === 429) throw new ServiceError('图片服务额度不足或请求过于频繁，请检查余额或稍后再试。')
      if (response.status < 200 || response.status >= 300) {
        // 只摘取服务给出的错误说明，不原样回显整个响应。
        let detail = ''
        try {
          const error = record(JSON.parse(response.text ?? ''))['error']
          const message = typeof error === 'string' ? error : record(error)['message']
          if (typeof message === 'string' && message.trim()) detail = `：${message.trim().slice(0, 160)}`
        } catch {
          // 非 JSON 的错误页不展示。
        }
        throw new ServiceError(
          `图片服务返回 HTTP ${response.status}${detail}。请检查模型名、画幅和参考图是否受支持。`,
          response.status === 400 || response.status === 422 ? detail : '',
        )
      }
      try {
        return record(JSON.parse(response.text ?? ''))
      } catch {
        throw new ServiceError('图片服务没有返回有效的 JSON 结果。')
      }
    }

    harness.registerTool(
      ctx,
      harness.defineTool<GenerateArgs, GenerateResult>({
        name: 'generate_image',
        description:
          '按 prompt 生成一张图片，返回 assetId，由智能体用 send_channel_message 的 image 块发送。aspect_ratio 可选 1:1、2:3、3:2、3:4、4:3、9:16、16:9，默认取配置。reference_images 可传 1–4 个当前对话里图片的 assetId，用来改图或参照人物、风格；不传就是按文字生成。每次调用按服务商价格计费，使用用户自己的 API Key，通常需要十几秒到一分钟。',
        parameters: {
          prompt: {
            type: 'string',
            required: true,
            description: '非空的图片描述，包含主体、风格和构图；改图时写清要改什么、保留什么',
          },
          aspect_ratio: { type: 'string', enum: [...RATIOS], description: '画幅比例，默认取配置值' },
          reference_images: {
            type: 'array',
            items: { type: 'string' },
            description: `可选，1–${MAX_REFERENCES} 个参考图的 assetId（当前对话里能看到的图片）`,
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.ok
                ? `图片已生成（${value.model}，${value.aspectRatio}，${value.mediaType}），assetId：${value.assetId}。${value.note ?? ''}请用 send_channel_message 的 image 块携带此 assetId 发送图片。`
                : value.message,
            },
          ],
        },
        execute: async ({ prompt, aspect_ratio: ratioArg, reference_images: referenceArg }, execution) => {
          const description = typeof prompt === 'string' ? prompt.trim() : ''
          // 空输入验证即使在未来提供凭据也不会触发付费请求。
          if (!description) return { ok: false, message: '请提供非空的图片描述 prompt。' }
          if (ratioArg !== undefined && !isRatio(ratioArg))
            return { ok: false, message: `aspect_ratio 只能是 ${RATIOS.join('、')} 之一。` }
          if (
            referenceArg !== undefined &&
            (!Array.isArray(referenceArg) ||
              referenceArg.length > MAX_REFERENCES ||
              referenceArg.some((id) => typeof id !== 'string' || !id.trim()))
          )
            return { ok: false, message: `reference_images 是 1–${MAX_REFERENCES} 个图片 assetId 组成的列表。` }
          const referenceIds = [...new Set((referenceArg ?? []).map((id) => id.trim()))]

          const service = harness.config() as ServiceConfig
          const preference = ctx.config() as AgentConfig
          let endpoint: URL
          try {
            endpoint = new URL(service.endpoint?.trim() || DEFAULT_ENDPOINT)
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
          const model = service.model?.trim() || DEFAULT_MODEL
          const inferred = inferProfile(model)
          // 「调用方式」指定了与推断不同的接口时，按用户指定的来。
          const profile: ModelProfile =
            service.api && service.api !== 'auto' && service.api !== inferred.api
              ? service.api === 'images'
                ? GENERIC_IMAGES
                : { api: service.api }
              : inferred
          const ratio = ratioArg ?? configuredRatio(preference.size)
          const quality: Quality = preference.quality ?? 'low'
          try {
            const references: Reference[] = []
            for (const assetId of referenceIds) {
              try {
                references.push(await readReference(nxt, assetId, execution.signal))
              } catch (error) {
                if (error instanceof ServiceError) throw error
                throw new ServiceError(
                  `读不到参考图 ${assetId}：${String(error instanceof Error ? error.message : error).slice(0, 120)}`,
                )
              }
            }
            execution.progress({ text: `正在用 ${model} 生成图片` })
            // 占位符由宿主在发出时换成 API Key；凭据没有填写或被拒时 fetch 失败，由 post 转成说明。
            const apiKey = host.secrets.placeholder('apiKey')
            const auth = { authorization: `Bearer ${apiKey}` }
            const json = { ...auth, 'content-type': 'application/json' }
            let picture: Picture | undefined
            let replyText = ''

            if (profile.api === 'gemini') {
              const imageConfig: Record<string, string> = { aspectRatio: ratio }
              if (profile.imageSize && quality === 'high') imageConfig['imageSize'] = '2K'
              const body = await post(
                geminiUrl(endpoint, model),
                // Gemini 原生接口认 x-goog-api-key，中转多数也认 Bearer；两者发往同一服务。
                { ...json, 'x-goog-api-key': apiKey },
                {
                  body: JSON.stringify({
                    contents: [
                      {
                        role: 'user',
                        parts: [
                          { text: description },
                          ...references.map((reference) => ({
                            inlineData: { mimeType: reference.mediaType, data: reference.base64 },
                          })),
                        ],
                      },
                    ],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig },
                  }),
                },
              )
              picture = parseGeminiResponse(body)
              replyText = geminiText(body)
            } else if (profile.api === 'chat') {
              const body = await post(joinPath(endpoint, '/chat/completions'), json, {
                body: JSON.stringify({
                  model,
                  stream: false,
                  messages: [
                    {
                      role: 'user',
                      content: [
                        { type: 'text', text: `${description}\n\n画幅：${RATIO_WORDS[ratio]}。只输出一张图片。` },
                        ...references.map((reference) => ({
                          type: 'image_url',
                          image_url: { url: dataUrl(reference) },
                        })),
                      ],
                    },
                  ],
                }),
              })
              picture = parseChatResponse(body)
              replyText = chatText(body)
            } else {
              const fields: Record<string, string | number | readonly string[]> = { model, prompt: description, n: 1 }
              if (profile.sizes === 'gpt') fields['size'] = GPT_SIZES[ratio]
              else if (profile.sizes === 'seedream') fields['size'] = SEEDREAM_SIZES[ratio]
              // 不接受尺寸参数的模型把画幅写进描述。
              else fields['prompt'] = `${description}\n\n画幅：${RATIO_WORDS[ratio]}。`
              if (profile.quality) fields['quality'] = quality
              // 一律要 b64：不传时 Seedream、Grok Imagine 会返回别的域名上的网址，要多下载一次。
              // 服务明确拒绝这个参数时（如 OpenAI 官方的 GPT Image）去掉它重试一次，此时请求未开始生成，不会计费。
              fields['response_format'] = 'b64_json'
              // 一张参考图按实测的写法传字符串，多张传列表。
              if (references.length > 0 && profile.edit === 'json-image')
                fields['image'] = references.length === 1 ? dataUrl(references[0]!) : references.map(dataUrl)
              const send = (current: typeof fields) => {
                if (references.length > 0 && profile.edit === 'multipart') {
                  const form = multipart(
                    Object.fromEntries(Object.entries(current).map(([key, value]) => [key, String(value)])),
                    references.map((reference, index) => ({
                      name: references.length > 1 ? 'image[]' : 'image',
                      reference,
                      filename: `reference-${index + 1}.${EXTENSIONS[reference.mediaType] ?? 'png'}`,
                    })),
                  )
                  return post(
                    joinPath(endpoint, '/images/edits'),
                    { ...auth, 'content-type': form.contentType },
                    { bodyBase64: form.bodyBase64 },
                  )
                }
                return post(joinPath(endpoint, '/images/generations'), json, { body: JSON.stringify(current) })
              }
              let body: Record<string, unknown>
              try {
                body = await send(fields)
              } catch (error) {
                if (!(error instanceof ServiceError) || !/response_format/u.test(error.detail)) throw error
                const { response_format: _dropped, ...rest } = fields
                body = await send(rest)
              }
              picture = parseImagesResponse(body)
            }

            if (!picture)
              return {
                ok: false,
                message: replyText
                  ? `图片服务没有返回图片，只回复了文字：${replyText.slice(0, 200)}`
                  : `图片服务没有返回图片数据。请确认 ${model} 是画图模型，必要时在本机配置里修改「调用方式」。`,
              }
            const note =
              profile.api === 'images' && profile.sizes === 'gpt' && !['1:1', '2:3', '3:2'].includes(ratio)
                ? `这个模型只支持 1:1、2:3、3:2，已按最接近的 ${configuredRatio(GPT_SIZES[ratio])} 生成。`
                : undefined
            const done = (asset: { readonly assetId: string; readonly mediaType: string }): GenerateResult => ({
              ok: true,
              assetId: asset.assetId,
              mediaType: asset.mediaType,
              model,
              aspectRatio: ratio,
              ...(note ? { note } : {}),
            })
            if ('url' in picture) {
              // 优先请求 b64；服务仍只给网址时由宿主下载成 Asset。扩展有任意网络访问权限，
              // 图片放在别的域名下（如火山 TOS、imgen.x.ai）也能下载；本机与私网地址由宿主拦截，只有「服务地址」里用户填写的地址例外（network.fields，SDK 16）。
              try {
                return done(await nxt.assets.fromUrl(picture.url, { name: 'generated-image' }))
              } catch (error) {
                const reason = String(error instanceof Error ? error.message : error)
                return {
                  ok: false,
                  message: `图片已生成，但下载失败：${reason.slice(0, 160)}。这次生成可能已经计费，重试前请先确认。`,
                }
              }
            }
            const { base64, mediaType } = imageData(picture.base64, picture.mediaType)
            return done(
              await nxt.assets.create({
                base64,
                mediaType,
                name: `generated-image.${EXTENSIONS[mediaType] ?? 'png'}`,
              }),
            )
          } catch (error) {
            if (error instanceof ServiceError) return { ok: false, message: error.message }
            const reason = String(error instanceof Error ? error.message : error)
            return {
              ok: false,
              message: `生成图片失败：${reason.slice(0, 200)}${TIMEOUT_REASON.test(reason) ? `。${TIMEOUT_ADVICE}` : ''}`,
            }
          }
        },
      }),
    )
  },
}))
