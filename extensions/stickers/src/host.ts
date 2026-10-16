import {
  defineHostExtension,
  type ExtensionJsonValue,
  type ExtensionRpcCaller,
  type ExtensionToolResultBlock,
  type NxtHostService,
  type NxtImageInfo,
  type NxtInboundMessage,
  type NxtIndexCondition,
} from '@nekro-nxt/extension-sdk'

/**
 * 表情包：从群聊里收集大家常发的表情包，智能体聊天时按意思挑一张发出去；表情包默认在群之间流通，群里特有的内容只留在原来的群。
 *
 * 示范要点：
 * - 收集不占智能体的回合：入站处理函数（`harness.onInbound`）记下每张图被哪些人发过，达到门槛后收进资源库、排进收集队列；
 * - 收集队列在本机实例里按页面设置的并行数处理：先按固定规则过滤，再用页面选择的标注模型（本机层 `models`）写用途与配文、判断能否公共；
 * - 智能体收藏只交一个图片编号，同样进收集队列；使用时搜索结果附上候选图，智能体确认后再发，并顺手修正、收紧或清理；
 * - 使用提示随消息附注（annotation）给出，按使用频率在一个随机区间里出现，不改系统提示；
 * - 本机实例持有记录与候选的内存副本，所有读改写经同一个队列，避免并发写丢失。
 */

const COLLECTION = 'stickers'
const RECORD_PREFIX = 's/'
const CANDIDATE_PREFIX = 'c/'
const CHANNEL_PREFIX = 'channel/'
const RECENT_PREFIX = 'recent/'
const SETTINGS_KEY = 'settings'
const IMPORT_KEY = 'import'
const QUEUE_KEY = 'queue'
const COLLECT_KEY = 'collect'
const TRASH_DAYS = 30
const CANDIDATE_DAYS = 30
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const MAX_BYTES = 8 * 1024 * 1024
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const RECENT_LIMIT = 20
const MAX_TAGS = 8
const LABEL_ATTEMPTS = 3
const QUEUE_LIMIT = 300
const MAX_CHANNELS = 16
const MAX_SENDERS = 3
/** 与 extension.json 中 `models.maxCallsPerMinute` 一致；超过时宿主直接拒绝，所以在这里先排队。 */
const MODEL_CALLS_PER_MINUTE = 60
/** 表情包很少超过这个边长，也很少是长条；照片、截图和长图在调用模型之前就排除。 */
const MAX_SIDE = 2048
const MIN_SIDE = 16
const MAX_RATIO = 3
const DENSITY_WINDOW = 30
const TIP = '这次回复适合配一张表情包，有合适的就发。'

type Scope = 'public' | 'local'

interface Sticker {
  /** 即资源库里的 assetId。 */
  readonly id: string
  readonly meaning: string
  readonly caption: string
  readonly description: string
  readonly tags: readonly string[]
  readonly scope: Scope
  /** 出现过它的频道；仅限来源频道的图只在这些频道使用。 */
  readonly sources: readonly string[]
  /** 发到过的频道，用来列出「跨频道发送」。 */
  readonly sentTo: readonly string[]
  readonly collector?: string
  readonly collectorName?: string
  readonly origin: 'chat' | 'import'
  readonly mediaType: string
  readonly width: number
  readonly height: number
  readonly frames: number
  readonly byteSize: number
  readonly dhash: string
  readonly addedAt: number
  readonly updatedAt: number
  readonly sentCount: number
  readonly lastSentAt?: number
  readonly deletedAt?: number
  /** 导入时选了模型却没判断成：补写时按模型的判断定使用范围。 */
  readonly unjudged?: true
}

/** 群聊里出现过、还没入库的图。 */
interface Candidate {
  readonly id: string
  /** 发过它的成员，最多记 3 个（门槛的上限）。 */
  readonly senders: readonly string[]
  readonly channels: readonly string[]
  /** 平台标为表情包；只作参考。 */
  readonly hint: boolean
  readonly firstAt: number
  readonly lastAt: number
  /** 计数中、已进收集队列、判断为不收。 */
  readonly state: 'counting' | 'queued' | 'rejected'
  readonly collector?: string
}

/** 收集队列里的一张图；图片已经在资源库里。 */
interface CollectItem {
  readonly assetId: string
  readonly channels: readonly string[]
  readonly hint: boolean
  /** 智能体交来的，不是靠计数达到门槛。 */
  readonly requested: boolean
  readonly note?: string
  readonly collector?: string
  readonly collectorName?: string
  readonly addedAt: number
}

interface CollectStatus {
  readonly added: number
  readonly rejected: number
  readonly failed: number
  readonly errors: readonly string[]
}

interface Settings {
  readonly paused: boolean
  /** 收集队列用的标注模型；没选时队列只排队不处理。 */
  readonly model?: string
  /** 被几个不同的人发过才收集。 */
  readonly threshold: number
  /** 同时处理几张（收集与导入共用）。 */
  readonly concurrency: number
}

interface ChannelSettings {
  /** 在这个频道收集的图：按标注模型判断能否公共、一律仅限本频道、不收集。 */
  readonly collect: 'auto' | 'local' | 'off'
  /** 在这个频道使用：库里可用的、只用本频道的、不使用。 */
  readonly use: 'all' | 'local' | 'off'
}

interface ImportJob {
  readonly state: 'running' | 'done' | 'cancelled'
  readonly model?: string
  readonly queue: readonly { readonly assetId: string; readonly name: string }[]
  readonly total: number
  readonly done: number
  readonly skipped: number
  readonly failed: number
  readonly errors: readonly string[]
}

type Failure = { readonly ok: false; readonly message: string }
const fail = (message: string): Failure => ({ ok: false, message })

const THRESHOLDS = [1, 2, 3]
const CONCURRENCY = [1, 2, 3, 4, 6, 8]
const DEFAULT_SETTINGS: Settings = { paused: false, threshold: 2, concurrency: 2 }

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim().slice(0, max) : ''
const words = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、\s]+/u) : []
  return [...new Set(list.map((entry) => clip(entry, 16)).filter(Boolean))].slice(0, MAX_TAGS)
}
const text = (value: string): ExtensionToolResultBlock[] => [{ type: 'text', text: value }]
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** 加进列表末尾，超出上限时丢掉最早的。 */
const including = <T>(list: readonly T[], value: T, max: number): readonly T[] =>
  list.includes(value) ? list : [...list, value].slice(-max)

const channelSettings = (value: unknown): ChannelSettings => {
  const saved = record(value)
  return {
    collect: saved['collect'] === 'local' || saved['collect'] === 'off' ? saved['collect'] : 'auto',
    use: saved['use'] === 'local' || saved['use'] === 'off' ? saved['use'] : 'all',
  }
}

const parseSettings = (value: unknown): Settings => {
  const saved = record(value)
  const model = clip(saved['model'], 200)
  return {
    paused: saved['paused'] === true,
    ...(model ? { model } : {}),
    threshold: THRESHOLDS.includes(Number(saved['threshold']))
      ? Number(saved['threshold'])
      : DEFAULT_SETTINGS.threshold,
    concurrency: CONCURRENCY.includes(Number(saved['concurrency']))
      ? Number(saved['concurrency'])
      : DEFAULT_SETTINGS.concurrency,
  }
}

