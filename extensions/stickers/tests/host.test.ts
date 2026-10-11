import { afterEach, describe, expect, it, vi } from 'vitest'
import extension from '../src/host.js'
import { createTestHost } from '../../../tools/testing.js'

const ROOM_A = { id: 'chn_ROOMA', displayName: '甲群' }
const ROOM_B = { id: 'chn_ROOMB', displayName: '乙群' }
const panel = (channelId: string) =>
  ({ surface: 'panel', anchor: { kind: 'channel', id: channelId }, channelId, agentId: 'agt_TEST' }) as const

const setup = (options: Parameters<typeof createTestHost>[1] = {}) =>
  createTestHost(extension, {
    indexWeights: { stickers: { meaning: 2, caption: 1.5, description: 1, tags: 1 } },
    ...options,
  })

const save = (host: Awaited<ReturnType<typeof setup>>, assetId: string, extra: Record<string, unknown> = {}) =>
  host.call('sticker_save', {
    assetId,
    meaning: '表达委屈，适合被调侃或事情没办成的时候',
    caption: '呜呜',
    description: '粉发猫耳女孩哭',
    tags: ['委屈', '哭'],
    shareable: true,
    ...extra,
  } as never)

afterEach(() => {
  vi.useRealTimers()
})

describe('收藏与跨群使用', () => {
  it('在甲群收藏的通用表情包，乙群也能搜到、看到并发出去', async () => {
    const host = await setup()
    host.addPicture('ast_CRY', { channels: [ROOM_A.id] })
    host.useChannel(ROOM_A)
    const saved = await save(host, 'ast_CRY')
    expect(saved.value).toMatchObject({ ok: true, id: 'ast_CRY', scope: 'public' })
    expect(host.library.has('ast_CRY')).toBe(true)

    host.useChannel(ROOM_B)
    const found = await host.call('sticker_search', { query: '有点委屈' })
    expect(found.value).toMatchObject({ ok: true, items: [{ id: 'ast_CRY' }] })
    expect(found.blocks.filter((block) => block.type === 'image')).toEqual([
      { type: 'image', assetId: 'ast_CRY', label: '候选 1' },
    ])
    expect(found.text).toContain('sticker_use')

    const used = await host.call('sticker_use', { id: 'ast_CRY' })
    expect(used.value).toEqual({ ok: true, assetId: 'ast_CRY' })
    expect(used.text).toContain('{"type":"image","assetId":"ast_CRY"}')
  })

  it('看不到的图不能收藏，不是图片或太大的图也不收', async () => {
    const host = await setup()
    host.useChannel(ROOM_A)
    host.addPicture('ast_ELSEWHERE', { channels: [ROOM_B.id] })
    host.addPicture('ast_HUGE', { channels: [ROOM_A.id], info: { byteSize: 9 * 1024 * 1024 } })
    host.addPicture('ast_SVG', { channels: [ROOM_A.id], info: { mediaType: 'image/svg+xml' } })
    expect((await save(host, 'ast_ELSEWHERE')).text).toContain('找不到这张图')
    expect((await save(host, 'ast_HUGE')).text).toContain('超过 8 MB')
    expect((await save(host, 'ast_SVG')).text).toContain('只收藏 PNG')
    expect((await save(host, 'ast_ELSEWHERE', { meaning: '' })).text).toContain('meaning')
    expect(host.library.size).toBe(0)
  })

  it('判断为不能公共的图仅限来源频道使用', async () => {
    const host = await setup()
    host.addPicture('ast_CHAT', { channels: [ROOM_A.id] })
    host.useChannel(ROOM_A)
    expect((await save(host, 'ast_CHAT', { shareable: false })).value).toMatchObject({ scope: 'local' })
    expect((await host.call('sticker_search', { query: '委屈' })).value).toMatchObject({ items: [{ id: 'ast_CHAT' }] })
    host.useChannel(ROOM_B)
    expect((await host.call('sticker_search', { query: '委屈' })).value).toEqual({ ok: true, items: [] })
    expect((await host.call('sticker_use', { id: 'ast_CHAT' })).text).toContain('不能在这个群用')
  })

  it('同一张图在另一个群再收藏时合并，认为不能公共就收紧；外观相近的不同图分开保存', async () => {
    const host = await setup()
    host.addPicture('ast_ONE', { channels: [ROOM_A.id, ROOM_B.id], info: { dhash: '00ff00ff00ff00ff' } })
    host.addPicture('ast_SAME_TEMPLATE', { channels: [ROOM_B.id], info: { dhash: '00ff00ff00ff00fe' } })
    host.useChannel(ROOM_A)
    await save(host, 'ast_ONE')
    host.useChannel(ROOM_B)
    const merged = await save(host, 'ast_ONE', { tags: ['委屈', '猫猫'], shareable: false })
    expect(merged.value).toMatchObject({ ok: true, id: 'ast_ONE', merged: true, scope: 'local' })
    expect((await save(host, 'ast_SAME_TEMPLATE', { meaning: '表达生气' })).value).toMatchObject({ merged: false })
    const list = (await host.rpc('library.list', { view: 'all' })) as {
      total: number
      items: { id: string; sources: string[]; tags: string[] }[]
    }
    expect(list.total).toBe(2)
    expect(list.items.find((item) => item.id === 'ast_ONE')).toMatchObject({
      sources: [ROOM_A.id, ROOM_B.id],
      tags: ['委屈', '哭', '猫猫'],
    })
  })

  it('同一个群最近发过的往后排', async () => {
    const host = await setup()
    host.useChannel(ROOM_A)
    for (const id of ['ast_1', 'ast_2']) {
      host.addPicture(id, {
        channels: [ROOM_A.id],
        info: { dhash: id === 'ast_1' ? '0000000000000000' : 'ffffffffffffffff' },
      })
      await save(host, id)
    }
    const first = (await host.call('sticker_search', { query: '委屈' })).value as { items: { id: string }[] }
    await host.call('sticker_use', { id: first.items[0]!.id })
    const next = (await host.call('sticker_search', { query: '委屈' })).value as { items: { id: string }[] }
    expect(next.items.map(({ id }) => id)).toEqual([first.items[1]!.id, first.items[0]!.id])
  })
})

