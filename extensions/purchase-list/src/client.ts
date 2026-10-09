import { defineClientExtension, type ExtensionJsonValue } from '@nekro-nxt/extension-sdk'

/**
 * 「采购清单」页面：通过 `host.call` 调用本机实例的界面数据接口，和智能体的工具读写同一份清单。
 * 页面不需要锚点；每次改动后接口返回最新清单，页面直接用它刷新。
 */
type Item = {
  readonly id: string
  readonly name: string
  readonly quantity?: string
  readonly note?: string
  readonly requester?: string
  readonly agent: string
  readonly done: boolean
  readonly createdAt: number
}

const itemsOf = (value: ExtensionJsonValue): readonly Item[] =>
  Array.isArray(value) ? (value as unknown as readonly Item[]) : []

const dateText = (at: number): string =>
  new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export default defineClientExtension(({ React, host }) => ({
  inject: ['pages', 'ui'],
  apply(ctx) {
    const {
      Button,
      DataTable,
      EmptyState,
      InlineFeedback,
      Metric,
      MetricStrip,
      PageHeader,
      Section,
      Stack,
      StatusBadge,
      Switch,
    } = ctx.ui
    const h = React.createElement

    const ListPage = () => {
      const [items, setItems] = React.useState<readonly Item[] | undefined>(undefined)
      const [error, setError] = React.useState<string | undefined>(undefined)
      const run = React.useCallback(async (method: string, input: ExtensionJsonValue = null) => {
        try {
          setItems(itemsOf(await host.call(method, input)))
          setError(undefined)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }, [])
      React.useEffect(() => {
        void run('items.list')
      }, [run])

      const pending = items?.filter((item) => !item.done) ?? []
      const done = items?.filter((item) => item.done) ?? []
      const header = h(PageHeader, {
        title: '采购清单',
        meta: '群里对智能体说要买什么，它会记在这里；买好后勾选，定期清理已买的。',
        actions:
          done.length > 0
            ? h(Button, { variant: 'ghost', onClick: () => void run('items.clearDone') }, `清理 ${done.length} 项已买`)
            : null,
      })

      if (items === undefined && error === undefined) {
        return h(Stack, null, header, h(EmptyState, { title: '正在读取清单', loading: true }))
      }
      const rows = [...pending, ...done].map((item) =>
        h(
          'tr',
          { key: item.id },
          h(
            'td',
            null,
            h(Switch, {
              label: item.done ? `取消已买：${item.name}` : `标记已买：${item.name}`,
              checked: item.done,
              onCheckedChange: () => run('items.toggle', { id: item.id }),
            }),
          ),
          h('td', null, item.name, item.done ? h(StatusBadge, { tone: 'success' }, '已买') : null),
          h('td', null, item.quantity ?? '—'),
          h('td', null, item.note ?? '—'),
          h('td', null, item.requester ?? '—'),
          h('td', null, `${item.agent} · ${dateText(item.createdAt)}`),
          h(
            'td',
            null,
            h(
              Button,
              { variant: 'ghost', size: 'small', onClick: () => void run('items.remove', { id: item.id }) },
              '删除',
            ),
          ),
        ),
      )
      return h(
        Stack,
        null,
        header,
        error === undefined ? null : h(InlineFeedback, { tone: 'error' }, `操作失败：${error}`),
        h(
          MetricStrip,
          null,
          h(Metric, { label: '待买', value: String(pending.length) }),
          h(Metric, { label: '已买', value: String(done.length) }),
        ),
        rows.length === 0
          ? h(EmptyState, {
              title: '清单是空的',
              description: '在启用了本扩展的智能体所在的群里说「帮我记一下要买两箱打印纸」试试。',
            })
          : h(
              Section,
              null,
              h(
                DataTable,
                null,
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, '已买'),
                    h('th', null, '物品'),
                    h('th', null, '数量'),
                    h('th', null, '备注'),
                    h('th', null, '提出人'),
                    h('th', null, '记录'),
                    h('th', null, ''),
                  ),
                ),
                h('tbody', null, ...rows),
              ),
            ),
      )
    }

    ctx.pages.register(
      {
        page: {
          kind: 'host-page',
          entryId: 'list',
          title: '采购清单',
          description: '团队要买的东西，智能体记录，在这里勾选已买',
          icon: { kind: 'host-icon', name: 'file-text' },
          objectPane: 'hidden',
          startPath: '',
          rail: { order: 50 },
        },
      },
      ListPage,
    )
  },
}))
