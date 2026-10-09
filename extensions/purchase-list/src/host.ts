import {
  defineHostExtension,
  type ExtensionJsonValue,
  type NxtHostLayerService,
  type NxtHostService,
} from '@nekro-nxt/extension-sdk'

/**
 * 团队采购清单：示范一个扩展同时给智能体提供工具、并带一个管理页面，两边读写同一份数据。
 *
 * 示范要点：
 * - factory 只在本机执行一次（本机实例）：用 `harness.handle` 注册页面调用的界面数据接口，读写本机层 `nxt.storage`；
 * - factory 返回的插件挂载到每个启用了它的智能体，工具用 `ctx.nxt.storage` 的 `scope: 'shared'` 读写同一份数据，
 *   所以几个智能体记下的东西都出现在同一张清单里；
 * - 工具与接口都在同一个进程里运行，读改写由 factory 中的同一个队列串行，避免并发写丢失；
 * - 导入验证会真实调用工具与接口：没有样例的工具在缺参数时直接返回提示，不写入任何数据。
 */
const KEY = 'items'
const MAX_ITEMS = 200
const SHARED = { scope: 'shared' } as const

type Item = {
  readonly id: string
  readonly name: string
  readonly quantity?: string
  readonly note?: string
  /** 提出要买的人（频道里最新一条消息的发送者）。 */
  readonly requester?: string
  /** 记下这项的智能体。 */
  readonly agent: string
  readonly done: boolean
  readonly createdAt: number
}
type Failure = { readonly ok: false; readonly message: string }
type AddResult = { readonly ok: true; readonly item: Item; readonly pending: number } | Failure
type ListResult = { readonly ok: true; readonly items: readonly (Item & { readonly index: number })[] } | Failure
type MarkResult = { readonly ok: true; readonly item: Item } | Failure

/** 两层存储接口形状不同，这里只取读写两个方法。 */
interface ItemStore {
  get(): Promise<ExtensionJsonValue | undefined>
  set(items: readonly Item[]): Promise<void>
}
const hostStore = (nxt: NxtHostLayerService): ItemStore => ({
  get: () => nxt.storage.get(KEY),
  set: (items) => nxt.storage.set(KEY, items),
})
const agentStore = (nxt: NxtHostService): ItemStore => ({
  get: () => nxt.storage.get(KEY, SHARED),
  set: (items) => nxt.storage.set(KEY, items, SHARED),
})

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim().slice(0, max) : ''
const text = (value: string) => [{ type: 'text' as const, text: value }]

const readItems = async (store: ItemStore): Promise<Item[]> => {
  const saved = await store.get()
  return Array.isArray(saved) ? (saved as unknown as Item[]) : []
}
const describe = (item: Item): string =>
  [item.name, item.quantity && `×${item.quantity}`, item.note && `（${item.note}）`].filter(Boolean).join(' ')

