import {
  defineClientExtension,
  type ExtensionJsonValue,
  type ExtensionPanelProps,
  type ExtensionUploadFile,
} from '@nekro-nxt/extension-sdk'
import styles from '../assets/client.module.css'

/**
 * 「表情包」页面与频道面板：页面浏览、搜索、编辑和批量导入，面板设置单个群收藏和使用表情包的方式。
 * 图片通过 `host.assetUrl` 显示，导入时先用 `host.upload` 把图片或压缩包放进扩展资源库，再交给本机实例补写。
 */
type View = 'all' | 'public' | 'local' | 'flowed' | 'unlabeled' | 'trash'

interface Sticker {
  readonly id: string
  readonly meaning: string
  readonly caption: string
  readonly description: string
  readonly tags: readonly string[]
  readonly scope: 'public' | 'local'
  readonly sources: readonly string[]
  readonly sentTo: readonly string[]
  readonly collectorName?: string
  readonly origin: 'chat' | 'import'
  readonly frames: number
  readonly byteSize: number
  readonly sentCount: number
  readonly deletedAt?: number
}

interface Overview {
  readonly total: number
  readonly public: number
  readonly local: number
  readonly unlabeled: number
  readonly trash: number
  readonly paused: boolean
}

interface ImportStatus {
  readonly state: 'running' | 'done' | 'cancelled'
  readonly total: number
  readonly done: number
  readonly skipped: number
  readonly failed: number
  readonly errors: readonly string[]
}

interface ModelOption {
  readonly ref: string
  readonly name: string
  readonly providerName: string
}

const VIEWS: readonly { readonly value: View; readonly label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'public', label: '流通' },
  { value: 'local', label: '只在本群' },
  { value: 'flowed', label: '最近流入其他群' },
  { value: 'unlabeled', label: '没写用途' },
  { value: 'trash', label: '回收站' },
]

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const megabytes = (bytes: number): string => `${Math.max(0.1, Math.round(bytes / 1024 / 102.4) / 10)} MB`
const message = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))
const NO_MODEL = '__none__'
/** 构建会给 CSS Module 的类名加作用域，取映射后的名字。 */
const cls = (name: string): string => styles[name] ?? name