describe('群与智能体的设置', () => {
  it('频道面板可以关掉收藏、只用本群或不使用表情包', async () => {
    const host = await setup()
    host.addPicture('ast_A', { channels: [ROOM_A.id] })
    host.addPicture('ast_B', { channels: [ROOM_B.id], info: { dhash: 'ffffffffffffffff' } })
    host.useChannel(ROOM_A)
    await save(host, 'ast_A')

    expect(await host.rpc('channel.set', { collect: 'off' }, panel(ROOM_B.id))).toMatchObject({ collect: 'off' })
    host.useChannel(ROOM_B)
    expect((await save(host, 'ast_B')).text).toContain('不收藏表情包')

    await host.rpc('channel.set', { collect: 'local', use: 'local' }, panel(ROOM_B.id))
    expect((await save(host, 'ast_B')).value).toMatchObject({ scope: 'local' })
    const local = (await host.call('sticker_search', { query: '委屈' })).value as { items: { id: string }[] }
    expect(local.items.map(({ id }) => id)).toEqual(['ast_B'])

    await host.rpc('channel.set', { use: 'off' }, panel(ROOM_B.id))
    expect((await host.call('sticker_search', { query: '委屈' })).text).toContain('不使用表情包')
    expect(await host.rpc('channel.get', null, panel(ROOM_B.id))).toEqual({
      collect: 'local',
      use: 'off',
      collected: 1,
    })
    expect(await host.rpc('channel.get', null)).toBeNull()
  })

  it('暂停跨频道使用后只能用来源频道的图', async () => {
    const host = await setup()
    host.addPicture('ast_A', { channels: [ROOM_A.id] })
    host.useChannel(ROOM_A)
    await save(host, 'ast_A')
    expect(await host.rpc('library.settings', { paused: true })).toEqual({ paused: true })
    host.useChannel(ROOM_B)
    expect((await host.call('sticker_search', { query: '委屈' })).value).toEqual({ ok: true, items: [] })
    host.useChannel(ROOM_A)
    expect((await host.call('sticker_search', { query: '委屈' })).value).toMatchObject({ items: [{ id: 'ast_A' }] })
  })

  it('可以只用自己收藏的、不附图，或者完全不收藏', async () => {
    const host = await setup({ config: { range: 'own', previewImages: 0, collect: 'off' } })
    expect(host.tools.has('sticker_save')).toBe(false)
    host.addToLibrary('ast_IMPORTED')
    host.useChannel(ROOM_A)
    await host.rpc('import.start', { items: [{ assetId: 'ast_IMPORTED', name: '委屈巴巴.png' }] })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    // 导入的图不属于这个智能体，range=own 时找不到。
    expect((await host.call('sticker_search', { query: '委屈' })).value).toEqual({ ok: true, items: [] })
    expect(host.prompts.static.get('guide')).not.toContain('sticker_save')
  })

  it('附图数量跟随配置，说明里写清收藏的判断', async () => {
    const host = await setup({ config: { previewImages: 2, collect: 'asked' } })
    host.useChannel(ROOM_A)
    for (const [index, id] of ['ast_1', 'ast_2', 'ast_3'].entries()) {
      host.addPicture(id, {
        channels: [ROOM_A.id],
        info: { dhash: ['0000000000000000', 'ffffffffffffffff', '00000000ffffffff'][index]! },
      })
      await save(host, id)
    }
    const found = await host.call('sticker_search', { query: '委屈', limit: 3 })
    expect(found.blocks.filter((block) => block.type === 'image')).toHaveLength(2)
    expect(host.prompts.static.get('guide')).toContain('只在有人请你收藏')
    expect(host.prompts.static.get('guide')).toContain('shareable')
  })

  it('使用频率写进说明，默认跟着聊天气氛', async () => {
    const smart = await setup()
    expect(smart.prompts.static.get('guide')).toContain('跟着聊天气氛')
    for (const [frequency, text] of [
      ['often', '每两三次回复'],
      ['moderate', '每五次回复'],
      ['sometimes', '每十次回复'],
      ['rare', '很少用表情包'],
    ] as const) {
      const host = await setup({ config: { frequency } })
      const guide = host.prompts.static.get('guide') ?? ''
      expect(guide).toContain(text)
      // 不超过 extension.json 中 context 声明的 1600 字。
      expect(guide.length).toBeLessThanOrEqual(1600)
    }
  })
})