export default defineHostExtension(async ({ harness, nxt: host }) => {
  // 页面与所有智能体的读改写都排进同一个队列。
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => undefined).then(action)
    queue = next
    return next
  }
  const update = (store: ItemStore, change: (items: Item[]) => Item[] | undefined) =>
    serial(async () => {
      const items = await readItems(store)
      const next = change(items)
      if (next !== undefined) await store.set(next)
      return next ?? items
    })

  // 页面调用的界面数据接口：参数不合法时原样返回清单，导入验证用 null 调用也不会出错。
  const shared = hostStore(host)
  const idOf = (input: ExtensionJsonValue): string => clip(record(input)['id'], 64)
  harness.handle('items.list', () => readItems(shared))
  harness.handle('items.toggle', (input) =>
    update(shared, (items) => {
      const id = idOf(input)
      if (!items.some((item) => item.id === id)) return undefined
      return items.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
    }),
  )
  harness.handle('items.remove', (input) =>
    update(shared, (items) => {
      const id = idOf(input)
      return items.some((item) => item.id === id) ? items.filter((item) => item.id !== id) : undefined
    }),
  )
  harness.handle('items.clearDone', () =>
    update(shared, (items) => (items.some((item) => item.done) ? items.filter((item) => !item.done) : undefined)),
  )

  return {
    inject: ['tools', 'nxt'],
    apply(ctx) {
      const nxt = ctx.nxt
      if (!nxt) throw new Error('团队采购清单需要宿主能力 nxt。')
      const store = agentStore(nxt)

      harness.registerTool(
        ctx,
        harness.defineTool<{ readonly name?: string; readonly quantity?: string; readonly note?: string }, AddResult>({
          name: 'add_purchase_item',
          description:
            '把一件要买的东西加入团队采购清单（所有启用本扩展的智能体共用一份）。name 必填，最多 60 字；quantity、note 可选，各最多 40 字。同名且未买的项不会重复添加。',
          parameters: {
            name: { type: 'string', required: true, description: '要买的东西，例如「A4 打印纸」' },
            quantity: { type: 'string', description: '数量与单位，例如「2 箱」' },
            note: { type: 'string', description: '备注，例如品牌、规格或期限' },
          },
          output: {
            schema: { type: 'json' },
            render: (_args, value) =>
              text(
                value.ok ? `已记下「${describe(value.item)}」，清单里还有 ${value.pending} 项没买。` : value.message,
              ),
          },
          execute: async ({ name, quantity, note }) => {
            const title = clip(name, 60)
            if (!title) return { ok: false, message: '请告诉我要买什么（name）。' }
            const { agent, latestInbound } = await nxt.context.current()
            let added: Item | undefined
            let failure: Failure | undefined
            const items = await update(store, (current) => {
              const existing = current.find((item) => !item.done && item.name === title)
              if (existing) {
                added = existing
                return undefined
              }
              if (current.length >= MAX_ITEMS) {
                failure = { ok: false, message: `清单最多 ${MAX_ITEMS} 项，请先在「采购清单」页面清理已买的。` }
                return undefined
              }
              const requester = clip(latestInbound?.sender?.displayName, 40)
              added = {
                id: crypto.randomUUID(),
                name: title,
                ...(clip(quantity, 40) ? { quantity: clip(quantity, 40) } : {}),
                ...(clip(note, 40) ? { note: clip(note, 40) } : {}),
                ...(requester ? { requester } : {}),
                agent: agent.name,
                done: false,
                createdAt: Date.now(),
              }
              return [...current, added]
            })
            if (failure) return failure
            if (!added) return { ok: false, message: '没有记下，请稍后再试。' }
            return { ok: true, item: added, pending: items.filter((item) => !item.done).length }
          },
        }),
      )

      harness.registerTool(
        ctx,
        harness.defineTool<{ readonly includeDone?: boolean }, ListResult>({
          name: 'list_purchase_items',
          description: '列出团队采购清单与序号；默认只列还没买的，includeDone 为 true 时也列出已买的。',
          parameters: { includeDone: { type: 'boolean', description: '是否包含已买的项，默认 false' } },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => {
              if (!value.ok) return text(value.message)
              if (value.items.length === 0) return text('采购清单是空的。')
              return text(
                value.items
                  .map(
                    (item) =>
                      `${item.index}. ${describe(item)}${item.done ? '【已买】' : ''}${item.requester ? ` — ${item.requester}` : ''}`,
                  )
                  .join('\n'),
              )
            },
          },
          execute: async ({ includeDone }) => {
            const items = (await readItems(store)).map((item, index) => ({ ...item, index: index + 1 }))
            return { ok: true, items: includeDone === true ? items : items.filter((item) => !item.done) }
          },
        }),
      )

      harness.registerTool(
        ctx,
        harness.defineTool<{ readonly index?: number }, MarkResult>({
          name: 'mark_purchased',
          description: '按 list_purchase_items 返回的序号把一项标记为已买；序号以最近一次列出的结果为准。',
          parameters: { index: { type: 'integer', required: true, description: 'list_purchase_items 中的序号' } },
          output: {
            schema: { type: 'json' },
            render: (_args, value) => text(value.ok ? `已把「${describe(value.item)}」标记为已买。` : value.message),
          },
          execute: async ({ index }) => {
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 1)
              return { ok: false, message: '请提供 list_purchase_items 中的序号（从 1 开始的整数）。' }
            let marked: Item | undefined
            await update(store, (items) => {
              const target = items[index - 1]
              if (!target) return undefined
              marked = { ...target, done: true }
              return items.map((item, position) => (position === index - 1 ? (marked as Item) : item))
            })
            return marked
              ? { ok: true, item: marked }
              : { ok: false, message: '没有这个序号，请先用 list_purchase_items 查看清单。' }
          },
        }),
      )
    },
  }
})
