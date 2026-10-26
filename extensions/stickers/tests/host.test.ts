import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { NxtModelRequest } from '@nekro-nxt/extension-sdk'
import extension from '../src/host.js'
import { createTestHost } from '../../../tools/testing.js'

const ROOM_A = { id: 'chn_ROOMA', displayName: '甲群' }
const ROOM_B = { id: 'chn_ROOMB', displayName: '乙群' }
const panel = (channelId: string) =>
  ({ surface: 'panel', anchor: { kind: 'channel', id: channelId }, channelId, agentId: 'agt_TEST' }) as const

const vision = {
  ref: 'fixture:vision',
  provider: 'fixture',
  providerName: '示例',
  model: 'vision',
  name: '示例视觉模型',
  vision: true,
}
const text = { ...vision, ref: 'fixture:text', model: 'text', name: '纯文本模型', vision: false }

/** 打标模型的回答：默认是一张可以公共的「委屈」表情包。 */
const reply = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    sticker: true,
    shareable: true,
    meaning: '表达委屈，适合被调侃或事情没办成的时候',
    caption: '呜呜',
    description: '粉发猫耳女孩哭',
    tags: ['委屈', '哭'],
    ...overrides,
  })
const imageOf = (request: NxtModelRequest): string => {
  const image = request.messages[0]!.content.find((part) => part.type === 'image')
  return image?.type === 'image' ? image.assetId : ''
}
const promptOf = (request: NxtModelRequest): string => {
  const part = request.messages[0]!.content.find((entry) => entry.type === 'text')
  return part?.type === 'text' ? part.text : ''
}

type Host = Awaited<ReturnType<typeof createTestHost>>

/** 选好了打标模型的测试宿主；`replies` 按图片编号给出模型的回答。 */
const setup = async (
  options: Parameters<typeof createTestHost>[1] = {},
  replies: Record<string, string> = {},
): Promise<Host> => {
  const host = await createTestHost(extension, {
    indexWeights: { stickers: { meaning: 2, caption: 1.5, description: 1, tags: 1 } },
    models: [vision, text],
    modelReply: (request) => replies[imageOf(request)] ?? reply(),
    ...options,
  })
  await host.rpc('library.settings', { model: 'fixture:vision' })
  return host
}

/** 等收集队列处理完。 */
const settled = (host: Host) =>
  vi.waitFor(async () => expect(await host.rpc('collect.status')).toMatchObject({ queued: 0, working: 0 }))

/** 智能体把一张图交来收藏，并等它入库。 */
const save = async (host: Host, assetId: string, extra: Record<string, unknown> = {}) => {
  const result = await host.call('sticker_save', { assetId, ...extra } as never)
  await settled(host)
  return result
}

/** 群里有人发了一张图。 */
const post = (host: Host, assetId: string, sender: string, extra: Record<string, unknown> = {}) =>
  host.inbound({
    text: '[图片]',
    images: [{ assetId, sticker: false }],
    sender: { memberId: sender },
    wouldTrigger: false,
    ...extra,
  })

