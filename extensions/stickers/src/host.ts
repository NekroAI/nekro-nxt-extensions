import {
  defineHostExtension,
  type ExtensionJsonValue,
  type ExtensionRpcCaller,
  type ExtensionToolResultBlock,
  type NxtHostService,
  type NxtIndexCondition,
} from '@nekro-nxt/extension-sdk'

/**
 * 表情包：智能体在群聊里收藏表情包，聊天时按意思挑一张发出去；表情包默认在群之间流通，群里特有的内容只留在原来的群。
 *
 * 示范要点：
 * - 两道关：收藏时智能体用视觉判断能否流通；搜索结果附上候选图，智能体确认后再发，并顺手修正、收紧或清理；
 * - 图片放在扩展资源库（`assets.keep` / `attach`），搜索用宿主的检索索引（`index`），附图用工具结果的图片块；
 * - 本机实例持有全部记录的内存副本，工具与页面接口都经同一个队列读写，避免并发写丢失；
 * - 批量导入在本机实例里排队，用页面选择的模型（本机层 `models`）补写用途与配文，进度存进存储，重启后接着做。
 */

const COLLECTION = 'stickers'
const RECORD_PREFIX = 's/'
const CHANNEL_PREFIX = 'channel/'
const RECENT_PREFIX = 'recent/'
const SETTINGS_KEY = 'settings'
const IMPORT_KEY = 'import'
const TRASH_DAYS = 30
const DAY = 24 * 60 * 60 * 1000
const MAX_BYTES = 8 * 1024 * 1024
const PICTURE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const RECENT_LIMIT = 20
const MAX_TAGS = 8
const IMPORT_CONCURRENCY = 3

type Scope = 'public' | 'local'

interface Sticker {
  /** 即资源库里的 assetId。 */
  readonly id: string
  readonly meaning: string
  readonly caption: string
  readonly description: string
  readonly tags: readonly string[]
  readonly scope: Scope
  /** 出现过它的频道；本群的图只在这些频道使用。 */
  readonly sources: readonly string[]
  /** 发到过的频道，用来列出「最近流入其他群」。 */
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
}

interface ChannelSettings {
  /** 在这个频道收藏的图：按智能体判断能否流通、一律只在本群用、不收藏。 */
  readonly collect: 'auto' | 'local' | 'off'
  /** 在这个频道使用：库里可用的、只用本群的、不使用。 */
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

const DEFAULT_CHANNEL: ChannelSettings = { collect: 'auto', use: 'all' }

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim().slice(0, max) : ''
const words = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、\s]+/u) : []
  return [...new Set(list.map((entry) => clip(entry, 16)).filter(Boolean))].slice(0, MAX_TAGS)
}
const text = (value: string): ExtensionToolResultBlock[] => [{ type: 'text', text: value }]