describe('整理与回收站', () => {
  it('智能体只能收紧使用范围，页面可以放开；删除进回收站并能恢复', async () => {
    const host = await setup()
    host.addPicture('ast_A', { channels: [ROOM_A.id] })
    host.useChannel(ROOM_A)
    await save(host, 'ast_A')
    expect((await host.call('sticker_update', { id: 'ast_A', scope: 'public' } as never)).text).toContain(
      '只能把 scope 改成 local',
    )
    expect((await host.call('sticker_update', { id: 'ast_A', meaning: '表达撒娇', scope: 'local' })).value).toEqual({
      ok: true,
    })
    expect(await host.rpc('library.overview')).toMatchObject({ total: 1, public: 0, local: 1, trash: 0 })
    expect(await host.rpc('library.update', { id: 'ast_A', scope: 'public' })).toMatchObject({
      ok: true,
      sticker: { scope: 'public', meaning: '表达撒娇' },
    })

    expect((await host.call('sticker_remove', { id: 'ast_A' })).text).toContain('回收站')
    expect((await host.call('sticker_search', { query: '撒娇' })).value).toEqual({ ok: true, items: [] })
    expect(await host.rpc('library.list', { view: 'trash' })).toMatchObject({ total: 1 })
    expect(await host.rpc('library.restore', { id: 'ast_A' })).toEqual({ ok: true })
    expect((await host.call('sticker_search', { query: '撒娇' })).value).toMatchObject({ items: [{ id: 'ast_A' }] })
  })

  it('回收站里超过 30 天的图会彻底删除并移出资源库', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
    const host = await setup()
    host.addPicture('ast_A', { channels: [ROOM_A.id] })
    host.useChannel(ROOM_A)
    await save(host, 'ast_A')
    await host.rpc('library.remove', { id: 'ast_A' })
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))
    expect(await host.rpc('library.overview')).toMatchObject({ trash: 1 })
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
    expect(await host.rpc('library.overview')).toMatchObject({ total: 0, trash: 0 })
    expect(host.library.has('ast_A')).toBe(false)
  })

  it('页面接口在缺参数时不会出错', async () => {
    const host = await setup()
    for (const method of ['library.overview', 'library.list', 'library.settings', 'import.status', 'import.cancel']) {
      await expect(host.rpc(method)).resolves.toBeDefined()
    }
    expect(await host.rpc('library.update')).toMatchObject({ ok: false })
    expect(await host.rpc('library.remove')).toMatchObject({ ok: false })
    expect(await host.rpc('channel.set', { collect: 'off' })).toMatchObject({ ok: false })
  })
})

