import { defineClientExtension, type ExtensionJsonValue, type ExtensionPanelProps } from '@nekro-nxt/extension-sdk'

/**
 * 频道面板：列出当前智能体在这个频道的订阅。面板带上自己的锚点调用 `feeds.list`，宿主据此告诉本机实例
 * 是哪个智能体、哪个频道；订阅和取消仍由智能体通过工具完成。
 */
type Item = { readonly title: string; readonly link?: string; readonly published?: number }
type FeedView = {
  readonly url: string
  readonly label: string
  readonly intervalMinutes: number
  readonly failures: number
  readonly lastCheckedAt: number
  readonly latest?: Item
}

const feedsOf = (value: ExtensionJsonValue): readonly FeedView[] => {
  const feeds =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Readonly<Record<string, ExtensionJsonValue>>)['feeds']
      : undefined
  return Array.isArray(feeds) ? (feeds as unknown as readonly FeedView[]) : []
}

const checkedText = (at: number): string => (at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '尚未检查')

export default defineClientExtension(({ React, host }) => ({
  inject: ['panels', 'ui'],
  apply(ctx) {
    const { EmptyState, InlineFeedback, PropertyList, PropertyRow, Section, Stack, StatusBadge } = ctx.ui
    const h = React.createElement

    const FeedsPanel = ({ anchor, density }: ExtensionPanelProps) => {
      const [feeds, setFeeds] = React.useState<readonly FeedView[] | undefined>(undefined)
      const [error, setError] = React.useState<string | undefined>(undefined)
      React.useEffect(() => {
        let active = true
        host
          .call('feeds.list', null, { anchor })
          .then((value) => active && setFeeds(feedsOf(value)))
          .catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : String(reason)))
        return () => {
          active = false
        }
      }, [anchor.kind, anchor.id])

      if (error !== undefined) return h(InlineFeedback, { tone: 'error' }, `读取订阅失败：${error}`)
      if (feeds === undefined) return h(EmptyState, { title: '正在读取订阅', loading: true })
      if (feeds.length === 0) {
        return h(EmptyState, { title: '这个频道还没有订阅', description: '让智能体订阅一个 RSS 或 Atom 地址即可。' })
      }
      if (density === 'compact') {
        const failing = feeds.filter((feed) => feed.failures > 0).length
        return h(
          PropertyList,
          null,
          h(PropertyRow, { label: '订阅' }, `${feeds.length} 个`),
          failing > 0 ? h(PropertyRow, { label: '取回失败' }, `${failing} 个`) : null,
        )
      }
      return h(
        Stack,
        null,
        ...feeds.map((feed) =>
          h(
            Section,
            { key: feed.url, title: feed.label },
            h(
              PropertyList,
              null,
              h(PropertyRow, { label: '地址' }, feed.url),
              h(PropertyRow, { label: '检查间隔' }, `每 ${feed.intervalMinutes} 分钟`),
              h(PropertyRow, { label: '最近检查' }, checkedText(feed.lastCheckedAt)),
              h(
                PropertyRow,
                { label: '状态' },
                feed.failures > 0
                  ? h(StatusBadge, { tone: 'warning' }, `连续 ${feed.failures} 次取回失败`)
                  : h(StatusBadge, { tone: 'success' }, '正常'),
              ),
              h(PropertyRow, { label: '最近新内容' }, feed.latest?.title ?? '尚无'),
            ),
          ),
        ),
      )
    }

    ctx.panels.register(
      { id: 'feeds', anchor: 'channel', title: 'RSS 订阅', densities: ['compact', 'full'] },
      FeedsPanel,
    )
  },
}))