/** 管理页与面板展示用的一条记录。 */
const summary = (sticker: Sticker) => ({ ...sticker, tags: [...sticker.tags] })

const isAvailable = (
  sticker: Sticker,
  input: {
    readonly channelId: string
    readonly use: ChannelSettings['use']
    readonly paused: boolean
    readonly collector?: string
  },
): boolean => {
  if (sticker.deletedAt !== undefined || input.use === 'off') return false
  if (input.collector !== undefined && sticker.collector !== input.collector) return false
  if (sticker.sources.includes(input.channelId)) return true
  return sticker.scope === 'public' && input.use === 'all' && !input.paused
}

/**
 * 固定规则：不调用模型就能排除的图，返回原因。智能体交来的图只查格式和大小，长图、截图也按它的意思收下，
 * 由标注模型决定能否公共。
 */
const pictureProblem = (info: NxtImageInfo, requested: boolean): string | undefined => {
  if (!PICTURE_TYPES.has(info.mediaType)) return '不是 PNG、JPEG、GIF 或 WebP 图片'
  if (info.byteSize > MAX_BYTES) return '超过 8 MB'
  if (requested) return undefined
  const long = Math.max(info.width, info.height)
  const short = Math.min(info.width, info.height)
  if (short < MIN_SIDE) return '图片太小'
  if (long / short > MAX_RATIO) return '是长图'
  if (long > MAX_SIDE && info.frames === 1) return '尺寸像照片或截图'
  return undefined
}

const LABEL_PROMPT = [
  '这是一张准备收进表情包库的图片。只输出一个 JSON 对象，不要输出别的内容，字段按下面的顺序：',
  '{"sticker":表情包或反应图为 true，截图、照片、聊天记录、长图为 false,',
  '"shareable":图里有聊天记录、群名、昵称、账号、真实照片或个人信息时为 false，否则为 true,',
  '"meaning":"这张图在聊天里表达什么、适合在什么情况下发，一到两句，写用途不写外观",',
  '"caption":"图里文字的原文，最多 50 字，没有就是空字符串","description":"一句话描述画面",',
  '"tags":["2 到 5 个短标签"]}',
].join('')

/** 收集来的图附上来历，帮模型判断；平台标记只作参考。 */
const collectPrompt = (item: CollectItem): string =>
  [
    LABEL_PROMPT,
    item.requested ? '智能体在群聊里把这张图交来收藏。' : '这张图在群聊里被不同的人发过。',
    item.hint ? '平台把它标为表情包，仅供参考。' : '',
    item.note ? `智能体的备注：${item.note}` : '',
  ]
    .filter(Boolean)
    .join('\n')

/** 回答里最后一个能解析的 JSON 对象；有的模型会先写一段思考或说明。 */
const lastJsonObject = (reply: string): Record<string, unknown> | undefined => {
  const body = reply.replaceAll(/<think>[\s\S]*?<\/think>/gu, '')
  for (let end = body.lastIndexOf('}'); end >= 0; end = body.lastIndexOf('}', end - 1)) {
    for (let start = body.lastIndexOf('{', end); start >= 0; start = body.lastIndexOf('{', start - 1)) {
      try {
        const parsed: unknown = JSON.parse(body.slice(start, end + 1))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // 不是完整的对象，再往前找。
      }
    }
  }
  return undefined
}

const parseLabel = (reply: string) => {
  const parsed = lastJsonObject(reply)
  if (parsed === undefined) {
    const excerpt = reply.replaceAll(/\s+/gu, ' ').trim().slice(0, 40)
    throw new Error(excerpt ? `模型没有按格式回答：「${excerpt}」` : '模型没有回答')
  }
  return {
    meaning: clip(parsed['meaning'], 200),
    caption: clip(parsed['caption'], 200),
    description: clip(parsed['description'], 200),
    tags: words(parsed['tags']),
    sticker: parsed['sticker'] === true,
    // 没有明确判断为可以公共的，一律先仅限来源频道；管理员可以在页面上改。
    shareable: parsed['sticker'] === true && parsed['shareable'] === true,
  }
}
type Label = ReturnType<typeof parseLabel>

/** 文件名本身有意义时（比如「猫猫哭泣.gif」）拿来当描述；随机串、编号不用。 */
const nameDescription = (name: string): string => {
  const stem = (name.split('/').at(-1) ?? name).replace(/\.[a-z0-9]+$/iu, '')
  return /[\p{Script=Han}]/u.test(stem) ? clip(stem.replaceAll(/[_-]+/gu, ' '), 60) : ''
}

type Frequency = 'smart' | 'often' | 'moderate' | 'sometimes' | 'rare'

const FREQUENCY: Record<Frequency, string> = {
  smart: '使用频率：跟着聊天气氛走，大家常发表情包、聊得轻松时多用，讨论正事时少用。',
  often: '使用频率：多用表情包；情绪明显的时候，可以只发一张表情包当作回复。',
  moderate: '使用频率：适量用表情包，挑情绪明显的时候。',
  sometimes: '使用频率：少用表情包，留给最合适的时候。',
  rare: '使用频率：很少用表情包，只在特别合适、不发反而显得冷淡的时候用。',
}

/** 两次提示之间隔几条会唤醒智能体的消息；「极少」不提示。 */
const TIP_RANGES: Record<'often' | 'moderate' | 'sometimes', readonly [number, number]> = {
  often: [2, 4],
  moderate: [4, 6],
  sometimes: [8, 12],
}

/** 「智能判断」按群里最近发表情包的密度定提示间隔；几乎没人发表情包的群不提示。 */
const smartRange = (window: readonly boolean[] | undefined): readonly [number, number] | undefined => {
  if (window === undefined || window.length < 10) return [4, 7]
  const density = window.filter(Boolean).length / window.length
  if (density >= 0.2) return [2, 4]
  if (density >= 0.08) return [4, 7]
  if (density > 0) return [8, 14]
  return undefined
}

const tipRange = (frequency: Frequency, window: readonly boolean[] | undefined) =>
  frequency === 'smart' ? smartRange(window) : frequency === 'rare' ? undefined : TIP_RANGES[frequency]

const draw = ([low, high]: readonly [number, number]): number => low + Math.floor(Math.random() * (high - low + 1))

/** 像表情包的消息：平台标了表情包，或者只有一张图、没有文字。 */
const stickerLike = (message: NxtInboundMessage): boolean =>
  message.images.some((image) => image.sticker) ||
  (message.images.length === 1 && message.text.replaceAll(/\[(?:图片|表情包)[^\]]*\]/gu, '').trim() === '')