describe('批量导入', () => {
  const vision = {
    ref: 'fixture:vision',
    provider: 'fixture',
    providerName: '示例',
    model: 'vision',
    name: '示例视觉模型',
    vision: true,
  }
  const text = { ...vision, ref: 'fixture:text', model: 'text', name: '纯文本模型', vision: false }

  it('用所选的视觉模型标注，不宜公共的图仅限来源频道', async () => {
    const replies: Record<string, string> = {
      ast_OK:
        '```json\n{"meaning":"表达开心，适合庆祝时","caption":"好耶","description":"小猫举手","tags":["开心","猫"],"sticker":true,"shareable":true}\n```',
      ast_SHOT:
        '{"meaning":"聊天截图","caption":"","description":"群聊截图","tags":["截图"],"sticker":false,"shareable":false}',
    }
    let flaky = 0
    const host = await setup({
      models: [vision, text],
      modelReply: (request) => {
        const image = request.messages[0]!.content.find((part) => part.type === 'image')
        const assetId = image?.type === 'image' ? image.assetId : ''
        // 第一次先写一段说明、没有 JSON，重试时才按格式回答。
        if (assetId === 'ast_FLAKY') {
          flaky += 1
          return flaky === 1
            ? '我看到一只猫。'
            : '<think>先看图 {草稿}</think>{"sticker":true,"shareable":true,"meaning":"表达疑惑","caption":"","description":"猫歪头","tags":["疑惑"]}'
        }
        return replies[assetId] ?? 'not json'
      },
    })
    expect(await host.rpc('import.models')).toEqual([
      { ref: 'fixture:vision', name: '示例视觉模型', providerName: '示例' },
    ])
    host.addToLibrary('ast_OK', { info: { dhash: '0000000000000000' } })
    host.addToLibrary('ast_SHOT', { info: { dhash: 'ffffffffffffffff' } })
    host.addToLibrary('ast_BAD', { info: { dhash: '00000000ffffffff' } })
    host.addToLibrary('ast_FLAKY', { info: { dhash: '0f0f0f0f0f0f0f0f' } })
    expect(
      await host.rpc('import.start', {
        model: 'fixture:vision',
        items: [
          { assetId: 'ast_OK', name: 'a.png' },
          { assetId: 'ast_SHOT', name: 'b.png' },
          { assetId: 'ast_BAD', name: '猫猫震惊.png' },
          { assetId: 'ast_FLAKY', name: 'c.png' },
        ],
      }),
    ).toMatchObject({ ok: true, job: { total: 4, state: 'running' } })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    expect(await host.rpc('import.status')).toMatchObject({
      total: 4,
      done: 3,
      failed: 1,
      errors: [expect.stringContaining('猫猫震惊.png：模型没有按格式回答：「not json」')],
    })
    expect(flaky).toBe(2)

    const all = (await host.rpc('library.list', { view: 'all' })) as {
      items: { id: string; meaning: string; caption: string; scope: string; origin: string; description: string }[]
    }
    const byId = Object.fromEntries(all.items.map((item) => [item.id, item]))
    expect(byId['ast_OK']).toMatchObject({
      meaning: '表达开心，适合庆祝时',
      caption: '好耶',
      scope: 'public',
      origin: 'import',
    })
    expect(byId['ast_SHOT']).toMatchObject({ scope: 'local' })
    // 选了模型却没判断成的不能直接设为公共。
    expect(byId['ast_BAD']).toMatchObject({ meaning: '', description: '猫猫震惊', scope: 'local' })
    expect(byId['ast_FLAKY']).toMatchObject({ meaning: '表达疑惑', scope: 'public' })

    // 再次导入：已标注的跳过，未标注的重新标注。
    replies['ast_BAD'] =
      '{"meaning":"表达震惊","caption":"","description":"猫","tags":["震惊"],"sticker":true,"shareable":true}'
    expect(
      await host.rpc('import.start', {
        model: 'fixture:vision',
        items: [
          { assetId: 'ast_OK', name: 'a.png' },
          { assetId: 'ast_BAD', name: '猫猫震惊.png' },
        ],
      }),
    ).toMatchObject({ job: { total: 1, skipped: 1 } })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    // 重新标注时模型判断可以公共，才放开。
    host.useChannel(ROOM_A)
    expect((await host.call('sticker_search', { query: '震惊' })).value).toMatchObject({ items: [{ id: 'ast_BAD' }] })
  })

  it('重新标注时模型判断不宜公共的图改为仅限来源频道', async () => {
    const host = await setup({
      models: [vision],
      modelReply: () =>
        '{"sticker":false,"shareable":false,"meaning":"聊天截图","caption":"","description":"截图","tags":["截图"]}',
    })
    host.addToLibrary('ast_PLAIN', { info: { dhash: '1111111111111111' } })
    await host.rpc('import.start', { items: [{ assetId: 'ast_PLAIN', name: 'x.png' }] })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    const before = (await host.rpc('library.list', { view: 'all' })) as { items: { id: string; scope: string }[] }
    expect(before.items).toMatchObject([{ id: 'ast_PLAIN', scope: 'public' }])

    await host.rpc('import.start', { model: 'fixture:vision', items: [{ assetId: 'ast_PLAIN', name: 'x.png' }] })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    const after = (await host.rpc('library.list', { view: 'all' })) as { items: { id: string; scope: string }[] }
    expect(after.items).toMatchObject([{ id: 'ast_PLAIN', scope: 'local' }])
  })

  it('检索不可用时页面按文字列出匹配的表情包', async () => {
    let failing = false
    const host = await setup({ indexQueryError: () => (failing ? '检索暂时不可用' : undefined) })
    host.addToLibrary('ast_HAPPY', { info: { dhash: '0000000000000000' } })
    await host.rpc('import.start', { items: [{ assetId: 'ast_HAPPY', name: '开心_转圈.gif' }] })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    failing = true
    expect(await host.rpc('library.list', { query: '开心' })).toMatchObject({ total: 1, items: [{ id: 'ast_HAPPY' }] })
  })

  it('不选模型时用有意义的文件名作描述，导入可以取消', async () => {
    const host = await setup()
    host.addToLibrary('ast_NAMED', { info: { dhash: '0000000000000000' } })
    await host.rpc('import.start', { items: [{ assetId: 'ast_NAMED', name: 'set/开心_转圈.gif' }] })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    expect(await host.rpc('library.list', { query: '开心' })).toMatchObject({
      items: [{ id: 'ast_NAMED', description: '开心 转圈' }],
    })
    expect(await host.rpc('import.cancel')).toEqual({ ok: true })
  })
})