const channelSettings = (value: unknown): ChannelSettings => {
  const saved = record(value)
  return {
    collect: saved['collect'] === 'local' || saved['collect'] === 'off' ? saved['collect'] : 'auto',
    use: saved['use'] === 'local' || saved['use'] === 'off' ? saved['use'] : 'all',
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

const IMPORT_PROMPT = [
  '这是一张准备收进表情包库的图片。只输出一个 JSON 对象，不要输出别的内容，字段按下面的顺序：',
  '{"sticker":表情包或反应图为 true，截图、照片、聊天记录、长图为 false,',
  '"shareable":图里有聊天记录、群名、昵称、账号、真实照片或个人信息时为 false，否则为 true,',
  '"meaning":"这张图在聊天里表达什么、适合在什么情况下发，一到两句，写用途不写外观",',
  '"caption":"图里文字的原文，最多 50 字，没有就是空字符串","description":"一句话描述画面",',
  '"tags":["2 到 5 个短标签"]}',
].join('')

const parseLabel = (reply: string) => {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有按格式回答')
  const parsed = record(JSON.parse(reply.slice(start, end + 1)))
  return {
    meaning: clip(parsed['meaning'], 200),
    caption: clip(parsed['caption'], 200),
    description: clip(parsed['description'], 200),
    tags: words(parsed['tags']),
    // 没有明确判断为可流通的，一律先留在库里；管理员可以在页面上改。
    shareable: parsed['sticker'] === true && parsed['shareable'] === true,
  }
}

/** 文件名本身有意义时（比如「猫猫哭泣.gif」）拿来当描述；随机串、编号不用。 */
const nameDescription = (name: string): string => {
  const stem = (name.split('/').at(-1) ?? name).replace(/\.[a-z0-9]+$/iu, '')
  return /[\p{Script=Han}]/u.test(stem) ? clip(stem.replaceAll(/[_-]+/gu, ' '), 60) : ''
}

const GUIDE = (collect: 'auto' | 'asked' | 'off'): string =>
  [
    '你可以给群里发表情包。库里的表情包可能来自你待过的各个群。',
    '发表情包：想用一张图表达情绪或回应时，先用 sticker_search 按想表达的意思找，比如「被夸了有点得意」；从候选里挑一张，用 sticker_use 取得 assetId，再用 send_channel_message 的 image 块发出去。都不合适就不发，也没必要每句话都配图。',
    collect === 'off'
      ? ''
      : [
          collect === 'asked'
            ? '收藏：只在有人请你收藏某张图时，用 sticker_save 收藏。'
            : '收藏：群里有人发了以后用得上的表情包或反应图，用 sticker_save 收藏。',
          '只收别人发的、你确认过内容的图；截图、照片、聊天记录、长图不收。',
          'meaning 写这张图表达什么、适合在什么情况下发，比如「表达委屈，适合被调侃或事情没办成时」，不要写成外观描述；caption 原样抄下图里的文字，没有就留空。',
          'shareable：通用的表情包填 true；图里有某个群的聊天内容、群名、昵称、账号、真实照片或个人信息，或者只有这个群才懂的梗，填 false，它就只在出现过它的群里用。',
        ].join(''),
    '整理：搜索结果里描述不对的，用 sticker_update 改；发现不该带到别的群的，用 sticker_update 把 scope 改成 local；根本不是表情包的，用 sticker_remove。有人说别再发某张，或别把它带到别的群，也照做。',
    '表情包的编号只在工具里用，不要在聊天里说出来。',
  ]
    .filter(Boolean)
    .join('\n')

export default defineHostExtension(async ({ harness, nxt: host }) => {
  // 所有读改写排进同一个队列：工具、页面接口与导入任务可能同时修改同一条记录。
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => undefined).then(action)
    queue = next
    return next
  }

  // 全部记录的内存副本，首次使用时从存储读入。
  let loaded: Promise<Map<string, Sticker>> | undefined
  const stickers = (): Promise<Map<string, Sticker>> =>
    (loaded ??= (async () => {
      const all = new Map<string, Sticker>()
      let after: string | undefined
      do {
        const page = await host.storage.list({ prefix: RECORD_PREFIX, limit: 200, ...(after ? { after } : {}) })
        for (const entry of page.entries) {
          const value = record(entry.value)
          if (typeof value['id'] === 'string') all.set(value['id'], value as unknown as Sticker)
        }
        after = page.next
      } while (after)
      return all
    })())

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

  // 只合并内容完全相同的图（同一个资源）。外观相近的图可能是同一模板配了不同的字，合并会丢掉其中一张。
  const sameSticker = (all: Map<string, Sticker>, id: string): Sticker | undefined => all.get(id)

  const readSettings = async () => ({ paused: record(await host.storage.get(SETTINGS_KEY))['paused'] === true })
  const readChannel = async (channelId: string) =>
    channelSettings(await host.storage.get(`${CHANNEL_PREFIX}${channelId}`))

  const tagHints = (all: Map<string, Sticker>, given: readonly string[]): string[] => {
    const counts = new Map<string, number>()
    for (const sticker of all.values()) {
      if (sticker.deletedAt !== undefined) continue
      for (const tag of sticker.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    const characters = new Set(given.join(''))
    return [...counts.entries()]
      .filter(([tag]) => !given.includes(tag) && [...tag].some((character) => characters.has(character)))
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([tag]) => tag)
  }

  // ---------- 批量导入：在本机实例里排队，用所选模型补写用途与配文 ----------
  let importRunning = false
  const readImport = async (): Promise<ImportJob | undefined> => {
    const saved = record(await host.storage.get(IMPORT_KEY))
    return typeof saved['state'] === 'string' ? (saved as unknown as ImportJob) : undefined
  }
  const writeImport = (job: ImportJob) => host.storage.set(IMPORT_KEY, job as unknown as ExtensionJsonValue)

  /** 导入或补写一张：用所选模型写用途与配文；模型失败时照样收下，用途留空，记为失败。 */
  const importOne = async (item: { readonly assetId: string; readonly name: string }, model: string | undefined) => {
    const info = await host.image.info(item.assetId)
    const fallback: ReturnType<typeof parseLabel> = {
      meaning: '',
      caption: '',
      description: nameDescription(item.name),
      tags: [],
      shareable: true,
    }
    let label = fallback
    let labelError: unknown
    if (model) {
      try {
        const reply = await host.models.complete({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: IMPORT_PROMPT },
                { type: 'image', assetId: item.assetId },
              ],
            },
          ],
          maxOutputTokens: 1024,
        })
        label = parseLabel(reply.text)
      } catch (error) {
        labelError = error
      }
    }
    const outcome = await serial(async () => {
      const all = await stickers()
      const existing = sameSticker(all, item.assetId)
      const now = Date.now()
      if (existing !== undefined && existing.deletedAt === undefined) {
        // 已在库里：只给还没写用途的补写文字，流通状态保持不变。
        if (existing.meaning || !label.meaning) return 'skipped' as const
        await put({
          ...existing,
          meaning: label.meaning,
          caption: existing.caption || label.caption,
          description: existing.description || label.description,
          tags: [...new Set([...existing.tags, ...label.tags])].slice(0, MAX_TAGS),
          updatedAt: now,
        })
        return 'added' as const
      }
      await put({
        id: item.assetId,
        meaning: label.meaning,
        caption: label.caption,
        description: label.description,
        tags: label.tags,
        // 导入的图没有来源群：判断为不宜流通的只留在库里，等管理员在页面上决定。
        scope: label.shareable ? 'public' : 'local',
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
      })
      return 'added' as const
    })
    if (labelError !== undefined) throw labelError
    return outcome
  }

  const runImport = async () => {
    if (importRunning) return
    importRunning = true
    try {
      for (;;) {
        const job = await readImport()
        if (job?.state !== 'running' || job.queue.length === 0) {
          if (job?.state === 'running') await writeImport({ ...job, state: 'done' })
          return
        }
        const batch = job.queue.slice(0, IMPORT_CONCURRENCY)
        const outcomes = await Promise.allSettled(batch.map((item) => importOne(item, job.model)))
        const latest = await readImport()
        if (latest?.state !== 'running') return
        const errors = outcomes.flatMap((outcome, index) =>
          outcome.status === 'rejected'
            ? [
                `${batch[index]!.name}：${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
              ]
            : [],
        )
        await writeImport({
          ...latest,
          queue: latest.queue.slice(batch.length),
          done: latest.done + outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
          skipped:
            latest.skipped +
            outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value === 'skipped').length,
          failed: latest.failed + errors.length,
          errors: [...latest.errors, ...errors].slice(-20),
        })
      }
    } finally {
      importRunning = false
    }
  }
  // 上次没做完的导入在本机实例启动后接着做。
  void readImport()
    .then((job) => (job?.state === 'running' ? runImport() : undefined))
    .catch(() => undefined)

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
    } else if (query && view !== 'trash') {
      const ranked = (await host.index.query(COLLECTION, query, { limit: 50 })).hits.map(({ id }) => id)
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
    return {
      total: items.length,
      items: items.slice(offset, offset + limit).map(summary),
    } as unknown as ExtensionJsonValue
  })

  harness.handle('library.update', (input) =>
    serial(async () => {
      const options = record(input)
      const sticker = (await stickers()).get(clip(options['id'], 128))
      if (!sticker) return fail('这张表情包已经不在库里了。')
      const scope = options['scope'] === 'public' || options['scope'] === 'local' ? options['scope'] : sticker.scope
      const updated = await put({
        ...sticker,
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
      if (!sticker) return fail('这张表情包已经不在库里了。')
      const { deletedAt: _deletedAt, ...rest } = sticker
      await put(deleted ? { ...sticker, deletedAt: Date.now() } : { ...rest, updatedAt: Date.now() })
      return { ok: true }
    })
  harness.handle('library.remove', (input) => setDeleted(input, true))
  harness.handle('library.restore', (input) => setDeleted(input, false))

  harness.handle('library.settings', async (input) => {
    const options = record(input)
    if (typeof options['paused'] === 'boolean') await host.storage.set(SETTINGS_KEY, { paused: options['paused'] })
    return readSettings()
  })

  harness.handle('import.models', async () =>
    (await host.models.list())
      .filter((model) => model.vision)
      .map(({ ref, name, providerName }) => ({ ref, name, providerName })),
  )

  harness.handle('import.start', (input) =>
    serial(async () => {
      const options = record(input)
      const current = await readImport()
      if (current?.state === 'running') return fail('上一次导入还没做完，等它结束或先取消。')
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
        state: 'running',
        ...(model ? { model } : {}),
        queue: fresh,
        total: fresh.length,
        done: 0,
        skipped: items.length - fresh.length,
        failed: 0,
        errors: [],
      }
      await writeImport(job)
      void runImport()
      return { ok: true, job: { ...job, queue: [] } } as unknown as ExtensionJsonValue
    }),
  )

  harness.handle('import.status', async () => {
    const job = await readImport()
    return job === undefined
      ? null
      : ({ ...job, queue: [], remaining: job.queue.length } as unknown as ExtensionJsonValue)
  })

  harness.handle('import.cancel', async () => {
    const job = await readImport()
    if (job?.state === 'running') await writeImport({ ...job, state: 'cancelled', queue: [] })
    return { ok: true }
  })

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

      nxt.prompt.static('guide', GUIDE(collect))

      if (collect !== 'off') registerSave(nxt)
      registerSearch(nxt)
      registerUse(nxt)
      registerUpdate()
      registerRemove()

      function registerSave(agentNxt: NxtHostService) {
        type Args = {
          readonly assetId?: string
          readonly meaning?: string
          readonly caption?: string
          readonly description?: string
          readonly tags?: readonly string[]
          readonly shareable?: boolean
        }
        type Result =
          | {
              readonly ok: true
              readonly id: string
              readonly merged: boolean
              readonly scope: Scope
              readonly tagHints: readonly string[]
            }
          | Failure
        harness.registerTool(
          ctx,
          harness.defineTool<Args, Result>({
            name: 'sticker_save',
            description:
              '收藏当前频道里别人发的一张表情包。assetId 是消息里图片的编号；meaning 写这张图表达什么、适合什么时候发（必填，最多 200 字）；caption 是图里文字的原文；description 一句话描述画面；tags 最多 8 个短标签；shareable 表示能否带到别的群（必填）。同一张图再收藏会合并。',
            parameters: {
              assetId: { type: 'string', required: true, description: '图片的编号，例如消息里的 [图片 ast_…]' },
              meaning: { type: 'string', required: true, description: '表达什么、适合在什么情况下发' },
              caption: { type: 'string', description: '图里文字的原文，没有就不填' },
              description: { type: 'string', description: '一句话描述画面' },
              tags: { type: 'array', items: { type: 'string' }, description: '短标签，例如 ["委屈", "猫"]' },
              shareable: { type: 'boolean', required: true, description: '能否带到别的群' },
            },
            output: {
              schema: { type: 'json' },
              render: (_args, value) =>
                text(
                  value.ok
                    ? [
                        value.merged ? '库里已经有这张，已合并。' : '已收藏。',
                        value.scope === 'local' ? '它只在出现过它的群里用。' : '',
                        value.tagHints.length > 0 ? `库里相近的标签：${value.tagHints.join('、')}。` : '',
                      ].join('')
                    : value.message,
                ),
            },
            execute: async (args) => {
              const assetId = clip(args.assetId, 128)
              const meaning = clip(args.meaning, 200)
              if (!assetId) return fail('请给出图片的编号（assetId）。')
              if (!meaning) return fail('请写下这张图表达什么、适合什么时候发（meaning）。')
              if (typeof args.shareable !== 'boolean') return fail('请判断这张图能否带到别的群（shareable）。')
              const call = await agentNxt.context.current()
              const settings = await readChannel(call.channel.id)
              if (settings.collect === 'off') return fail('这个群设置了不收藏表情包。')
              let info
              try {
                info = await agentNxt.image.info(assetId)
              } catch (error) {
                return fail(`找不到这张图：${error instanceof Error ? error.message : String(error)}`)
              }
              if (!PICTURE_TYPES.has(info.mediaType)) return fail('只收藏 PNG、JPEG、GIF 或 WebP 图片。')
              if (info.byteSize > MAX_BYTES) return fail('这张图超过 8 MB，不收藏。')
              const shareable = args.shareable && settings.collect !== 'local'
              const tags = words(args.tags)
              return serial(async () => {
                const all = await stickers()
                const existing = sameSticker(all, assetId)
                const now = Date.now()
                if (existing !== undefined) {
                  const revived = existing.deletedAt !== undefined
                  const { deletedAt: _deletedAt, ...rest } = existing
                  const merged = await put({
                    ...rest,
                    ...(revived || !existing.meaning ? { meaning } : {}),
                    caption: existing.caption || clip(args.caption, 200),
                    description: existing.description || clip(args.description, 200),
                    tags: [...new Set([...existing.tags, ...tags])].slice(0, MAX_TAGS),
                    // 收紧随手可做：认为不能流通就改成本群；放开只能在页面上做。
                    scope: args.shareable === false ? 'local' : existing.scope,
                    sources: existing.sources.includes(call.channel.id)
                      ? existing.sources
                      : [...existing.sources, call.channel.id],
                    updatedAt: now,
                  })
                  return {
                    ok: true,
                    id: merged.id,
                    merged: !revived,
                    scope: merged.scope,
                    tagHints: tagHints(all, tags),
                  }
                }
                try {
                  await agentNxt.assets.keep(assetId)
                } catch (error) {
                  return fail(error instanceof Error ? error.message : String(error))
                }
                const saved = await put({
                  id: assetId,
                  meaning,
                  caption: clip(args.caption, 200),
                  description: clip(args.description, 200),
                  tags,
                  scope: shareable ? 'public' : 'local',
                  sources: [call.channel.id],
                  sentTo: [],
                  collector: call.agent.id,
                  collectorName: call.agent.name,
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
                return { ok: true, id: saved.id, merged: false, scope: saved.scope, tagHints: tagHints(all, tags) }
              })
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
                  return fail(error instanceof Error ? error.message : String(error))
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
              '修正一张表情包：meaning、caption、description、tags 填了才改；scope 只能改成 local（只在出现过它的群里用），改成流通要由管理员在「表情包」页面操作。',
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
                  return fail('只能把 scope 改成 local；改成流通要由管理员在「表情包」页面操作。')
                }
                const sticker = (await stickers()).get(clip(args.id, 128))
                if (sticker === undefined || sticker.deletedAt !== undefined) return fail('没有这张表情包。')
                const meaning = clip(args.meaning, 200)
                await put({
                  ...sticker,
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
