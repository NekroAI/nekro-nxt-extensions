import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createTestHost } from '../../../tools/testing.js'
import factory from '../src/host.js'

type Item = {
  id: string
  name: string
  quantity?: string
  note?: string
  requester?: string
  agent: string
  done: boolean
}

const items = async (host: Awaited<ReturnType<typeof createTestHost>>) => (await host.rpc('items.list')) as Item[]

describe('团队采购清单', () => {
  it('工具记下的东西出现在页面接口读到的同一份清单里', async () => {
    const host = await createTestHost(factory)
    expect([...host.tools.keys()]).toEqual(['add_purchase_item', 'list_purchase_items', 'mark_purchased'])
    const { value, text } = await host.call('add_purchase_item', { name: ' A4 打印纸 ', quantity: '2 箱', note: '70g' })
    expect(value).toMatchObject({ ok: true, pending: 1 })
    expect(text).toBe('已记下「A4 打印纸 ×2 箱 （70g）」，清单里还有 1 项没买。')
    expect(await items(host)).toMatchObject([
      { name: 'A4 打印纸', quantity: '2 箱', note: '70g', requester: '爱丽丝', agent: '测试智能体', done: false },
    ])
    // 智能体层的 shared 存储与本机层存储是同一份数据。
    expect([...host.storage.keys()]).toEqual(['shared::items'])
  })

  it('同名且未买的项不重复添加，已买后可以再次添加', async () => {
    const host = await createTestHost(factory)
    await host.call('add_purchase_item', { name: '咖啡豆' })
    expect((await host.call('add_purchase_item', { name: '咖啡豆' })).value).toMatchObject({ ok: true, pending: 1 })
    expect(await items(host)).toHaveLength(1)
    await host.call('mark_purchased', { index: 1 })
    await host.call('add_purchase_item', { name: '咖啡豆' })
    expect((await items(host)).map((item) => item.done)).toEqual([true, false])
  })

  it('列表默认只列未买的项，序号按完整清单计算', async () => {
    const host = await createTestHost(factory)
    for (const name of ['纸杯', '抽纸', '电池']) await host.call('add_purchase_item', { name })
    await host.call('mark_purchased', { index: 2 })
    expect((await host.call('list_purchase_items')).text).toBe('1. 纸杯 — 爱丽丝\n3. 电池 — 爱丽丝')
    expect((await host.call('list_purchase_items', { includeDone: true })).text).toContain('2. 抽纸【已买】')
    expect((await host.call('mark_purchased', { index: 3 })).text).toBe('已把「电池」标记为已买。')
  })

  it('页面可以切换已买、删除和清理已买的项', async () => {
    const host = await createTestHost(factory)
    for (const name of ['纸杯', '抽纸', '电池']) await host.call('add_purchase_item', { name })
    const [cup, tissue] = await items(host)
    expect(((await host.rpc('items.toggle', { id: cup!.id })) as Item[])[0]!.done).toBe(true)
    expect(((await host.rpc('items.remove', { id: tissue!.id })) as Item[]).map((item) => item.name)).toEqual([
      '纸杯',
      '电池',
    ])
    expect(((await host.rpc('items.clearDone')) as Item[]).map((item) => item.name)).toEqual(['电池'])
  })

  it('参数不合法时给出提示，不写入数据', async () => {
    const host = await createTestHost(factory)
    expect((await host.call('add_purchase_item', {})).text).toBe('请告诉我要买什么（name）。')
    expect((await host.call('mark_purchased', {})).text).toContain('请提供')
    expect((await host.call('mark_purchased', { index: 5 })).text).toContain('没有这个序号')
    for (const method of ['items.toggle', 'items.remove', 'items.clearDone']) {
      expect(await host.rpc(method, null, { surface: 'verification' })).toEqual([])
    }
    expect(host.storage.size).toBe(0)
  })

  it('并发添加不会丢失记录', async () => {
    const host = await createTestHost(factory)
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => host.call('add_purchase_item', { name: `物品${index}` })),
    )
    expect(await items(host)).toHaveLength(10)
  })

  it('运行清单中的全部验证样例都没有副作用', async () => {
    const host = await createTestHost(factory)
    const definition = JSON.parse(readFileSync(new URL('../extension.json', import.meta.url), 'utf8')) as {
      contributions: { kind: string; name?: string; method?: string; verificationInput?: Record<string, unknown> }[]
    }
    for (const contribution of definition.contributions) {
      if (contribution.kind === 'tool') await host.call(contribution.name!, contribution.verificationInput as never)
      if (contribution.kind === 'rpc') await host.rpc(contribution.method!, null, { surface: 'verification' })
    }
    expect(host.storage.size).toBe(0)
  })
})