const GUIDE = (collect: 'auto' | 'asked' | 'off', frequency: Frequency): string =>
  [
    '你可以给群里发表情包。库里的表情包可能来自你待过的各个群。',
    '发表情包：想用一张图表达情绪或回应时，先用 sticker_search 按想表达的意思找，比如「被夸了有点得意」；从候选里挑一张，用 sticker_use 取得 assetId，再用 send_channel_message 的 image 块发出去。都不合适就不发。',
    FREQUENCY[frequency],
    collect === 'auto'
      ? '收藏：群里大家常发的表情包会自动收进库里。看到值得收藏的，或者有人请你收藏某张图，用 sticker_save 把图片编号交过去就行，用途和能否带到别的群由表情包库判断。'
      : collect === 'asked'
        ? '收藏：有人请你收藏某张图时，用 sticker_save 把图片编号交过去就行，用途和能否带到别的群由表情包库判断。'
        : '',
    '整理：搜索结果里描述不对的，用 sticker_update 改；发现不该带到别的群的，用 sticker_update 把 scope 改成 local；根本不是表情包的，用 sticker_remove。有人说别再发某张，或别把它带到别的群，也照做。',
    '表情包的编号只在工具里用，不要在聊天里说出来。',
  ]
    .filter(Boolean)
    .join('\n')

