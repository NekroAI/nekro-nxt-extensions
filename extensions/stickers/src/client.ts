import {
  defineClientExtension,
  type ExtensionJsonValue,
  type ExtensionPanelProps,
  type ExtensionUploadFile,
} from '@nekro-nxt/extension-sdk'
import styles from '../assets/client.module.css'

/**
 * 「表情包」页面与频道面板：页面浏览、搜索、编辑和批量导入，面板设置单个频道的收集与使用范围。
 * 图片通过 `host.assetUrl` 显示，导入时先用 `host.upload` 把图片或压缩包放进扩展资源库，再交给本机实例标注。
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
  readonly model?: string
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
  { value: 'public', label: '公共' },
  { value: 'local', label: '仅限来源频道' },
  { value: 'flowed', label: '跨频道发送' },
  { value: 'unlabeled', label: '未标注' },
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

    /** 来源频道的名字；频道已删除时如实显示。 */
    const ChannelName = ({ id }: { readonly id: string }) =>
      h('span', null, ctx.data.useChannel(id)?.name ?? '已删除的频道')

    // 对话框渲染在页面容器之外，扩展 CSS 的作用域到不了，那里的布局用内联样式（只引用设计变量）。
    const inline = {
      detail: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 'var(--s-5)',
        alignItems: 'start',
      },
      detailImage: {
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 'var(--s-3)',
        borderRadius: 'var(--r-2)',
        background: 'var(--inset)',
      },
      detailPicture: { maxWidth: '100%', maxHeight: '240px', objectFit: 'contain' },
      fields: { display: 'flex', flexDirection: 'column', gap: 'var(--s-3)', minWidth: 0 },
      facts: {
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        gap: 'var(--s-1) var(--s-3)',
        margin: 0,
        font: 'var(--t-note)',
        color: 'var(--fg-2)',
      },
      factLabel: { color: 'var(--muted)', whiteSpace: 'nowrap' },
      factValue: { margin: 0, overflowWrap: 'anywhere' },
      progress: { height: '6px', overflow: 'hidden', borderRadius: 'var(--r-1)', background: 'var(--inset)' },
      progressBar: { height: '100%', background: 'var(--accent-fill)', transition: 'width 200ms ease-out' },
      chooser: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--s-3)' },
      note: { margin: 0, color: 'var(--muted)', font: 'var(--t-note)' },
      errors: { margin: 0, paddingLeft: 'var(--s-5)', color: 'var(--muted)', font: 'var(--t-note)' },
    } as const

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
          'aria-label': sticker.description || sticker.caption || '未标注的表情包',
        },
        h(
          'span',
          { className: cls('stk-thumb') },
          h('img', { src: host.assetUrl(sticker.id, { thumbnail: true }), alt: '', loading: 'lazy' }),
        ),
        h(
          'span',
          {
            className:
              sticker.description || sticker.caption ? cls('stk-meaning') : `${cls('stk-meaning')} ${cls('stk-muted')}`,
          },
          sticker.description || sticker.caption || '未标注',
        ),
        h(
          'span',
          { className: cls('stk-badges') },
          sticker.frames > 1 ? h(StatusBadge, { tone: 'info' }, '动图') : null,
          sticker.scope === 'local' ? h(StatusBadge, { tone: 'neutral' }, '仅限来源频道') : null,
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
                  '移入回收站',
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
          { style: inline.detail },
          h(
            'div',
            { style: inline.detailImage },
            h('img', { src: host.assetUrl(sticker.id), alt: sticker.description, style: inline.detailPicture }),
          ),
          h(
            'div',
            { style: inline.fields },
            error === undefined ? null : h(InlineFeedback, { tone: 'error' }, error),
            h(
              Field,
              { label: '用途', hint: '表达的情绪和适用场合' },
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
              { label: '使用范围' },
              h(Select, {
                value: draft.scope,
                disabled: trashed,
                options: [
                  { value: 'public', label: '公共' },
                  { value: 'local', label: '仅限来源频道' },
                ],
                onValueChange: (value: string) => setDraft({ ...draft, scope: value === 'local' ? 'local' : 'public' }),
              }),
            ),
            h(
              'dl',
              { style: inline.facts },
              ...(
                [
                  ['来源频道', channelList(sticker.sources)],
                  ['跨频道发送', channelList(sticker.sentTo.filter((id) => !sticker.sources.includes(id)))],
                  ['添加方式', sticker.origin === 'import' ? '导入' : `${sticker.collectorName ?? '智能体'}收集`],
                  ['发送次数', String(sticker.sentCount)],
                  ['大小', `${megabytes(sticker.byteSize)}${sticker.frames > 1 ? ' · 动图' : ''}`],
                ] as const
              ).flatMap(([label, value]) => [
                h('dt', { key: `${label}-label`, style: inline.factLabel }, label),
                h('dd', { key: `${label}-value`, style: inline.factValue }, value),
              ]),
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
      /** 标注已在库里的未标注图片，而不是上传新图。 */
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
      const picker = React.useRef<{ click(): void } | null>(null)
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
            style: inline.progress,
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': total,
            'aria-valuenow': done,
          },
          h('div', {
            style: { ...inline.progressBar, width: `${total === 0 ? 100 : (done / total) * 100}%` },
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
                  ? `正在${status.model ? '标注' : '导入'}：${status.done + status.failed} / ${status.total}`
                  : status.state === 'cancelled'
                    ? '已取消，已处理的图片会保留。'
                    : `已完成：${status.done} 张${status.skipped > 0 ? `，${status.skipped} 张已存在` : ''}${status.failed > 0 ? `，${status.failed} 张标注失败，可稍后重新标注` : ''}。`,
              ),
              status.state === 'running' ? progress(status.done + status.failed, status.total) : null,
              [...uploadSkipped, ...status.errors].length > 0
                ? h(
                    'ul',
                    { style: inline.errors },
                    ...[...uploadSkipped, ...status.errors].slice(0, 8).map((line) => h('li', { key: line }, line)),
                  )
                : null,
            )
          : upload !== undefined
            ? h(
                Stack,
                null,
                h('p', null, `正在上传：${megabytes(upload.sent)} / ${megabytes(upload.total)}`),
                progress(upload.sent, upload.total),
              )
            : h(
                Stack,
                null,
                error === undefined ? null : h(InlineFeedback, { tone: 'error' }, error),
                relabel
                  ? h('p', null, '用所选模型标注全部未标注的表情包。')
                  : h(
                      Field,
                      { label: '图片或压缩包', hint: '支持多选和 zip，单张不超过 20 MB' },
                      h(
                        'div',
                        { style: inline.chooser },
                        h(
                          Button,
                          { variant: 'ghost', onClick: () => picker.current?.click() },
                          files.length === 0 ? '选择文件' : '重新选择',
                        ),
                        h(
                          'span',
                          { style: inline.note },
                          files.length === 0
                            ? '未选择文件'
                            : `已选 ${files.length} 个文件，共 ${megabytes(files.reduce((sum, file) => sum + file.size, 0))}`,
                        ),
                        h('input', {
                          ref: picker,
                          type: 'file',
                          multiple: true,
                          hidden: true,
                          accept: 'image/png,image/jpeg,image/gif,image/webp,.zip,application/zip',
                          onChange: (event: {
                            readonly target: { readonly files: ArrayLike<ExtensionUploadFile> | null }
                          }) => setFiles(Array.from(event.target.files ?? [])),
                        }),
                      ),
                    ),
                h(
                  Field,
                  {
                    label: '标注模型',
                    hint:
                      visionModels.length === 0
                        ? '没有可用的视觉模型，可在「设置 → 模型」中添加。'
                        : '每张图调用一次模型，计入该模型的用量。',
                  },
                  h(Select, {
                    value: model,
                    options: [
                      ...visionModels.map((option) => ({
                        value: option.ref,
                        label: `${option.name} · ${option.providerName}`,
                      })),
                      { value: NO_MODEL, label: '不标注' },
                    ],
                    onValueChange: setModel,
                  }),
                ),
              )
      return h(
        Dialog,
        {
          open: true,
          title: relabel ? '批量标注' : '导入表情包',
          onOpenChange: (open: boolean) => (open ? undefined : onClose()),
          actions: running
            ? [
                h(
                  Button,
                  { key: 'cancel', variant: 'ghost', onClick: () => void host.call('import.cancel') },
                  '取消导入',
                ),
                // 导入在本机实例里进行，关掉窗口或浏览器都不影响。
                h(Button, { key: 'background', variant: 'primary', onClick: onClose }, '在后台继续'),
              ]
            : status !== undefined
              ? [h(Button, { key: 'close', onClick: onClose }, '关闭')]
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
                    relabel ? '开始标注' : `导入${files.length > 0 ? ` ${files.length} 个文件` : ''}`,
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
      const [job, setJob] = React.useState<ImportStatus | undefined>(undefined)

      // 导入在后台进行时，页面上显示进度，并随着进度刷新列表。
      React.useEffect(() => {
        if (importing !== undefined) return undefined
        let last = -1
        const check = () =>
          void host
            .call('import.status')
            .then((value) => {
              const next = value === null ? undefined : (record(value) as unknown as ImportStatus)
              setJob(next?.state === 'running' ? next : undefined)
              const progress = next === undefined ? -1 : next.done + next.failed + (next.state === 'running' ? 0 : 1)
              if (last >= 0 && progress !== last) refresh()
              last = progress
            })
            .catch(() => undefined)
        check()
        const timer = setInterval(check, 3000)
        return () => clearInterval(timer)
      }, [importing])

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
        actions: [
          job === undefined && overview !== undefined && overview.unlabeled > 0
            ? h(
                Button,
                { key: 'relabel', variant: 'ghost', onClick: () => setImporting('relabel') },
                `批量标注（${overview.unlabeled}）`,
              )
            : null,
          job === undefined
            ? h(Button, { key: 'import', variant: 'primary', onClick: () => setImporting('upload') }, '导入')
            : h(
                Button,
                { key: 'import', variant: 'ghost', onClick: () => setImporting('upload') },
                `正在导入 ${job.done + job.failed} / ${job.total}`,
              ),
        ],
      })

      const grid =
        items === undefined
          ? h(EmptyState, { title: '正在加载', loading: true })
          : items.length === 0
            ? h(EmptyState, {
                title: query ? '没有匹配的表情包' : view === 'trash' ? '回收站为空' : '还没有表情包',
                description: query
                  ? '换个关键词试试。'
                  : view === 'all'
                    ? '智能体会在聊天中自动收集，也可以批量导入。'
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
                      `加载更多（剩余 ${total - items.length} 张）`,
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
              h(Metric, { label: '公共', value: String(overview.public) }),
              h(Metric, { label: '仅限来源频道', value: String(overview.local) }),
              h(Metric, { label: '回收站', value: String(overview.trash) }),
            ),
        h(
          Section,
          null,
          h(
            Stack,
            null,
            // 窄屏上标签条放不下，换成下拉选择；两者由 CSS 按宽度显示其一。
            h(
              'div',
              { className: cls('stk-tabs') },
              h(Tabs, { label: '分类', options: VIEWS, value: view, onChange: (value: View) => setView(value) }),
            ),
            h(
              'div',
              { className: cls('stk-view-select') },
              h(Select, {
                'aria-label': '分类',
                value: view,
                options: VIEWS,
                onValueChange: (value: string) => setView(value as View),
              }),
            ),
            h(
              'div',
              { className: cls('stk-toolbar') },
              h(
                'div',
                { className: cls('stk-search') },
                h(Input, {
                  value: query,
                  placeholder: '按情绪或场景搜索，如「有点委屈」',
                  'aria-label': '搜索表情包',
                  onChange: (event: { readonly target: { readonly value: string } }) => setQuery(event.target.value),
                }),
              ),
              overview === undefined
                ? null
                : h(
                    'span',
                    { className: cls('stk-pause') },
                    h('span', { 'aria-hidden': true }, '暂停跨频道使用'),
                    h(Switch, {
                      label: '暂停跨频道使用',
                      checked: overview.paused,
                      onCheckedChange: (paused: boolean) =>
                        void host.call('library.settings', { paused }).then(() => refresh()),
                    }),
                  ),
            ),
            overview?.paused === true
              ? h(InlineFeedback, { tone: 'warning' }, '已暂停跨频道使用，各频道只使用自己收集的表情包。')
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
          ? h(EmptyState, { title: '正在加载', loading: true })
          : h(InlineFeedback, { tone: 'error' }, error)
      }
      return h(
        PropertyList,
        null,
        error === undefined ? null : h(InlineFeedback, { tone: 'error' }, error),
        h(
          PropertyRow,
          { label: '收集', description: `本频道已收集 ${settings.collected} 张` },
          h(Select, {
            'aria-label': '本频道的收集方式',
            value: settings.collect,
            options: [
              { value: 'auto', label: '由智能体判断是否公共' },
              { value: 'local', label: '全部仅限本频道' },
              { value: 'off', label: '不收集' },
            ],
            onValueChange: (collect: string) => void change({ collect }),
          }),
        ),
        h(
          PropertyRow,
          { label: '使用' },
          h(Select, {
            'aria-label': '本频道的使用范围',
            value: settings.use,
            options: [
              { value: 'all', label: '公共和本频道的' },
              { value: 'local', label: '仅本频道的' },
              { value: 'off', label: '不使用' },
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
          description: '浏览、整理和导入表情包',
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