export default defineClientExtension(({ React, host }) => ({
  inject: ['pages', 'panels', 'ui', 'data'],
  apply(ctx) {
    const {
      Button,
      Dialog,
      EmptyState,
      Field,
      InlineFeedback,
      Input,
      Metric,
      MetricStrip,
      PageHeader,
      PropertyList,
      PropertyRow,
      Section,
      Select,
      Stack,
      StatusBadge,
      Switch,
      Tabs,
      Textarea,
    } = ctx.ui
    const h = React.createElement

    /** 来源群的名字；没有读取频道的权限或频道已删除时显示编号。 */
    const ChannelName = ({ id }: { readonly id: string }) => h('span', null, ctx.data.useChannel(id)?.name ?? id)

    const channelList = (ids: readonly string[]) =>
      ids.length === 0
        ? '—'
        : h('span', null, ...ids.flatMap((id, index) => [index > 0 ? '、' : null, h(ChannelName, { key: id, id })]))

    const Card = ({ sticker, onOpen }: { readonly sticker: Sticker; readonly onOpen: () => void }) =>
      h(
        'button',
        {
          type: 'button',
          className: cls('stk-card'),
          onClick: onOpen,
          'aria-label': sticker.meaning || '没写用途的表情包',
        },
        h(
          'span',
          { className: cls('stk-thumb') },
          h('img', { src: host.assetUrl(sticker.id, { thumbnail: true }), alt: '', loading: 'lazy' }),
        ),
        h(
          'span',
          { className: sticker.meaning ? cls('stk-meaning') : `${cls('stk-meaning')} ${cls('stk-muted')}` },
          sticker.meaning || '还没写用途',
        ),
        h(
          'span',
          { className: cls('stk-badges') },
          sticker.frames > 1 ? h(StatusBadge, { tone: 'info' }, '动图') : null,
          sticker.scope === 'local' ? h(StatusBadge, { tone: 'neutral' }, '只在本群') : null,
        ),
      )

    const Detail = ({
      sticker,
      onClose,
      onChanged,
    }: {
      readonly sticker: Sticker
      readonly onClose: () => void
      readonly onChanged: () => void
    }) => {
      const [draft, setDraft] = React.useState({
        meaning: sticker.meaning,
        caption: sticker.caption,
        description: sticker.description,
        tags: sticker.tags.join('、'),
        scope: sticker.scope,
      })
      const [error, setError] = React.useState<string | undefined>(undefined)
      const [busy, setBusy] = React.useState(false)
      const run = async (method: string, input: ExtensionJsonValue) => {
        setBusy(true)
        try {
          const result = record(await host.call(method, input))
          if (result['ok'] === false) throw new Error(String(result['message']))
          onChanged()
          onClose()
        } catch (reason) {
          setError(message(reason))
        } finally {
          setBusy(false)
        }
      }
      const trashed = sticker.deletedAt !== undefined
      const field = (key: 'caption' | 'description' | 'tags', label: string, hint?: string) =>
        h(
          Field,
          { label, ...(hint ? { hint } : {}) },
          h(Input, {
            value: draft[key],
            disabled: trashed,
            onChange: (event: { readonly target: { readonly value: string } }) =>
              setDraft({ ...draft, [key]: event.target.value }),
          }),
        )
      return h(
        Dialog,
        {
          open: true,
          wide: true,
          title: '表情包',
          onOpenChange: (open: boolean) => (open ? undefined : onClose()),
          actions: trashed
            ? [
                h(
                  Button,
                  { key: 'restore', busy, onClick: () => void run('library.restore', { id: sticker.id }) },
                  '恢复',
                ),
              ]
            : [
                h(
                  Button,
                  {
                    key: 'remove',
                    variant: 'ghost',
                    busy,
                    onClick: () => void run('library.remove', { id: sticker.id }),
                  },
                  '移进回收站',
                ),
                h(
                  Button,
                  {
                    key: 'save',
                    variant: 'primary',
                    busy,
                    onClick: () => void run('library.update', { id: sticker.id, ...draft }),
                  },
                  '保存',
                ),
              ],
        },
        h(
          'div',
          { className: cls('stk-detail') },
          h(
            'div',
            { className: cls('stk-detail-image') },
            h('img', { src: host.assetUrl(sticker.id), alt: sticker.meaning }),
          ),
          h(
            'div',
            { className: cls('stk-fields') },
            error === undefined ? null : h(InlineFeedback, { tone: 'error' }, error),
            h(
              Field,
              { label: '用途', hint: '表达什么、适合在什么情况下发；智能体主要按它来找' },
              h(Textarea, {
                value: draft.meaning,
                rows: 2,
                disabled: trashed,
                onChange: (event: { readonly target: { readonly value: string } }) =>
                  setDraft({ ...draft, meaning: event.target.value }),
              }),
            ),
            field('caption', '图中文字'),
            field('description', '画面'),
            field('tags', '标签', '用顿号或空格分隔'),
            h(
              Field,
              { label: '在哪些群使用' },
              h(Select, {
                value: draft.scope,
                disabled: trashed,
                options: [
                  { value: 'public', label: '所有群（流通）' },
                  { value: 'local', label: '只在出现过它的群' },
                ],
                onValueChange: (value: string) => setDraft({ ...draft, scope: value === 'local' ? 'local' : 'public' }),
              }),
            ),
            h(
              PropertyList,
              null,
              h(PropertyRow, { label: '出现过的群' }, channelList(sticker.sources)),
              h(
                PropertyRow,
                { label: '发到过的群' },
                channelList(sticker.sentTo.filter((id) => !sticker.sources.includes(id))),
              ),
              h(
                PropertyRow,
                { label: '来源' },
                sticker.origin === 'import' ? '导入' : `${sticker.collectorName ?? '智能体'}收藏`,
              ),
              h(PropertyRow, { label: '发送次数' }, String(sticker.sentCount)),
              h(PropertyRow, { label: '大小' }, `${megabytes(sticker.byteSize)}${sticker.frames > 1 ? ' · 动图' : ''}`),
            ),
          ),
        ),
      )
    }

    const ImportDialog = ({
      relabel,
      onClose,
      onChanged,
    }: {
      /** 为已在库里、还没写用途的图补写，而不是上传新图。 */
      readonly relabel: boolean
      readonly onClose: () => void
      readonly onChanged: () => void
    }) => {
      const [files, setFiles] = React.useState<readonly ExtensionUploadFile[]>([])
      const [models, setModels] = React.useState<readonly ModelOption[] | undefined>(undefined)
      const [model, setModel] = React.useState(NO_MODEL)
      const [upload, setUpload] = React.useState<{ sent: number; total: number } | undefined>(undefined)
      const [uploadSkipped, setUploadSkipped] = React.useState<readonly string[]>([])
      const [status, setStatus] = React.useState<ImportStatus | undefined>(undefined)
      const [error, setError] = React.useState<string | undefined>(undefined)
      React.useEffect(() => {
        void host.call('import.models').then((value) => {
          const list = Array.isArray(value) ? (value as unknown as readonly ModelOption[]) : []
          setModels(list)
          if (list[0]) setModel(list[0].ref)
        })
        void host.call('import.status').then((value) => {
          const current = record(value)
          if (current['state'] === 'running') setStatus(current as unknown as ImportStatus)
        })
      }, [])
      const running = status?.state === 'running'
      React.useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => {
          void host.call('import.status').then((value) => {
            const next = record(value) as unknown as ImportStatus
            setStatus(next)
            if (next.state !== 'running') onChanged()
          })
        }, 1500)
        return () => clearInterval(timer)
      }, [running])

      const start = async () => {
        setError(undefined)
        try {
          let items: { assetId: string; name: string }[] = []
          if (relabel) {
            for (let offset = 0; ; offset += 120) {
              const page = record(await host.call('library.list', { view: 'unlabeled', offset, limit: 120 }))
              const batch = (Array.isArray(page['items']) ? page['items'] : []).map((item) => ({
                assetId: String(record(item)['id']),
                name: String(record(item)['description'] ?? ''),
              }))
              items = [...items, ...batch]
              if (batch.length < 120) break
            }
          } else {
            setUpload({ sent: 0, total: files.reduce((sum, file) => sum + file.size, 0) })
            const result = await host.upload(files, {
              onProgress: ({ sentBytes, totalBytes }) => setUpload({ sent: sentBytes, total: totalBytes }),
            })
            setUploadSkipped(result.skipped.map(({ name, reason }) => `${name}：${reason}`))
            items = result.added.map(({ assetId, name }) => ({ assetId, name }))
          }
          const started = record(await host.call('import.start', { items, ...(model === NO_MODEL ? {} : { model }) }))
          if (started['ok'] === false) throw new Error(String(started['message']))
          setStatus(record(started['job']) as unknown as ImportStatus)
        } catch (reason) {
          setError(message(reason))
          setUpload(undefined)
        }
      }

      const visionModels = models ?? []
      const progress = (done: number, total: number) =>
        h(
          'div',
          {
            className: cls('stk-progress'),
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': total,
            'aria-valuenow': done,
          },
          h('div', {
            className: cls('stk-progress-bar'),
            style: { width: `${total === 0 ? 100 : (done / total) * 100}%` },
          }),
        )
      const body =
        status !== undefined
          ? h(
              Stack,
              null,
              h(
                'p',
                null,
                status.state === 'running'
                  ? `正在${model === NO_MODEL ? '整理' : '补写用途与配文'}：${status.done + status.failed} / ${status.total}`
                  : status.state === 'cancelled'
                    ? '已取消。已经处理的图片留在库里。'
                    : `完成：处理了 ${status.done} 张${status.skipped > 0 ? `，${status.skipped} 张已在库里` : ''}${status.failed > 0 ? `，${status.failed} 张没有补写成功（图片已收下，可以之后再补写）` : ''}。`,
              ),
              status.state === 'running' ? progress(status.done + status.failed, status.total) : null,
              [...uploadSkipped, ...status.errors].length > 0
                ? h(
                    'ul',
                    { className: cls('stk-errors') },
                    ...[...uploadSkipped, ...status.errors].slice(0, 8).map((line) => h('li', { key: line }, line)),
                  )
                : null,
            )
          : upload !== undefined
            ? h(
                Stack,
                null,
                h('p', null, `正在上传 ${megabytes(upload.sent)} / ${megabytes(upload.total)}`),
                progress(upload.sent, upload.total),
              )
            : h(
                Stack,
                null,
                error === undefined ? null : h(InlineFeedback, { tone: 'error' }, error),
                relabel
                  ? h('p', null, '用所选的模型看一遍库里还没写用途的图，补上用途、图中文字和标签。')
                  : h(
                      Field,
                      { label: '图片或压缩包', hint: '可以多选，也可以选包含图片的 zip；单张图片最大 20 MB' },
                      h('input', {
                        type: 'file',
                        multiple: true,
                        className: cls('stk-file'),
                        accept: 'image/png,image/jpeg,image/gif,image/webp,.zip,application/zip',
                        onChange: (event: {
                          readonly target: { readonly files: ArrayLike<ExtensionUploadFile> | null }
                        }) => setFiles(Array.from(event.target.files ?? [])),
                      }),
                    ),
                h(
                  Field,
                  {
                    label: '补写用途的模型',
                    hint:
                      visionModels.length === 0
                        ? '没有可用的视觉模型，导入的图只有文件名可供搜索；在「设置 → 模型」添加支持视觉的模型后再导入效果更好。'
                        : '模型看过每张图后写下用途、图中文字和标签，并判断能否在群之间流通。每张图调用一次，计入所选模型的用量。',
                  },
                  h(Select, {
                    value: model,
                    options: [
                      ...visionModels.map((option) => ({
                        value: option.ref,
                        label: `${option.name} · ${option.providerName}`,
                      })),
                      { value: NO_MODEL, label: '不补写' },
                    ],
                    onValueChange: setModel,
                  }),
                ),
              )
      return h(
        Dialog,
        {
          open: true,
          title: relabel ? '补写用途' : '导入表情包',
          onOpenChange: (open: boolean) => (open ? undefined : onClose()),
          actions: running
            ? [
                h(
                  Button,
                  { key: 'cancel', variant: 'ghost', onClick: () => void host.call('import.cancel') },
                  '取消导入',
                ),
              ]
            : status !== undefined
              ? [h(Button, { key: 'close', onClick: onClose }, '完成')]
              : [
                  h(Button, { key: 'close', variant: 'ghost', onClick: onClose }, '取消'),
                  h(
                    Button,
                    {
                      key: 'start',
                      variant: 'primary',
                      busy: upload !== undefined,
                      disabled: relabel ? model === NO_MODEL : files.length === 0,
                      onClick: () => void start(),
                    },
                    relabel ? '开始补写' : `导入${files.length > 0 ? ` ${files.length} 个文件` : ''}`,
                  ),
                ],
        },
        body,
      )
    }

    const LibraryPage = () => {
      const [overview, setOverview] = React.useState<Overview | undefined>(undefined)
      const [view, setView] = React.useState<View>('all')
      const [query, setQuery] = React.useState('')
      const [items, setItems] = React.useState<readonly Sticker[] | undefined>(undefined)
      const [total, setTotal] = React.useState(0)
      const [selected, setSelected] = React.useState<Sticker | undefined>(undefined)
      const [importing, setImporting] = React.useState<'upload' | 'relabel' | undefined>(undefined)
      const [error, setError] = React.useState<string | undefined>(undefined)
      const [revision, setRevision] = React.useState(0)
      const refresh = React.useCallback(() => setRevision((value) => value + 1), [])

      React.useEffect(() => {
        void host
          .call('library.overview')
          .then((value) => setOverview(value as unknown as Overview))
          .catch((reason: unknown) => setError(message(reason)))
      }, [revision])
      React.useEffect(() => {
        // 输入停顿一会儿再搜索。
        const timer = setTimeout(() => {
          void host
            .call('library.list', { view, query, limit: 60 })
            .then((value) => {
              const page = record(value)
              setItems((Array.isArray(page['items']) ? page['items'] : []) as unknown as readonly Sticker[])
              setTotal(Number(page['total']) || 0)
              setError(undefined)
            })
            .catch((reason: unknown) => setError(message(reason)))
        }, 250)
        return () => clearTimeout(timer)
      }, [view, query, revision])

      const loadMore = async () => {
        const page = record(await host.call('library.list', { view, query, offset: items?.length ?? 0, limit: 60 }))
        setItems([...(items ?? []), ...((Array.isArray(page['items']) ? page['items'] : []) as unknown as Sticker[])])
      }

      const header = h(PageHeader, {
        title: '表情包',
        meta: '智能体在群里收藏的表情包。通用的图在群之间流通，群里特有的只在原来的群用；智能体发图前会先确认内容。',
        actions: [
          overview !== undefined && overview.unlabeled > 0
            ? h(
                Button,
                { key: 'relabel', variant: 'ghost', onClick: () => setImporting('relabel') },
                `补写 ${overview.unlabeled} 张的用途`,
              )
            : null,
          h(Button, { key: 'import', variant: 'primary', onClick: () => setImporting('upload') }, '导入'),
        ],
      })

      const grid =
        items === undefined
          ? h(EmptyState, { title: '正在读取', loading: true })
          : items.length === 0
            ? h(EmptyState, {
                title: query ? '没有找到' : view === 'trash' ? '回收站是空的' : '还没有表情包',
                description: query
                  ? '换个说法试试，或者看看别的分类。'
                  : view === 'all'
                    ? '群里有人发表情包时，启用了本扩展的智能体会收藏合适的；也可以点「导入」批量添加。'
                    : undefined,
              })
            : h(
                Stack,
                null,
                h(
                  'div',
                  { className: cls('stk-grid') },
                  ...items.map((sticker) => h(Card, { key: sticker.id, sticker, onOpen: () => setSelected(sticker) })),
                ),
                items.length < total
                  ? h(
                      Button,
                      { variant: 'ghost', onClick: () => void loadMore() },
                      `再显示一些（还有 ${total - items.length} 张）`,
                    )
                  : null,
              )

      return h(
        Stack,
        null,
        header,
        error === undefined ? null : h(InlineFeedback, { tone: 'error' }, `读取失败：${error}`),
        overview === undefined
          ? null
          : h(
              MetricStrip,
              null,
              h(Metric, { label: '全部', value: String(overview.total) }),
              h(Metric, { label: '流通', value: String(overview.public) }),
              h(Metric, { label: '只在本群', value: String(overview.local) }),
              h(Metric, { label: '回收站', value: String(overview.trash) }),
            ),
        h(
          Section,
          null,
          h(
            Stack,
            null,
            h(Tabs, { label: '分类', options: VIEWS, value: view, onChange: (value: View) => setView(value) }),
            h(
              'div',
              { className: cls('stk-toolbar') },
              h(
                'div',
                { className: cls('stk-search') },
                h(Input, {
                  value: query,
                  placeholder: '按意思搜索，例如「有点委屈」',
                  'aria-label': '搜索表情包',
                  onChange: (event: { readonly target: { readonly value: string } }) => setQuery(event.target.value),
                }),
              ),
              overview === undefined
                ? null
                : h(Switch, {
                    label: '暂停流通',
                    checked: overview.paused,
                    onCheckedChange: (paused: boolean) =>
                      void host.call('library.settings', { paused }).then(() => refresh()),
                  }),
            ),
            overview?.paused === true
              ? h(InlineFeedback, { tone: 'warning' }, '已暂停流通：每个群只用在本群出现过的表情包。')
              : null,
            grid,
          ),
        ),
        selected === undefined
          ? null
          : h(Detail, {
              key: selected.id,
              sticker: selected,
              onClose: () => setSelected(undefined),
              onChanged: refresh,
            }),
        importing === undefined
          ? null
          : h(ImportDialog, {
              relabel: importing === 'relabel',
              onClose: () => setImporting(undefined),
              onChanged: refresh,
            }),
      )
    }

    const ChannelPanel = ({ anchor }: ExtensionPanelProps) => {
      const [settings, setSettings] = React.useState<{ collect: string; use: string; collected: number } | undefined>(
        undefined,
      )
      const [error, setError] = React.useState<string | undefined>(undefined)
      React.useEffect(() => {
        void host
          .call('channel.get', null, { anchor })
          .then((value) => setSettings(record(value) as unknown as { collect: string; use: string; collected: number }))
          .catch((reason: unknown) => setError(message(reason)))
      }, [anchor.id])
      const change = async (input: Record<string, string>) => {
        try {
          const next = record(await host.call('channel.set', input, { anchor }))
          if (next['ok'] === false) throw new Error(String(next['message']))
          setSettings({ ...(settings ?? { collected: 0 }), ...(next as unknown as { collect: string; use: string }) })
        } catch (reason) {
          setError(message(reason))
        }
      }
      if (settings === undefined) {
        return error === undefined
          ? h(EmptyState, { title: '正在读取', loading: true })
          : h(InlineFeedback, { tone: 'error' }, error)
      }
      return h(
        PropertyList,
        null,
        error === undefined ? null : h(InlineFeedback, { tone: 'error' }, error),
        h(
          PropertyRow,
          { label: '收藏', description: `这个群里收藏了 ${settings.collected} 张` },
          h(Select, {
            'aria-label': '在这个群收藏',
            value: settings.collect,
            options: [
              { value: 'auto', label: '由智能体判断能否流通' },
              { value: 'local', label: '收藏的只在本群用' },
              { value: 'off', label: '不收藏' },
            ],
            onValueChange: (collect: string) => void change({ collect }),
          }),
        ),
        h(
          PropertyRow,
          { label: '使用' },
          h(Select, {
            'aria-label': '在这个群使用',
            value: settings.use,
            options: [
              { value: 'all', label: '库里可用的' },
              { value: 'local', label: '只用本群出现过的' },
              { value: 'off', label: '不发表情包' },
            ],
            onValueChange: (use: string) => void change({ use }),
          }),
        ),
      )
    }

    ctx.panels.register(
      { id: 'channel', anchor: 'channel', title: '表情包', densities: ['compact', 'full'] },
      ChannelPanel,
    )
    ctx.pages.register(
      {
        page: {
          kind: 'host-page',
          entryId: 'library',
          title: '表情包',
          description: '智能体收藏的表情包：浏览、整理、批量导入',
          icon: {
            kind: 'svg',
            path: 'assets/library.svg',
            sha256: '3a238280dfa8efc3ad1dc4e6b2bcc58ea28f7c0c29e8b9950c7c2f54a6763dd2',
          },
          objectPane: 'hidden',
          startPath: '',
          rail: { order: 60 },
        },
      },
      LibraryPage,
    )
  },
}))