export default defineHostExtension(async ({ harness, nxt: host }) => {
  // 所有读改写排进同一个队列：工具、页面接口、入站处理与收集任务可能同时修改同一条记录。
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => undefined).then(action)
    queue = next
    return next
  }

  /** 按前缀把存储读进内存。 */
  const loadAll = async <T extends { readonly id: string }>(prefix: string): Promise<Map<string, T>> => {
    const all = new Map<string, T>()
    let after: string | undefined
    do {
      const page = await host.storage.list({ prefix, limit: 200, ...(after ? { after } : {}) })
      for (const entry of page.entries) {
        const value = record(entry.value)
        if (typeof value['id'] === 'string') all.set(value['id'], value as unknown as T)
      }
      after = page.next
    } while (after)
    return all
  }
  // 记录与候选的内存副本，首次使用时从存储读入。
  let loadedStickers: Promise<Map<string, Sticker>> | undefined
  const stickers = (): Promise<Map<string, Sticker>> => (loadedStickers ??= loadAll<Sticker>(RECORD_PREFIX))
  let loadedCandidates: Promise<Map<string, Candidate>> | undefined
  const candidates = (): Promise<Map<string, Candidate>> => (loadedCandidates ??= loadAll<Candidate>(CANDIDATE_PREFIX))

  const indexDocument = (sticker: Sticker) => ({
    fields: {
      meaning: sticker.meaning,
      caption: sticker.caption,
      description: sticker.description,
      tags: sticker.tags.join(' '),
    },
    filters: {
      scope: sticker.scope,
      sources: [...sticker.sources],
      ...(sticker.collector === undefined ? {} : { collector: sticker.collector }),
    },
  })

  /** 保存一条记录并同步索引；回收站里的不进索引。 */
  const put = async (sticker: Sticker): Promise<Sticker> => {
    const all = await stickers()
    await host.storage.set(`${RECORD_PREFIX}${sticker.id}`, sticker as unknown as ExtensionJsonValue)
    all.set(sticker.id, sticker)
    if (sticker.deletedAt === undefined) await host.index.upsert(COLLECTION, sticker.id, indexDocument(sticker))
    else await host.index.delete(COLLECTION, sticker.id)
    return sticker
  }

  const putCandidate = async (candidate: Candidate): Promise<void> => {
    await host.storage.set(`${CANDIDATE_PREFIX}${candidate.id}`, candidate as unknown as ExtensionJsonValue)
    ;(await candidates()).set(candidate.id, candidate)
  }
  const dropCandidate = async (assetId: string): Promise<void> => {
    const all = await candidates()
    if (!all.has(assetId)) return
    await host.storage.delete(`${CANDIDATE_PREFIX}${assetId}`)
    all.delete(assetId)
  }

  /** 回收站里超过 30 天的彻底删除，图片移出资源库。 */
  const purge = async (now: number) => {
    const all = await stickers()
    for (const sticker of [...all.values()]) {
      if (sticker.deletedAt === undefined || now - sticker.deletedAt < TRASH_DAYS * DAY) continue
      await host.storage.delete(`${RECORD_PREFIX}${sticker.id}`)
      await host.index.delete(COLLECTION, sticker.id)
      await host.assets.release(sticker.id)
      all.delete(sticker.id)
    }
  }

  /** 30 天没再出现的候选不再计数，判断为不收的过 30 天也可以重新判断；排队中的留着。每小时最多清一次。 */
  let prunedAt = 0
  const pruneCandidates = async (now: number) => {
    if (now - prunedAt < HOUR) return
    prunedAt = now
    for (const candidate of [...(await candidates()).values()]) {
      if (candidate.state !== 'queued' && now - candidate.lastAt >= CANDIDATE_DAYS * DAY) {
        await dropCandidate(candidate.id)
      }
    }
  }

  const readSettings = async (): Promise<Settings> => parseSettings(await host.storage.get(SETTINGS_KEY))
  const readChannel = async (channelId: string) =>
    channelSettings(await host.storage.get(`${CHANNEL_PREFIX}${channelId}`))
  const readQueue = async (): Promise<readonly CollectItem[]> => {
    const saved = await host.storage.get(QUEUE_KEY)
    return Array.isArray(saved) ? (saved as unknown as CollectItem[]) : []
  }
  const writeQueue = (items: readonly CollectItem[]) =>
    host.storage.set(QUEUE_KEY, items as unknown as ExtensionJsonValue)
  const readStatus = async (): Promise<CollectStatus> => {
    const saved = record(await host.storage.get(COLLECT_KEY))
    return {
      added: Number(saved['added']) || 0,
      rejected: Number(saved['rejected']) || 0,
      failed: Number(saved['failed']) || 0,
      errors: Array.isArray(saved['errors']) ? (saved['errors'] as string[]) : [],
    }
  }

  /** 资源库里的图没有记录在用时移出。 */
  const releaseUnused = async (assetId: string) => {
    if (!(await stickers()).has(assetId)) await host.assets.release(assetId).catch(() => false)
  }

  const collectItem = (candidate: Candidate, requested: boolean, extra: Partial<CollectItem> = {}): CollectItem => ({
    assetId: candidate.id,
    channels: candidate.channels,
    hint: candidate.hint,
    requested,
    ...(candidate.collector === undefined ? {} : { collector: candidate.collector }),
    addedAt: Date.now(),
    ...extra,
  })

  /** 放进收集队列，同一张图合并来源；图片要已经在资源库里。调用方在 serial 里。 */
  const enqueue = async (item: CollectItem) => {
    const items = await readQueue()
    const existing = items.find((entry) => entry.assetId === item.assetId)
    await writeQueue(
      existing === undefined
        ? [...items, item]
        : items.map((entry) =>
            entry === existing
              ? {
                  ...entry,
                  channels: [...new Set([...entry.channels, ...item.channels])].slice(-MAX_CHANNELS),
                  requested: entry.requested || item.requested,
                  hint: entry.hint || item.hint,
                  ...(entry.note || !item.note ? {} : { note: item.note }),
                  ...(entry.collectorName || !item.collectorName
                    ? {}
                    : { collector: item.collector, collectorName: item.collectorName }),
                }
              : entry,
          ),
    )
  }

  // ---------- 标注模型：按分钟限速，偶尔答偏或网络出错时重试 ----------
  const modelCalls: number[] = []
  const modelSlot = async (): Promise<void> => {
    for (;;) {
      const now = Date.now()
      while (modelCalls.length > 0 && now - modelCalls[0]! >= 60_000) modelCalls.shift()
      if (modelCalls.length < MODEL_CALLS_PER_MINUTE) {
        modelCalls.push(now)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 60_000 - (now - modelCalls[0]!) + 10))
    }
  }
  const label = async (assetId: string, model: string, prompt: string): Promise<Label> => {
    let lastError: unknown
    for (let attempt = 0; attempt < LABEL_ATTEMPTS; attempt += 1) {
      try {
        await modelSlot()
        const reply = await host.models.complete({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image', assetId },
              ],
            },
          ],
          maxOutputTokens: 1024,
        })
        return parseLabel(reply.text)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  // ---------- 批量导入 ----------
  const readImport = async (): Promise<ImportJob | undefined> => {
    const saved = record(await host.storage.get(IMPORT_KEY))
    return typeof saved['state'] === 'string' ? (saved as unknown as ImportJob) : undefined
  }
  const writeImport = (job: ImportJob) => host.storage.set(IMPORT_KEY, job as unknown as ExtensionJsonValue)

  /** 导入或补写一张：用所选模型写用途与配文；模型失败时照样收下，用途留空，记为失败。 */
  const importOne = async (item: { readonly assetId: string; readonly name: string }, model: string | undefined) => {
    const info = await host.image.info(item.assetId)
    let result: Label = {
      meaning: '',
      caption: '',
      description: nameDescription(item.name),
      tags: [],
      sticker: true,
      // 不选模型是管理员自己决定直接导入；选了模型却没判断成的，先仅限来源频道。
      shareable: !model,
    }
    let labelError: unknown
    if (model) {
      try {
        result = await label(item.assetId, model, LABEL_PROMPT)
      } catch (error) {
        labelError = error
      }
    }
    const outcome = await serial(async () => {
      const existing = (await stickers()).get(item.assetId)
      const now = Date.now()
      if (existing !== undefined && existing.deletedAt === undefined) {
        // 已在库里：只给还没写用途的补写文字；判断为不宜公共的改为仅限来源频道，导入时没判断成的才可能放开。
        if (existing.meaning || !result.meaning) return 'skipped' as const
        const { unjudged, ...rest } = existing
        await put({
          ...rest,
          ...(model && !result.shareable
            ? { scope: 'local' as const }
            : unjudged && model
              ? { scope: 'public' as const }
              : {}),
          meaning: result.meaning,
          caption: existing.caption || result.caption,
          description: existing.description || result.description,
          tags: [...new Set([...existing.tags, ...result.tags])].slice(0, MAX_TAGS),
          updatedAt: now,
        })
        return 'added' as const
      }
      await put({
        id: item.assetId,
        meaning: result.meaning,
        caption: result.caption,
        description: result.description,
        tags: result.tags,
        // 导入的图没有来源频道：判断为不宜公共的只留在库里，等管理员在页面上决定。
        scope: result.shareable ? 'public' : 'local',
        sources: [],
        sentTo: [],
        origin: 'import',
        mediaType: info.mediaType,
        width: info.width,
        height: info.height,
        frames: info.frames,
        byteSize: info.byteSize,
        dhash: info.dhash,
        addedAt: now,
        updatedAt: now,
        sentCount: 0,
        ...(labelError === undefined ? {} : { unjudged: true as const }),
      })
      return 'added' as const
    })
    if (labelError !== undefined) throw labelError
    return outcome
  }

  // ---------- 收集队列 ----------
  /** 判断为不收：记下来，30 天内再出现不再判断，图片移出资源库。 */
  const reject = (item: CollectItem) =>
    serial(async () => {
      const now = Date.now()
      const candidate = (await candidates()).get(item.assetId)
      await putCandidate({
        id: item.assetId,
        senders: candidate?.senders ?? [],
        channels: candidate?.channels ?? item.channels,
        hint: item.hint,
        firstAt: candidate?.firstAt ?? now,
        lastAt: now,
        state: 'rejected',
      })
      await releaseUnused(item.assetId)
    })

  /** 处理一张：固定规则 → 已在库里就合并来源 → 标注模型判断与标注 → 入库或不收。 */
  const collectOne = async (item: CollectItem, model: string): Promise<'added' | 'merged' | 'rejected'> => {
    const info = await host.image.info(item.assetId)
    if (pictureProblem(info, item.requested) !== undefined) {
      await reject(item)
      return 'rejected'
    }
    const merged = await serial(async () => {
      const existing = (await stickers()).get(item.assetId)
      if (existing === undefined) return false
      if (existing.deletedAt === undefined) {
        await put({
          ...existing,
          sources: [...new Set([...existing.sources, ...item.channels])],
          updatedAt: Date.now(),
        })
      }
      return true
    })
    if (merged) return 'merged'

    const result = await label(item.assetId, model, collectPrompt(item))
    // 智能体交来的图即使不像表情包也收下，只是仅限来源频道。
    if (!result.sticker && !item.requested) {
      await reject(item)
      return 'rejected'
    }
    const modes = await Promise.all(item.channels.map(async (channel) => (await readChannel(channel)).collect))
    return serial(async () => {
      if ((await stickers()).has(item.assetId)) return 'merged' as const
      const now = Date.now()
      await put({
        id: item.assetId,
        meaning: result.meaning,
        caption: result.caption,
        description: result.description,
        tags: result.tags,
        scope: result.shareable && !modes.includes('local') ? 'public' : 'local',
        sources: [...item.channels],
        sentTo: [],
        ...(item.collector === undefined ? {} : { collector: item.collector }),
        ...(item.collectorName === undefined ? {} : { collectorName: item.collectorName }),
        origin: 'chat',
        mediaType: info.mediaType,
        width: info.width,
        height: info.height,
        frames: info.frames,
        byteSize: info.byteSize,
        dhash: info.dhash,
        addedAt: now,
        updatedAt: now,
        sentCount: 0,
      })
      return 'added' as const
    })
  }

  // ---------- 工作池：导入任务与收集队列共用并行数 ----------
  const working = new Set<string>()
  let filling: Promise<void> = Promise.resolve()

  const finishImport = (
    key: string,
    item: { readonly assetId: string; readonly name: string },
    outcome: PromiseSettledResult<'added' | 'skipped'>,
  ) =>
    serial(async () => {
      const latest = await readImport()
      if (latest?.state !== 'running') return
      const error = outcome.status === 'rejected' ? `${item.name}：${errorText(outcome.reason)}` : undefined
      const remaining = latest.queue.filter((entry) => entry.assetId !== item.assetId)
      const othersRunning = [...working].some((entry) => entry.startsWith('import:') && entry !== key)
      await writeImport({
        ...latest,
        state: remaining.length === 0 && !othersRunning ? 'done' : 'running',
        queue: remaining,
        done: latest.done + (outcome.status === 'fulfilled' ? 1 : 0),
        skipped: latest.skipped + (outcome.status === 'fulfilled' && outcome.value === 'skipped' ? 1 : 0),
        failed: latest.failed + (error === undefined ? 0 : 1),
        errors: error === undefined ? latest.errors : [...latest.errors, error].slice(-20),
      })
    })

  const finishCollect = (item: CollectItem, outcome: PromiseSettledResult<'added' | 'merged' | 'rejected'>) =>
    serial(async () => {
      await writeQueue((await readQueue()).filter((entry) => entry.assetId !== item.assetId))
      if (outcome.status === 'fulfilled') {
        // 入库或合并后不再需要候选；判断为不收的已经记下。
        if (outcome.value !== 'rejected') await dropCandidate(item.assetId)
      } else {
        // 没判断成：图片移出资源库，候选回到计数，之后再有人发时重新排队。
        const candidate = (await candidates()).get(item.assetId)
        if (candidate !== undefined) await putCandidate({ ...candidate, state: 'counting' })
        await releaseUnused(item.assetId)
      }
      const status = await readStatus()
      await host.storage.set(COLLECT_KEY, {
        added: status.added + (outcome.status === 'fulfilled' && outcome.value === 'added' ? 1 : 0),
        rejected: status.rejected + (outcome.status === 'fulfilled' && outcome.value === 'rejected' ? 1 : 0),
        failed: status.failed + (outcome.status === 'rejected' ? 1 : 0),
        errors:
          outcome.status === 'rejected' ? [...status.errors, errorText(outcome.reason)].slice(-10) : [...status.errors],
      })
    })

  /** 下一件可以开始的事：先做导入任务，再做收集队列（选了标注模型才做）。 */
  const nextWork = async (settings: Settings): Promise<{ key: string; run: () => Promise<void> } | undefined> => {
    const job = await readImport()
    if (job?.state === 'running') {
      const item = job.queue.find((entry) => !working.has(`import:${entry.assetId}`))
      if (item !== undefined) {
        const key = `import:${item.assetId}`
        return {
          key,
          run: async () => {
            const [outcome] = await Promise.allSettled([importOne(item, job.model)])
            await finishImport(key, item, outcome!)
          },
        }
      }
      // 队列空了而最后几张同时完成时，由这里收尾。
      if (job.queue.length === 0 && ![...working].some((entry) => entry.startsWith('import:'))) {
        await serial(async () => {
          const latest = await readImport()
          if (latest?.state === 'running' && latest.queue.length === 0) await writeImport({ ...latest, state: 'done' })
        })
      }
    }
    const model = settings.model
    if (model === undefined) return undefined
    const item = (await readQueue()).find((entry) => !working.has(`collect:${entry.assetId}`))
    if (item === undefined) return undefined
    return {
      key: `collect:${item.assetId}`,
      run: async () => {
        const [outcome] = await Promise.allSettled([collectOne(item, model)])
        await finishCollect(item, outcome!)
      },
    }
  }

  /** 按并行数补满正在处理的工作；每件做完后再补。 */
  const pump = (): Promise<void> =>
    (filling = filling
      .then(async () => {
        const settings = await readSettings()
        while (working.size < settings.concurrency) {
          const next = await nextWork(settings)
          if (next === undefined) return
          working.add(next.key)
          void next
            .run()
            .catch(() => undefined)
            .finally(() => {
              working.delete(next.key)
              void pump()
            })
        }
      })
      .catch(() => undefined))

  // 上次没做完的导入和收集在本机实例启动后接着做。
  void pump()

  // ---------- 入站：记下谁发过哪张图，按使用频率给出提示 ----------
  /** 每个频道最近的消息是否像表情包，「智能判断」按它定提示间隔。 */
  const density = new Map<string, boolean[]>()
  /** 每个频道距上次提示或发表情包过了几条会唤醒智能体的消息，以及这次抽到的间隔。 */
  const tips = new Map<string, { since: number; target: number }>()

  const observe = (
    channelId: string,
    image: NxtInboundMessage['images'][number],
    sender: string,
    agentId: string,
    nxt: NxtHostService,
  ) =>
    serial(async () => {
      const now = Date.now()
      const existing = (await stickers()).get(image.assetId)
      if (existing !== undefined) {
        // 已在库里：记下它又在这个频道出现过。回收站里的不动。
        if (existing.deletedAt === undefined && !existing.sources.includes(channelId)) {
          await put({ ...existing, sources: [...existing.sources, channelId], updatedAt: now })
        }
        return
      }
      const before = (await candidates()).get(image.assetId)
      const candidate: Candidate = {
        id: image.assetId,
        senders: including(before?.senders ?? [], sender, MAX_SENDERS),
        channels: including(before?.channels ?? [], channelId, MAX_CHANNELS),
        hint: (before?.hint ?? false) || image.sticker,
        firstAt: before?.firstAt ?? now,
        lastAt: now,
        state: before?.state ?? 'counting',
        ...(before?.collector === undefined ? {} : { collector: before.collector }),
      }
      const { threshold } = await readSettings()
      if (candidate.state !== 'counting' || candidate.senders.length < threshold) {
        if (candidate.state === 'queued') await enqueue(collectItem(candidate, false))
        await putCandidate(candidate)
        return
      }
      if ((await readQueue()).length >= QUEUE_LIMIT) {
        await putCandidate(candidate)
        return
      }
      try {
        await nxt.assets.keep(image.assetId)
      } catch {
        // 图片已经不在这个频道里，下次再出现时重来。
        await putCandidate(candidate)
        return
      }
      const queued: Candidate = { ...candidate, state: 'queued', collector: agentId }
      await putCandidate(queued)
      await enqueue(collectItem(queued, false))
    })

  const tipFor = async (channelId: string, frequency: Frequency): Promise<string | undefined> => {
    const range = tipRange(frequency, density.get(channelId))
    if (range === undefined) return undefined
    const channel = await readChannel(channelId)
    if (channel.use === 'off') return undefined
    const { paused } = await readSettings()
    const usable = [...(await stickers()).values()].some((sticker) =>
      isAvailable(sticker, { channelId, use: channel.use, paused }),
    )
    if (!usable) return undefined
    const state = tips.get(channelId) ?? { since: 0, target: draw(range) }
    state.since += 1
    tips.set(channelId, state)
    if (state.since < state.target) return undefined
    tips.set(channelId, { since: 0, target: draw(range) })
    return TIP
  }

  harness.onInbound?.(async (message, nxt) => {
    const config = record(nxt.config())
    const channelId = message.channel.id
    density.set(channelId, [...(density.get(channelId) ?? []), stickerLike(message)].slice(-DENSITY_WINDOW))

    const sender = message.sender?.memberId
    if (config['collect'] !== 'asked' && config['collect'] !== 'off' && message.images.length > 0 && sender) {
      if ((await readChannel(channelId)).collect !== 'off') {
        const call = await nxt.context.current()
        // 智能体自己发的图不计数。
        if (sender !== call.channel.selfMemberId) {
          for (const image of message.images) await observe(channelId, image, sender, call.agent.id, nxt)
          void pump()
        }
      }
      void serial(() => pruneCandidates(Date.now()))
    }

    if (!message.wouldTrigger) return undefined
    const frequency =
      typeof config['frequency'] === 'string' && config['frequency'] in FREQUENCY
        ? (config['frequency'] as Frequency)
        : 'smart'
    const tip = await tipFor(channelId, frequency)
    return tip === undefined ? undefined : { annotation: tip }
  })

  // ---------- 页面与面板的界面数据接口 ----------
  const channelOf = (caller: ExtensionRpcCaller): string | undefined =>
    caller.surface === 'panel' ? caller.channelId : undefined

  harness.handle('library.overview', async () => {
    await serial(() => purge(Date.now()))
    const all = [...(await stickers()).values()]
    const live = all.filter((sticker) => sticker.deletedAt === undefined)
    return {
      total: live.length,
      public: live.filter((sticker) => sticker.scope === 'public').length,
      local: live.filter((sticker) => sticker.scope === 'local').length,
      unlabeled: live.filter((sticker) => !sticker.meaning).length,
      trash: all.length - live.length,
      paused: (await readSettings()).paused,
    }
  })

  harness.handle('library.list', async (input) => {
    const options = record(input)
    const view = clip(options['view'], 16) || 'all'
    const query = clip(options['query'], 100)
    const offset = Math.max(0, Math.trunc(Number(options['offset']) || 0))
    const limit = Math.min(Math.max(Math.trunc(Number(options['limit']) || 60), 1), 120)
    const all = await stickers()
    let items = [...all.values()]
    items =
      view === 'trash'
        ? items.filter((sticker) => sticker.deletedAt !== undefined)
        : items.filter((sticker) => sticker.deletedAt === undefined)
    if (view === 'public' || view === 'local') items = items.filter((sticker) => sticker.scope === view)
    if (view === 'unlabeled') items = items.filter((sticker) => !sticker.meaning)
    if (view === 'flowed') {
      items = items
        .filter((sticker) => sticker.sentTo.some((channel) => !sticker.sources.includes(channel)))
        .sort((left, right) => (right.lastSentAt ?? 0) - (left.lastSentAt ?? 0))
    } else {
      // 检索不可用时退回逐条匹配文字，页面照常列出结果。
      const ranked =
        query && view !== 'trash'
          ? await host.index
              .query(COLLECTION, query, { limit: 50 })
              .then((result) => result.hits.map(({ id }) => id))
              .catch(() => undefined)
          : undefined
      if (ranked !== undefined) {
        items = ranked.flatMap((id) => items.filter((sticker) => sticker.id === id))
      } else {
        if (query) {
          items = items.filter((sticker) =>
            [sticker.meaning, sticker.caption, sticker.description, ...sticker.tags].some((value) =>
              value.includes(query),
            ),
          )
        }
        items.sort((left, right) =>
          view === 'trash' ? (right.deletedAt ?? 0) - (left.deletedAt ?? 0) : right.addedAt - left.addedAt,
        )
      }
    }
    return {
      total: items.length,
      items: items.slice(offset, offset + limit).map(summary),
    } as unknown as ExtensionJsonValue
  })

  harness.handle('library.update', (input) =>
    serial(async () => {
      const options = record(input)
      const sticker = (await stickers()).get(clip(options['id'], 128))
      if (!sticker) return fail('这张表情包已被删除。')
      const decided = options['scope'] === 'public' || options['scope'] === 'local'
      const scope = decided ? (options['scope'] as Scope) : sticker.scope
      // 管理员定了使用范围，之后补写不再改它。
      const { unjudged: _unjudged, ...rest } = sticker
      const updated = await put({
        ...(decided ? rest : sticker),
        ...('meaning' in options ? { meaning: clip(options['meaning'], 200) } : {}),
        ...('caption' in options ? { caption: clip(options['caption'], 200) } : {}),
        ...('description' in options ? { description: clip(options['description'], 200) } : {}),
        ...('tags' in options ? { tags: words(options['tags']) } : {}),
        scope,
        updatedAt: Date.now(),
      })
      return { ok: true, sticker: summary(updated) } as unknown as ExtensionJsonValue
    }),
  )

  const setDeleted = (input: ExtensionJsonValue, deleted: boolean) =>
    serial(async () => {
      const sticker = (await stickers()).get(clip(record(input)['id'], 128))
      if (!sticker) return fail('这张表情包已被删除。')
      const { deletedAt: _deletedAt, ...rest } = sticker
      await put(deleted ? { ...sticker, deletedAt: Date.now() } : { ...rest, updatedAt: Date.now() })
      return { ok: true }
    })
  harness.handle('library.remove', (input) => setDeleted(input, true))
  harness.handle('library.restore', (input) => setDeleted(input, false))

  /** 读或改本机设置；选好标注模型或调高并行数后，排队的图立即开始处理。 */
  harness.handle('library.settings', async (input) => {
    const options = record(input)
    const next = await serial(async () => {
      const current = await readSettings()
      if (Object.keys(options).length === 0) return current
      const model = 'model' in options ? clip(options['model'], 200) : (current.model ?? '')
      const updated = parseSettings({
        paused: typeof options['paused'] === 'boolean' ? options['paused'] : current.paused,
        model,
        threshold: 'threshold' in options ? options['threshold'] : current.threshold,
        concurrency: 'concurrency' in options ? options['concurrency'] : current.concurrency,
      })
      await host.storage.set(SETTINGS_KEY, { ...updated })
      return updated
    })
    void pump()
    return next as unknown as ExtensionJsonValue
  })

  harness.handle('collect.status', async () => {
    const [items, status, settings] = await Promise.all([readQueue(), readStatus(), readSettings()])
    return {
      queued: items.length,
      working: [...working].filter((key) => key.startsWith('collect:')).length,
      waitingForModel: settings.model === undefined && items.length > 0,
      ...status,
    } as unknown as ExtensionJsonValue
  })

  harness.handle('import.models', async () =>
    (await host.models.list())
      .filter((model) => model.vision)
      .map(({ ref, name, providerName }) => ({ ref, name, providerName })),
  )

  harness.handle('import.start', async (input) => {
    const started = await serial(async () => {
      const options = record(input)
      const current = await readImport()
      if (current?.state === 'running') return fail('上一次导入还在进行，请等它完成或先取消。')
      const items = (Array.isArray(options['items']) ? options['items'] : [])
        .map((item) => ({ assetId: clip(record(item)['assetId'], 128), name: clip(record(item)['name'], 200) }))
        .filter((item) => item.assetId)
      const model = clip(options['model'], 200)
      const all = await stickers()
      // 新图、回收站里的图和还没写用途的图需要处理；其余已经在库里。
      const fresh = items.filter((item) => {
        const existing = all.get(item.assetId)
        return existing === undefined || existing.deletedAt !== undefined || (!existing.meaning && model !== '')
      })
      const job: ImportJob = {
        state: fresh.length === 0 ? 'done' : 'running',
        ...(model ? { model } : {}),
        queue: fresh,
        total: fresh.length,
        done: 0,
        skipped: items.length - fresh.length,
        failed: 0,
        errors: [],
      }
      await writeImport(job)
      return { ok: true, job: { ...job, queue: [] } }
    })
    void pump()
    return started as unknown as ExtensionJsonValue
  })

  harness.handle('import.status', async () => {
    const job = await readImport()
    return job === undefined
      ? null
      : ({ ...job, queue: [], remaining: job.queue.length } as unknown as ExtensionJsonValue)
  })

  harness.handle('import.cancel', () =>
    serial(async () => {
      const job = await readImport()
      if (job?.state === 'running') await writeImport({ ...job, state: 'cancelled', queue: [] })
      return { ok: true }
    }),
  )

  harness.handle('channel.get', async (_input, caller) => {
    const channelId = channelOf(caller)
    if (!channelId) return null
    const all = [...(await stickers()).values()]
    return {
      ...(await readChannel(channelId)),
      collected: all.filter((sticker) => sticker.deletedAt === undefined && sticker.sources.includes(channelId)).length,
    }
  })

  harness.handle('channel.set', async (input, caller) => {
    const channelId = channelOf(caller)
    if (!channelId) return fail('请在频道面板里修改。')
    const next = channelSettings({ ...(await readChannel(channelId)), ...record(input) })
    await host.storage.set(`${CHANNEL_PREFIX}${channelId}`, { ...next })
    return next as unknown as ExtensionJsonValue
  })

  // ---------- 智能体挂载 ----------
  return {
    inject: ['tools', 'nxt'],
    apply(ctx) {
      const nxt: NxtHostService | undefined = ctx.nxt
      if (!nxt) throw new Error('表情包需要宿主能力 nxt。')
      const config = record(ctx.config())
      const collect = config['collect'] === 'asked' || config['collect'] === 'off' ? config['collect'] : 'auto'
      const ownOnly = config['range'] === 'own'
      const previewImages = [0, 2, 4, 6].includes(Number(config['previewImages'])) ? Number(config['previewImages']) : 4

      const frequency: Frequency =
        typeof config['frequency'] === 'string' && config['frequency'] in FREQUENCY
          ? (config['frequency'] as Frequency)
          : 'smart'

      nxt.prompt.static('guide', GUIDE(collect, frequency))

      if (collect !== 'off') registerSave(nxt)
      registerSearch(nxt)
      registerUse(nxt)
      registerUpdate()
      registerRemove()

      function registerSave(agentNxt: NxtHostService) {
        type Args = { readonly assetId?: string; readonly note?: string }
        type Result = { readonly ok: true; readonly state: 'exists' | 'queued'; readonly waiting: boolean } | Failure
        harness.registerTool(
          ctx,
          harness.defineTool<Args, Result>({
            name: 'sticker_save',
            description:
              '把当前频道里的一张图交给表情包库收藏。assetId 是消息里图片的编号；note 可选，用几个字说明它适合什么时候发（最多 30 字）。用途、配文和能否带到别的群由表情包库判断。',
            parameters: {
              assetId: { type: 'string', required: true, description: '图片的编号，例如消息里的 [图片 ast_…]' },
              note: { type: 'string', description: '适合什么时候发，可不填' },
            },
            output: {
              schema: { type: 'json' },
              render: (_args, value) =>
                text(
                  !value.ok
                    ? value.message
                    : value.state === 'exists'
                      ? '库里已经有这张。'
                      : value.waiting
                        ? '已加入收藏队列，管理员选好标注模型后入库。'
                        : '已加入收藏队列。',
                ),
            },
            execute: async (args) => {
              const assetId = clip(args.assetId, 128)
              if (!assetId) return fail('请给出图片的编号（assetId）。')
              const call = await agentNxt.context.current()
              const channelId = call.channel.id
              if ((await readChannel(channelId)).collect === 'off') return fail('这个群设置了不收藏表情包。')
              let info
              try {
                info = await agentNxt.image.info(assetId)
              } catch (error) {
                return fail(`找不到这张图：${errorText(error)}`)
              }
              if (!PICTURE_TYPES.has(info.mediaType)) return fail('只收藏 PNG、JPEG、GIF 或 WebP 图片。')
              if (info.byteSize > MAX_BYTES) return fail('这张图超过 8 MB，不收藏。')
              const note = clip(args.note, 30)
              const result = await serial(async (): Promise<Result> => {
                const existing = (await stickers()).get(assetId)
                const now = Date.now()
                if (existing !== undefined) {
                  // 回收站里的图再被交来时恢复；收紧过的使用范围不变。
                  const { deletedAt: _deletedAt, ...rest } = existing
                  await put({ ...rest, sources: including(existing.sources, channelId, Infinity), updatedAt: now })
                  return { ok: true, state: 'exists', waiting: false }
                }
                const items = await readQueue()
                if (!items.some((entry) => entry.assetId === assetId) && items.length >= QUEUE_LIMIT) {
                  return fail('收藏队列已满，稍后再试。')
                }
                try {
                  await agentNxt.assets.keep(assetId)
                } catch (error) {
                  return fail(errorText(error))
                }
                const before = (await candidates()).get(assetId)
                const candidate: Candidate = {
                  id: assetId,
                  senders: before?.senders ?? [],
                  channels: including(before?.channels ?? [], channelId, MAX_CHANNELS),
                  hint: before?.hint ?? false,
                  firstAt: before?.firstAt ?? now,
                  lastAt: now,
                  state: 'queued',
                  collector: call.agent.id,
                }
                await putCandidate(candidate)
                await enqueue(
                  collectItem(candidate, true, { collectorName: call.agent.name, ...(note ? { note } : {}) }),
                )
                return { ok: true, state: 'queued', waiting: (await readSettings()).model === undefined }
              })
              void pump()
              return result
            },
          }),
        )
      }

      function registerSearch(agentNxt: NxtHostService) {
        type Item = {
          readonly id: string
          readonly meaning: string
          readonly caption: string
          readonly tags: readonly string[]
          readonly animated: boolean
        }
        type Result = { readonly ok: true; readonly items: readonly Item[] } | Failure
        harness.registerTool(
          ctx,
          harness.defineTool<{ readonly query?: string; readonly limit?: number }, Result>({
            name: 'sticker_search',
            description:
              '按想表达的意思找表情包，例如「被夸了有点得意」「加班到深夜很累」。limit 是候选数量，1–10，默认 6。前几个候选会附上图片。',
            parameters: {
              query: { type: 'string', required: true, description: '想表达的意思或场景' },
              limit: { type: 'integer', description: '候选数量，1–10，默认 6' },
            },
            output: {
              schema: { type: 'json' },
              render: (_args, value) => {
                if (!value.ok) return text(value.message)
                if (value.items.length === 0) return text('没有找到合适的表情包。可以换个说法再找，或者这次不发。')
                const lines = value.items.map(
                  (item, index) =>
                    `${index + 1}. ${item.id}：${item.meaning || '（还没有写用途）'}${item.caption ? `；图中文字「${item.caption}」` : ''}${item.animated ? '；动图' : ''}`,
                )
                return [
                  { type: 'text', text: lines.join('\n') },
                  ...value.items.slice(0, previewImages).map((item, index): ExtensionToolResultBlock => ({
                    type: 'image',
                    assetId: item.id,
                    label: `候选 ${index + 1}`,
                  })),
                  {
                    type: 'text',
                    text: '确认图的内容后再决定发哪张，都不合适就不发；要发的用 sticker_use 取得 assetId。描述和图对不上的用 sticker_update 改；图里有某个群的聊天、账号、个人信息的，用 sticker_update 把 scope 改成 local；不是表情包的用 sticker_remove。',
                  },
                ]
              },
            },
            execute: async (args) => {
              const query = clip(args.query, 100)
              if (!query) return fail('请写下想表达的意思（query）。')
              const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 6), 1), 10)
              const call = await agentNxt.context.current()
              const settings = await readChannel(call.channel.id)
              if (settings.use === 'off') return fail('这个群设置了不使用表情包。')
              const { paused } = await readSettings()
              const filter: NxtIndexCondition[][] = [
                settings.use === 'local' || paused
                  ? [{ field: 'sources', value: call.channel.id }]
                  : [
                      { field: 'scope', value: 'public' },
                      { field: 'sources', value: call.channel.id },
                    ],
              ]
              if (ownOnly) filter.push([{ field: 'collector', value: call.agent.id }])
              const result = await host.index.query(COLLECTION, query, { limit: limit * 2, filter })
              const all = await stickers()
              const recent = new Set(
                (await host.storage.get(`${RECENT_PREFIX}${call.channel.id}`)) as unknown as
                  readonly string[] | undefined,
              )
              const found = result.hits.flatMap(({ id }) => {
                const sticker = all.get(id)
                return sticker !== undefined &&
                  isAvailable(sticker, {
                    channelId: call.channel.id,
                    use: settings.use,
                    paused,
                    ...(ownOnly ? { collector: call.agent.id } : {}),
                  })
                  ? [sticker]
                  : []
              })
              // 这个群最近发过的往后放，避免反复发同一张。
              const ordered = [
                ...found.filter((sticker) => !recent.has(sticker.id)),
                ...found.filter((sticker) => recent.has(sticker.id)),
              ]
              return {
                ok: true,
                items: ordered.slice(0, limit).map((sticker) => ({
                  id: sticker.id,
                  meaning: sticker.meaning,
                  caption: sticker.caption,
                  tags: [...sticker.tags],
                  animated: sticker.frames > 1,
                })),
              }
            },
          }),
        )
      }

      function registerUse(agentNxt: NxtHostService) {
        type Result = { readonly ok: true; readonly assetId: string } | Failure
        harness.registerTool(
          ctx,
          harness.defineTool<{ readonly id?: string }, Result>({
            name: 'sticker_use',
            description:
              '准备发送 sticker_search 找到的一张表情包，返回 assetId；再用 send_channel_message 的 image 块发出去。',
            parameters: { id: { type: 'string', required: true, description: 'sticker_search 结果里的编号' } },
            output: {
              schema: { type: 'json' },
              render: (_args, value) =>
                text(
                  value.ok
                    ? `可以发送了：把 {"type":"image","assetId":"${value.assetId}"} 放进 send_channel_message 的 parts。`
                    : value.message,
                ),
            },
            execute: async (args) => {
              const id = clip(args.id, 128)
              const call = await agentNxt.context.current()
              const settings = await readChannel(call.channel.id)
              const { paused } = await readSettings()
              return serial(async () => {
                const sticker = (await stickers()).get(id)
                if (
                  sticker === undefined ||
                  !isAvailable(sticker, {
                    channelId: call.channel.id,
                    use: settings.use,
                    paused,
                    ...(ownOnly ? { collector: call.agent.id } : {}),
                  })
                ) {
                  return fail('这张表情包不能在这个群用，请用 sticker_search 重新找。')
                }
                let attached
                try {
                  attached = await agentNxt.assets.attach(id)
                } catch (error) {
                  return fail(errorText(error))
                }
                await put({
                  ...sticker,
                  sentCount: sticker.sentCount + 1,
                  lastSentAt: Date.now(),
                  sentTo: sticker.sentTo.includes(call.channel.id)
                    ? sticker.sentTo
                    : [...sticker.sentTo, call.channel.id],
                })
                const recentKey = `${RECENT_PREFIX}${call.channel.id}`
                const recent = ((await host.storage.get(recentKey)) as unknown as readonly string[] | undefined) ?? []
                await host.storage.set(
                  recentKey,
                  [id, ...recent.filter((entry) => entry !== id)].slice(0, RECENT_LIMIT),
                )
                // 刚发过表情包，下一次提示重新计数。
                const tip = tips.get(call.channel.id)
                if (tip !== undefined) tip.since = 0
                return { ok: true, assetId: attached.assetId }
              })
            },
          }),
        )
      }

      function registerUpdate() {
        type Args = {
          readonly id?: string
          readonly meaning?: string
          readonly caption?: string
          readonly description?: string
          readonly tags?: readonly string[]
          readonly scope?: string
        }
        harness.registerTool(
          ctx,
          harness.defineTool<Args, { readonly ok: true } | Failure>({
            name: 'sticker_update',
            description:
              '修正一张表情包：meaning、caption、description、tags 填了才改；scope 只能改成 local（只在出现过它的群里用），改成公共要由管理员在「表情包」页面操作。',
            parameters: {
              id: { type: 'string', required: true, description: '表情包编号' },
              meaning: { type: 'string', description: '新的用途说明' },
              caption: { type: 'string', description: '图里文字的原文' },
              description: { type: 'string', description: '一句话描述画面' },
              tags: { type: 'array', items: { type: 'string' }, description: '新的标签，会替换原来的' },
              scope: { type: 'string', enum: ['local'], description: '填 local 表示只在出现过它的群里用' },
            },
            output: {
              schema: { type: 'json' },
              render: (_args, value) => text(value.ok ? '已更新。' : value.message),
            },
            execute: (args) =>
              serial(async () => {
                if (args.scope !== undefined && args.scope !== 'local') {
                  return fail('只能把 scope 改成 local；改成公共要由管理员在「表情包」页面操作。')
                }
                const sticker = (await stickers()).get(clip(args.id, 128))
                if (sticker === undefined || sticker.deletedAt !== undefined) return fail('没有这张表情包。')
                const meaning = clip(args.meaning, 200)
                const { unjudged: _unjudged, ...judged } = sticker
                await put({
                  ...(args.scope === 'local' ? judged : sticker),
                  ...(meaning ? { meaning } : {}),
                  ...(args.caption !== undefined ? { caption: clip(args.caption, 200) } : {}),
                  ...(args.description !== undefined ? { description: clip(args.description, 200) } : {}),
                  ...(args.tags !== undefined ? { tags: words(args.tags) } : {}),
                  ...(args.scope === 'local' ? { scope: 'local' as const } : {}),
                  updatedAt: Date.now(),
                })
                return { ok: true }
              }),
          }),
        )
      }

      function registerRemove() {
        harness.registerTool(
          ctx,
          harness.defineTool<{ readonly id?: string }, { readonly ok: true } | Failure>({
            name: 'sticker_remove',
            description: '把不是表情包、或不该留在库里的图移进回收站；30 天内管理员可以在「表情包」页面恢复。',
            parameters: { id: { type: 'string', required: true, description: '表情包编号' } },
            output: {
              schema: { type: 'json' },
              render: (_args, value) => text(value.ok ? '已移进回收站。' : value.message),
            },
            execute: (args) =>
              serial(async () => {
                const sticker = (await stickers()).get(clip(args.id, 128))
                if (sticker === undefined || sticker.deletedAt !== undefined) return fail('没有这张表情包。')
                await put({ ...sticker, deletedAt: Date.now() })
                return { ok: true }
              }),
          }),
        )
      }
    },
  }
})