const list = async (host: Host, view = 'all') =>
  (await host.rpc('library.list', { view })) as {
    total: number
    items: { id: string; scope: string; sources: string[]; origin: string; meaning: string; collector?: string }[]
  }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('收藏与跨群使用', () => {
  it('回答开头的错误 JSON 会结束处理，后续图片仍能收藏', async () => {
    // 在子进程中验证：同步死循环也能被超时终止，不会卡住整个测试进程。
    const script = `
      import assert from 'node:assert/strict'
      import { setTimeout } from 'node:timers/promises'
      import extension from ${JSON.stringify(new URL('../src/host.ts', import.meta.url).href)}
      import { createTestHost } from ${JSON.stringify(new URL('../../../tools/testing.ts', import.meta.url).href)}
      const model = ${JSON.stringify(vision)}
      const valid = ${JSON.stringify(reply())}
      for (const invalid of ['{"meaning": invalid}', '} invalid']) {
        let answer = invalid
        const host = await createTestHost(extension, { models: [model], modelReply: () => answer })
        await host.rpc('library.settings', { model: model.ref })
        host.useChannel(${JSON.stringify(ROOM_A)})
        const save = async (assetId) => {
          host.addPicture(assetId, { channels: [${JSON.stringify(ROOM_A.id)}] })
          await host.call('sticker_save', { assetId })
          for (;;) {
            const status = await host.rpc('collect.status')
            if (status.queued === 0 && status.working === 0) return status
            await setTimeout(5)
          }
        }
        const failed = await save('ast_INVALID')
        assert.equal(failed.failed, 1)
        assert.match(failed.errors[0], /模型没有按格式回答/)
        answer = valid
        await save('ast_VALID')
        const result = await host.rpc('library.list', { view: 'all' })
        assert.equal(result.total, 1)
        assert.equal(result.items[0].id, 'ast_VALID')
      }
    `
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: new URL('../../../', import.meta.url),
      timeout: 5000,
    })
  }, 8000)

  it('在甲群收藏的通用表情包，乙群也能搜到、看到并发出去', async () => {
    const host = await setup()
    host.addPicture('ast_CRY', { channels: [ROOM_A.id] })
    host.useChannel(ROOM_A)
    const saved = await save(host, 'ast_CRY')
    expect(saved.text).toBe('已加入收藏队列。')
    expect(host.library.has('ast_CRY')).toBe(true)
    expect((await list(host)).items).toMatchObject([{ id: 'ast_CRY', scope: 'public', origin: 'chat' }])

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

  it('收藏只交图片编号，备注交给打标模型参考', async () => {
    const host = await setup()
    host.addPicture('ast_CRY', { channels: [ROOM_A.id] })
    host.useChannel(ROOM_A)
    await save(host, 'ast_CRY', { note: '大家用来表示无语' })
    expect(promptOf(host.modelCalls[0]!)).toContain('智能体的备注：大家用来表示无语')
    expect(promptOf(host.modelCalls[0]!)).toContain('智能体在群聊里把这张图交来收藏')
    expect((await list(host)).items[0]).toMatchObject({ collector: 'agt_TEST' })
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
    expect((await save(host, '')).text).toContain('assetId')
    expect(host.library.size).toBe(0)
  })

  it('打标模型判断不能公共的图仅限来源频道使用', async () => {
    const host = await setup({}, { ast_CHAT: reply({ shareable: false }) })
    host.addPicture('ast_CHAT', { channels: [ROOM_A.id] })
    host.useChannel(ROOM_A)
    await save(host, 'ast_CHAT')
    expect((await list(host)).items).toMatchObject([{ id: 'ast_CHAT', scope: 'local' }])
    expect((await host.call('sticker_search', { query: '委屈' })).value).toMatchObject({ items: [{ id: 'ast_CHAT' }] })
    host.useChannel(ROOM_B)
    expect((await host.call('sticker_search', { query: '委屈' })).value).toEqual({ ok: true, items: [] })
    expect((await host.call('sticker_use', { id: 'ast_CHAT' })).text).toContain('不能在这个群用')
  })

  it('同一张图在另一个群再收藏时合并来源；外观相近的不同图分开保存', async () => {
    const host = await setup()
    host.addPicture('ast_ONE', { channels: [ROOM_A.id, ROOM_B.id], info: { dhash: '00ff00ff00ff00ff' } })
    host.addPicture('ast_SAME_TEMPLATE', { channels: [ROOM_B.id], info: { dhash: '00ff00ff00ff00fe' } })
    host.useChannel(ROOM_A)
    await save(host, 'ast_ONE')
    host.useChannel(ROOM_B)
    expect((await save(host, 'ast_ONE')).text).toBe('库里已经有这张。')
    await save(host, 'ast_SAME_TEMPLATE')
    const all = await list(host)
    expect(all.total).toBe(2)
    expect(all.items.find((item) => item.id === 'ast_ONE')).toMatchObject({ sources: [ROOM_A.id, ROOM_B.id] })
    expect(host.modelCalls).toHaveLength(2)
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

describe('自动收集', () => {
  it('被两个不同的人发过的图自动入库，同一个人反复发不算', async () => {
    const host = await setup()
    host.useChannel(ROOM_A)
    host.addPicture('ast_LOL', { channels: [ROOM_A.id] })
    host.addPicture('ast_SOLO', { channels: [ROOM_A.id] })
    await post(host, 'ast_SOLO', 'mbr_ALICE')
    await post(host, 'ast_SOLO', 'mbr_ALICE')
    await post(host, 'ast_LOL', 'mbr_ALICE')
    expect(host.library.size).toBe(0)
    await post(host, 'ast_LOL', 'mbr_BOB')
    await settled(host)
    expect((await list(host)).items).toMatchObject([
      { id: 'ast_LOL', origin: 'chat', scope: 'public', sources: [ROOM_A.id], collector: 'agt_TEST' },
    ])
    expect(promptOf(host.modelCalls[0]!)).toContain('被不同的人发过')
    expect(host.library.has('ast_SOLO')).toBe(false)
  })

  it('门槛可以改成出现一次就收', async () => {
    const host = await setup()
    expect(await host.rpc('library.settings', { threshold: 1 })).toMatchObject({ threshold: 1, concurrency: 2 })
    host.useChannel(ROOM_A)
    host.addPicture('ast_ONCE', { channels: [ROOM_A.id] })
    await post(host, 'ast_ONCE', 'mbr_ALICE')
    await settled(host)
    expect((await list(host)).total).toBe(1)
  })

  it('没选打标模型时只排队，选好后自动开始', async () => {
    const host = await createTestHost(extension, { models: [vision], modelReply: () => reply() })
    host.useChannel(ROOM_A)
    host.addPicture('ast_WAIT', { channels: [ROOM_A.id] })
    await post(host, 'ast_WAIT', 'mbr_ALICE')
    await post(host, 'ast_WAIT', 'mbr_BOB')
    expect(await host.rpc('collect.status')).toMatchObject({ queued: 1, waitingForModel: true })
    expect((await host.call('sticker_save', { assetId: 'ast_WAIT' })).text).toBe(
      '已加入收藏队列，管理员选好标注模型后入库。',
    )
    expect(await host.rpc('collect.status')).toMatchObject({ queued: 1 })
    expect(host.modelCalls).toHaveLength(0)

    await host.rpc('library.settings', { model: 'fixture:vision' })
    await settled(host)
    expect(await host.rpc('collect.status')).toMatchObject({ added: 1, waitingForModel: false })
    expect((await list(host)).total).toBe(1)
  })

  it('平台没标表情包的图也会收，平台标记只作为参考交给模型', async () => {
    const host = await setup({ hostConfig: {} })
    host.useChannel(ROOM_A)
    host.addPicture('ast_DRAGGED', { channels: [ROOM_A.id], info: { dhash: '0000000000000000' } })
    host.addPicture('ast_MARKED', { channels: [ROOM_A.id], info: { dhash: 'ffffffffffffffff' } })
    await post(host, 'ast_DRAGGED', 'mbr_ALICE')
    await post(host, 'ast_DRAGGED', 'mbr_BOB')
    await post(host, 'ast_MARKED', 'mbr_ALICE', { images: [{ assetId: 'ast_MARKED', sticker: true }] })
    await post(host, 'ast_MARKED', 'mbr_BOB')
    await settled(host)
    expect((await list(host)).total).toBe(2)
    const prompts = Object.fromEntries(host.modelCalls.map((request) => [imageOf(request), promptOf(request)]))
    expect(prompts['ast_DRAGGED']).not.toContain('平台把它标为表情包')
    expect(prompts['ast_MARKED']).toContain('平台把它标为表情包，仅供参考')
  })

  it('长图、照片尺寸的图按规则直接不收，之后再出现也不再判断', async () => {
    const host = await setup()
    host.useChannel(ROOM_A)
    host.addPicture('ast_LONG', { channels: [ROOM_A.id], info: { width: 400, height: 2000 } })
    host.addPicture('ast_PHOTO', { channels: [ROOM_A.id], info: { width: 4000, height: 3000 } })
    for (const id of ['ast_LONG', 'ast_PHOTO']) {
      await post(host, id, 'mbr_ALICE')
      await post(host, id, 'mbr_BOB')
    }
    await settled(host)
    expect(host.modelCalls).toHaveLength(0)
    expect(host.library.size).toBe(0)
    expect(await host.rpc('collect.status')).toMatchObject({ rejected: 2 })
    await post(host, 'ast_LONG', 'mbr_CAROL')
    expect(await host.rpc('collect.status')).toMatchObject({ queued: 0, rejected: 2 })
  })

  it('模型判断不是表情包的不收；智能体交来的照样收下，但仅限来源频道', async () => {
    const screenshot = reply({ sticker: false, shareable: false, meaning: '聊天截图' })
    const host = await setup({}, { ast_SHOT: screenshot, ast_ASKED: screenshot })
    host.useChannel(ROOM_A)
    host.addPicture('ast_SHOT', { channels: [ROOM_A.id] })
    host.addPicture('ast_ASKED', { channels: [ROOM_A.id] })
    await post(host, 'ast_SHOT', 'mbr_ALICE')
    await post(host, 'ast_SHOT', 'mbr_BOB')
    await save(host, 'ast_ASKED')
    expect((await list(host)).items).toMatchObject([{ id: 'ast_ASKED', scope: 'local' }])
    expect(host.library.has('ast_SHOT')).toBe(false)
  })

  it('智能体自己发的图和设置为不收集的频道不计数', async () => {
    const host = await setup({}, {})
    await host.rpc('library.settings', { threshold: 1 })
    host.useChannel({ ...ROOM_A, selfMemberId: 'mbr_SELF' })
    host.addPicture('ast_MINE', { channels: [ROOM_A.id] })
    await post(host, 'ast_MINE', 'mbr_SELF')
    await host.rpc('channel.set', { collect: 'off' }, panel(ROOM_B.id))
    host.useChannel(ROOM_B)
    host.addPicture('ast_OFF', { channels: [ROOM_B.id] })
    await post(host, 'ast_OFF', 'mbr_ALICE')
    await settled(host)
    expect(host.library.size).toBe(0)
  })

  it('智能体设为不收集或只在被要求时收集，就不自动收集', async () => {
    for (const collect of ['asked', 'off']) {
      const host = await setup({ config: { collect } })
      await host.rpc('library.settings', { threshold: 1 })
      host.useChannel(ROOM_A)
      host.addPicture('ast_SKIP', { channels: [ROOM_A.id] })
      await post(host, 'ast_SKIP', 'mbr_ALICE')
      await settled(host)
      expect(host.library.size).toBe(0)
    }
  })

  it('频道设为仅限本频道时，收来的图都不公共', async () => {
    const host = await setup()
    await host.rpc('channel.set', { collect: 'local' }, panel(ROOM_A.id))
    host.useChannel(ROOM_A)
    host.addPicture('ast_HERE', { channels: [ROOM_A.id] })
    await post(host, 'ast_HERE', 'mbr_ALICE')
    await post(host, 'ast_HERE', 'mbr_BOB')
    await settled(host)
    expect((await list(host)).items).toMatchObject([{ id: 'ast_HERE', scope: 'local' }])
  })

  it('已在库里的图在别的群出现时记下来源', async () => {
    const host = await setup({}, { ast_LOCAL: reply({ shareable: false }) })
    host.addPicture('ast_LOCAL', { channels: [ROOM_A.id, ROOM_B.id] })
    host.useChannel(ROOM_A)
    await save(host, 'ast_LOCAL')
    host.useChannel(ROOM_B)
    await post(host, 'ast_LOCAL', 'mbr_BOB')
    expect((await list(host)).items[0]).toMatchObject({ sources: [ROOM_A.id, ROOM_B.id] })
    expect((await host.call('sticker_search', { query: '委屈' })).value).toMatchObject({ items: [{ id: 'ast_LOCAL' }] })
  })

  it('并行数限制同时处理的张数', async () => {
    let running = 0
    let peak = 0
    const host = await setup({
      modelReply: async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 5))
        running -= 1
        return reply()
      },
    })
    await host.rpc('library.settings', { threshold: 1, concurrency: 3 })
    host.useChannel(ROOM_A)
    for (let index = 0; index < 8; index += 1) {
      host.addPicture(`ast_${index}`, { channels: [ROOM_A.id] })
      await post(host, `ast_${index}`, 'mbr_ALICE')
    }
    await settled(host)
    expect((await list(host)).total).toBe(8)
    expect(peak).toBe(3)
  })

  it('打标失败时图片移出资源库，之后再有人发会重新排队', async () => {
    let broken = true
    const host = await setup({ modelReply: () => (broken ? 'not json' : reply()) })
    host.useChannel(ROOM_A)
    host.addPicture('ast_RETRY', { channels: [ROOM_A.id] })
    await post(host, 'ast_RETRY', 'mbr_ALICE')
    await post(host, 'ast_RETRY', 'mbr_BOB')
    await settled(host)
    expect(await host.rpc('collect.status')).toMatchObject({
      failed: 1,
      errors: [expect.stringContaining('模型没有按格式回答')],
    })
    expect(host.library.has('ast_RETRY')).toBe(false)
    broken = false
    await post(host, 'ast_RETRY', 'mbr_CAROL')
    await settled(host)
    expect((await list(host)).total).toBe(1)
  })
})

describe('使用提示', () => {
  /** 库里有一张可以公共使用的表情包。 */
  const stocked = async (config: Record<string, string> = {}) => {
    const host = await setup({ config })
    host.addToLibrary('ast_STOCK')
    await host.rpc('import.start', { items: [{ assetId: 'ast_STOCK', name: '委屈.png' }] })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    host.useChannel(ROOM_A)
    return host
  }
  const ask = (host: Host, words = '在吗') => host.inbound({ text: words, wouldTrigger: true })

  it('按使用频率在随机区间里提示，发过表情包后重新计数', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const host = await stocked({ frequency: 'often' })
    expect(await ask(host)).toBeUndefined()
    expect(await ask(host)).toEqual({ annotation: '这次回复适合配一张表情包，有合适的就发。' })
    expect(await ask(host)).toBeUndefined()
    await host.call('sticker_use', { id: 'ast_STOCK' })
    expect(await ask(host)).toBeUndefined()
    expect(await ask(host)).toMatchObject({ annotation: expect.any(String) })
    // 不会唤醒智能体的消息不计数。
    expect(await host.inbound({ text: '闲聊', wouldTrigger: false })).toBeUndefined()
  })

  it('库里没有可用的表情包、频率为极少或频道不使用时不提示', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const empty = await setup({ config: { frequency: 'often' } })
    empty.useChannel(ROOM_A)
    const rare = await stocked({ frequency: 'rare' })
    const off = await stocked({ frequency: 'often' })
    await off.rpc('channel.set', { use: 'off' }, panel(ROOM_A.id))
    for (const host of [empty, rare, off]) {
      for (let index = 0; index < 6; index += 1) expect(await ask(host)).toBeUndefined()
    }
  })

  it('智能判断跟着群里发表情包的密度，没人发表情包的群不提示', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const host = await stocked()
    for (let index = 0; index < 12; index += 1) await host.inbound({ text: '讨论正事', wouldTrigger: false })
    for (let index = 0; index < 6; index += 1) expect(await ask(host, '这个怎么配置')).toBeUndefined()
    // 大家开始斗图后，提示变得频繁。
    host.addPicture('ast_FUN', { channels: [ROOM_A.id] })
    for (let index = 0; index < 10; index += 1) await post(host, 'ast_FUN', 'mbr_ALICE')
    expect(await ask(host)).toBeUndefined()
    expect(await ask(host)).toMatchObject({ annotation: expect.any(String) })
  })
})

