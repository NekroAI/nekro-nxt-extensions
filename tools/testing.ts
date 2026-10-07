/**
 * 种子扩展的单元测试宿主：按 NekroNXT 的 Host 环境形状加载扩展，用内存替身代替网络、存储、模型与平台。
 *
 * 它只验证扩展自身的逻辑；权限声明、构建与导入验证由 `pnpm verify` 在真实 NekroNXT 上完成。
 */
import type {
  ExtensionHostContext,
  ExtensionHostEnvironment,
  ExtensionJsonValue,
  ExtensionPluginFactory,
  ExtensionRpcHandler,
  ExtensionToolDefinition,
  NxtCallContext,
  NxtFeed,
  NxtFetchInit,
  NxtFetchResponse,
  NxtHostService,
  NxtInboundDecision,
  NxtInboundHandler,
  NxtInboundMessage,
  NxtJobDecision,
  NxtJobDue,
  NxtJobHandler,
  NxtJobRecord,
  NxtJobScheduleInput,
  NxtLlmRequest,
  NxtParsedHtml,
  NxtPlatformAction,
  NxtPlatformResult,
  NxtRenderedImage,
  NxtStorageEntry,
  NxtStorageOptions,
} from '@nekro-nxt/extension-sdk'

export type FetchHandler = (url: string, init: NxtFetchInit) => NxtFetchResponse | Promise<NxtFetchResponse>

export interface TestHostOptions {
  readonly config?: Readonly<Record<string, ExtensionJsonValue>>
  readonly secrets?: Readonly<Record<string, string>>
  readonly fetch?: FetchHandler
  readonly context?: Partial<NxtCallContext>
  readonly llm?: (request: NxtLlmRequest) => string | Promise<string>
  readonly parseHtml?: (html: string) => NxtParsedHtml
  readonly parseFeed?: (xml: string) => NxtFeed
  readonly platformActions?: readonly NxtPlatformAction[]
  readonly now?: () => number
}

export interface RecordedCall {
  readonly kind: 'fetch' | 'invoke' | 'raw'
  readonly target: string
  readonly input: unknown
}

/** 构造一个文本响应；JSON 传对象即可。 */
export const respond = (body: unknown, init: { status?: number; contentType?: string } = {}): NxtFetchResponse => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    url: 'https://example.test/',
    status: init.status ?? 200,
    headers: {},
    contentType: init.contentType ?? (typeof body === 'string' ? 'text/plain' : 'application/json'),
    text,
  }
}

const DEFAULT_CONTEXT: NxtCallContext = {
  agent: { id: 'agt_TEST', name: '测试智能体' },
  channel: { id: 'chn_TEST', kind: 'group', displayName: '测试群' },
  latestInbound: {
    logicalMessageId: 'msg_TEST',
    sender: { memberId: 'mbr_ALICE', displayName: '爱丽丝' },
    text: '你好',
    receivedAt: 1_800_000_000_000,
  },
}

const storageKey = (key: string, options: NxtStorageOptions | undefined): string =>
  `${options?.scope ?? 'agent'}:${options?.memberId ?? ''}:${key}`