describe('群与智能体的设置', () => {
  it('频道面板可以关掉收藏、只用本频道或不使用表情包', async () => {
    const host = await setup()
    host.addPicture('ast_A', { channels: [ROOM_A.id] })
    host.addPicture('ast_B', { channels: [ROOM_B.id], info: { dhash: 'ffffffffffffffff' } })
    host.useChannel(ROOM_A)
    await save(host, 'ast_A')

    expect(await host.rpc('channel.set', { collect: 'off' }, panel(ROOM_B.id))).toMatchObject({ collect: 'off' })
    host.useChannel(ROOM_B)
    expect((await save(host, 'ast_B')).text).toContain('不收藏表情包')

    await host.rpc('channel.set', { collect: 'local', use: 'local' }, panel(ROOM_B.id))
    await save(host, 'ast_B')
    expect((await list(host)).items.find((item) => item.id === 'ast_B')).toMatchObject({ scope: 'local' })
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
    expect(await host.rpc('library.settings', { paused: true })).toMatchObject({
      paused: true,
      model: 'fixture:vision',
    })
    host.useChannel(ROOM_B)
    expect((await host.call('sticker_search', { query: '委屈' })).value).toEqual({ ok: true, items: [] })
    host.useChannel(ROOM_A)
    expect((await host.call('sticker_search', { query: '委屈' })).value).toMatchObject({ items: [{ id: 'ast_A' }] })
  })

  it('本机设置不认识的值退回默认，清空模型后收集队列停下', async () => {
    const host = await setup()
    expect(await host.rpc('library.settings', { threshold: 7, concurrency: 99 })).toEqual({
      paused: false,
      model: 'fixture:vision',
      threshold: 2,
      concurrency: 2,
    })
    expect(await host.rpc('library.settings', { model: '' })).not.toHaveProperty('model')
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

  it('附图数量跟随配置，说明里写清收藏方式', async () => {
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
    expect(host.prompts.static.get('guide')).toContain('有人请你收藏某张图时')
    expect((await setup()).prompts.static.get('guide')).toContain('自动收进库里')
  })

  it('使用频率写进说明，默认跟着聊天气氛', async () => {
    const smart = await setup()
    expect(smart.prompts.static.get('guide')).toContain('跟着聊天气氛')
    for (const [frequency, words] of [
      ['often', '只发一张表情包当作回复'],
      ['moderate', '适量用表情包'],
      ['sometimes', '少用表情包'],
      ['rare', '很少用表情包'],
    ] as const) {
      const host = await setup({ config: { frequency } })
      const guide = host.prompts.static.get('guide') ?? ''
      expect(guide).toContain(words)
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

  it('回收站里的图不会被自动收集带回来', async () => {
    const host = await setup()
    host.addPicture('ast_GONE', { channels: [ROOM_A.id] })
    host.useChannel(ROOM_A)
    await save(host, 'ast_GONE')
    await host.call('sticker_remove', { id: 'ast_GONE' })
    await post(host, 'ast_GONE', 'mbr_ALICE')
    await post(host, 'ast_GONE', 'mbr_BOB')
    await settled(host)
    expect(await host.rpc('library.overview')).toMatchObject({ total: 0, trash: 1 })
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
    for (const method of [
      'library.overview',
      'library.list',
      'library.settings',
      'collect.status',
      'import.status',
      'import.cancel',
    ]) {
      await expect(host.rpc(method)).resolves.toBeDefined()
    }
    expect(await host.rpc('library.update')).toMatchObject({ ok: false })
    expect(await host.rpc('library.remove')).toMatchObject({ ok: false })
    expect(await host.rpc('channel.set', { collect: 'off' })).toMatchObject({ ok: false })
  })
})

describe('批量导入', () => {
  it('用所选的视觉模型标注，不宜公共的图仅限来源频道', async () => {
    const replies: Record<string, string> = {
      ast_OK:
        '```json\n{"meaning":"表达开心，适合庆祝时","caption":"好耶","description":"小猫举手","tags":["开心","猫"],"sticker":true,"shareable":true}\n```',
      ast_SHOT:
        '{"meaning":"聊天截图","caption":"","description":"群聊截图","tags":["截图"],"sticker":false,"shareable":false}',
    }
    let flaky = 0
    const host = await setup({
      modelReply: (request) => {
        const assetId = imageOf(request)
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
      modelReply: () =>
        '{"sticker":false,"shareable":false,"meaning":"聊天截图","caption":"","description":"截图","tags":["截图"]}',
    })
    host.addToLibrary('ast_PLAIN', { info: { dhash: '1111111111111111' } })
    await host.rpc('import.start', { items: [{ assetId: 'ast_PLAIN', name: 'x.png' }] })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    expect((await list(host)).items).toMatchObject([{ id: 'ast_PLAIN', scope: 'public' }])

    await host.rpc('import.start', { model: 'fixture:vision', items: [{ assetId: 'ast_PLAIN', name: 'x.png' }] })
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    expect((await list(host)).items).toMatchObject([{ id: 'ast_PLAIN', scope: 'local' }])
  })

  it('导入与收集共用并行数', async () => {
    let running = 0
    let peak = 0
    const host = await setup({
      modelReply: async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 5))
        running -= 1
        return reply()
      },
    })
    await host.rpc('library.settings', { threshold: 1, concurrency: 2 })
    host.useChannel(ROOM_A)
    const items = Array.from({ length: 4 }, (_, index) => {
      host.addToLibrary(`ast_IMPORT${index}`)
      return { assetId: `ast_IMPORT${index}`, name: `${index}.png` }
    })
    await host.rpc('import.start', { model: 'fixture:vision', items })
    for (let index = 0; index < 4; index += 1) {
      host.addPicture(`ast_CHAT${index}`, { channels: [ROOM_A.id] })
      await post(host, `ast_CHAT${index}`, 'mbr_ALICE')
    }
    await vi.waitFor(async () => expect(await host.rpc('import.status')).toMatchObject({ state: 'done' }))
    await settled(host)
    expect((await list(host)).total).toBe(8)
    expect(peak).toBe(2)
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