export const createTestHost = async (
  factory: ExtensionPluginFactory<ExtensionHostEnvironment>,
  options: TestHostOptions = {},
) => {
  const now = options.now ?? (() => 1_800_000_000_000)
  const config = options.config ?? {}
  const tools = new Map<string, ExtensionToolDefinition>()
  const rpc = new Map<string, ExtensionRpcHandler>()
  let inbound: NxtInboundHandler | undefined
  let job: NxtJobHandler | undefined
  const storage = new Map<string, NxtStorageEntry>()
  const assets: { assetId: string; mediaType: string; name?: string; base64?: string; text?: string }[] = []
  const prompts = { static: new Map<string, string>(), dynamic: new Map<string, () => string | Promise<string>>() }
  const jobs = new Map<string, NxtJobRecord & { payload?: ExtensionJsonValue }>()
  const calls: RecordedCall[] = []
  const context: NxtCallContext = { ...DEFAULT_CONTEXT, ...options.context }

  const unsupported = (what: string) => () =>
    Promise.reject(new Error(`测试宿主没有提供 ${what}，请在 createTestHost 中传入。`))

  const nxt: NxtHostService = {
    http: {
      fetch: async (url, init = {}) => {
        calls.push({ kind: 'fetch', target: url, input: init })
        if (!options.fetch) throw new Error(`测试宿主没有提供 fetch：${url}`)
        return options.fetch(url, init)
      },
    },
    secrets: { get: async (key) => options.secrets?.[key] },
    assets: {
      create: async (input) => {
        const record = {
          assetId: `ast_${assets.length + 1}`,
          mediaType: input.mediaType ?? 'application/octet-stream',
          byteSize: (input.base64 ?? input.text ?? '').length,
        }
        assets.push({ ...record, ...input })
        return record
      },
      fromUrl: unsupported('assets.fromUrl'),
    },
    storage: {
      get: async (key, scope) => storage.get(storageKey(key, scope))?.value,
      set: async (key, value, scope) => {
        storage.set(storageKey(key, scope), { key, value, updatedAt: now() })
      },
      delete: async (key, scope) => storage.delete(storageKey(key, scope)),
      list: async (listOptions) => {
        const prefix = storageKey(listOptions?.prefix ?? '', listOptions)
        const entries = [...storage.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, entry]) => entry)
        return { entries: entries.slice(0, listOptions?.limit ?? 50) }
      },
    },
    context: { current: async () => context },
    history: { list: async () => ({ messages: [] }), search: async () => [] },
    platform: {
      actions: async () => options.platformActions ?? [],
      invoke: async (action, args): Promise<NxtPlatformResult> => {
        calls.push({ kind: 'invoke', target: action, input: args })
        return { status: 'succeeded', message: '测试宿主已记录这次平台动作。' }
      },
      raw: async (api, params): Promise<NxtPlatformResult> => {
        calls.push({ kind: 'raw', target: api, input: params })
        return { status: 'succeeded', message: '测试宿主已记录这次原始调用。' }
      },
    },
    jobs: {
      schedule: async (input: NxtJobScheduleInput) => {
        const record = {
          jobId: `job_${jobs.size + 1}`,
          label: input.label,
          ...(input.cron === undefined ? {} : { cron: input.cron }),
          ...(input.at === undefined ? {} : { at: input.at, nextRunAt: input.at }),
          ...(input.payload === undefined ? {} : { payload: input.payload }),
        }
        jobs.set(record.jobId, record)
        return record
      },
      list: async () => [...jobs.values()],
      cancel: async (jobId) => jobs.delete(jobId),
    },
    llm: {
      complete: async (request) => {
        if (!options.llm) throw new Error('测试宿主没有提供 llm。')
        return { text: await options.llm(request) }
      },
    },
    render: {
      svg: async (svg): Promise<NxtRenderedImage> => ({
        base64: Buffer.from(svg).toString('base64'),
        mediaType: 'image/png',
        width: 100,
        height: 100,
        byteSize: svg.length,
      }),
    },
    parse: {
      html: async (html) => {
        if (!options.parseHtml) throw new Error('测试宿主没有提供 parseHtml。')
        return options.parseHtml(html)
      },
      feed: async (xml) => {
        if (!options.parseFeed) throw new Error('测试宿主没有提供 parseFeed。')
        return options.parseFeed(xml)
      },
    },
    prompt: {
      static: (name, text) => {
        prompts.static.set(name, text)
        return () => prompts.static.delete(name)
      },
      dynamic: (name, render) => {
        prompts.dynamic.set(name, () => render({ storage: nxt.storage, context }))
        return () => prompts.dynamic.delete(name)
      },
    },
  }

  const environment: ExtensionHostEnvironment = {
    harness: {
      defineTool: (tool) => tool,
      registerTool: (_context, tool) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      handle: (method, handler) => {
        rpc.set(method, handler)
        return () => rpc.delete(method)
      },
      registerAdapter: () => {
        throw new Error('测试宿主不支持适配器。')
      },
      onInbound: (handler) => {
        inbound = handler
        return () => (inbound = undefined)
      },
      onJob: (handler) => {
        job = handler
        return () => (job = undefined)
      },
      config: () => config,
    },
    config,
  }

  const plugin = await factory(environment)
  const hostContext: ExtensionHostContext & { effect: (fn: () => unknown) => void } = {
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    ...(plugin.inject?.includes('nxt') ? { nxt } : {}),
    effect: (fn) => {
      fn()
    },
  }
  await plugin.apply(hostContext)

  return {
    nxt,
    tools,
    calls,
    assets,
    jobs,
    prompts,
    storage,
    /** 像智能体一样调用工具，返回工具结果与渲染给模型的文本。 */
    async call(name: string, args: Readonly<Record<string, ExtensionJsonValue>> = {}) {
      const tool = tools.get(name)
      if (!tool) throw new Error(`没有注册工具 ${name}`)
      const value = await tool.execute(args)
      const text = tool.output
        .render(args, value)
        .map((block) => block.text)
        .join('\n')
      return { value, text }
    },
    async rpc(method: string, input: ExtensionJsonValue = null) {
      const handler = rpc.get(method)
      if (!handler) throw new Error(`没有注册 RPC ${method}`)
      return handler(input)
    },
    async inbound(
      message: Partial<NxtInboundMessage> & { readonly text: string },
    ): Promise<NxtInboundDecision | undefined> {
      if (!inbound) throw new Error('扩展没有注册入站处理函数。')
      return inbound(
        {
          logicalMessageId: 'msg_IN',
          channel: context.channel,
          sender: { memberId: 'mbr_ALICE', displayName: '爱丽丝' },
          mentionsAgent: false,
          wouldTrigger: true,
          receivedAt: now(),
          ...message,
        },
        nxt,
      )
    },
    async due(input: Partial<NxtJobDue> & { readonly label: string }): Promise<NxtJobDecision | undefined> {
      if (!job) throw new Error('扩展没有注册到期处理函数。')
      return job(
        {
          jobId: 'job_DUE',
          payload: null,
          scheduledAt: now(),
          firedAt: now(),
          channel: context.channel,
          ...input,
        },
        nxt,
      )
    },
    /** 渲染一次全部动态上下文。 */
    async renderDynamic(): Promise<Record<string, string>> {
      const rendered: Record<string, string> = {}
      for (const [name, render] of prompts.dynamic) rendered[name] = await render()
      return rendered
    },
  }
}
