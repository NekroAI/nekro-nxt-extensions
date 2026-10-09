import { defineHostExtension, type NxtFetchResponse, type NxtHostLayerService } from '@nekro-nxt/extension-sdk'

/**
 * 网页搜索：示范本机配置共用的凭据、按配置地址联网与静态提示。
 *
 * 示范要点：
 * - 搜索服务地址与 API Key 是本机配置（`config.host`），所有智能体共用一份；工具在智能体中注册，但联网与读凭据
 *   都经 factory 收到的本机层 `nxt`，网络权限写在 `permissions.host`；默认返回条数是每个智能体的 `config.agent`；
 * - 只有一个「搜索服务地址」字段，按地址判断服务商，网络权限声明为 `mode: 'config'`，宿主只放行这个地址；
 * - API Key 是 `meta.role: 'secret'` 字段，用 `nxt.secrets.get` 读取，没有填写时给出可读提示而不是报错；
 * - 结果截断到较短的摘要，控制占用的上下文；
 * - 静态提示只在版本或配置切换时变化，不破坏模型的提示词缓存。
 */

type Freshness = 'day' | 'week' | 'month' | 'year'
type SearchArgs = { readonly query?: string; readonly count?: number; readonly freshness?: string }
type SearchItem = {
  readonly title: string
  readonly url: string
  readonly snippet: string
  readonly published?: string
}
type SearchResult =
  | { readonly ok: true; readonly provider: string; readonly query: string; readonly results: readonly SearchItem[] }
  | { readonly ok: false; readonly message: string }

type Provider = 'bocha' | 'tavily' | 'searxng'

const PROVIDER_NAMES: Readonly<Record<Provider, string>> = { bocha: '博查', tavily: 'Tavily', searxng: 'SearXNG' }
const SNIPPET_CHARS = 300

const providerOf = (endpoint: URL): Provider =>
  endpoint.hostname === 'api.bochaai.com' ? 'bocha' : endpoint.hostname === 'api.tavily.com' ? 'tavily' : 'searxng'

const clip = (value: unknown): string => {
  const text = typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim() : ''
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const parseJson = (response: NxtFetchResponse): unknown => {
  try {
    return JSON.parse(response.text ?? '')
  } catch {
    return undefined
  }
}

const item = (title: unknown, url: unknown, snippet: unknown, published: unknown): SearchItem | undefined => {
  if (typeof url !== 'string' || !/^https?:\/\//u.test(url)) return undefined
  return {
    title: clip(title) || url,
    url,
    snippet: clip(snippet),
    ...(typeof published === 'string' && published ? { published: published.slice(0, 10) } : {}),
  }
}

const search = async (
  nxt: NxtHostLayerService,
  endpoint: URL,
  apiKey: string | undefined,
  query: string,
  count: number,
  freshness: Freshness | undefined,
): Promise<SearchResult> => {
  const provider = providerOf(endpoint)
  if (provider !== 'searxng' && !apiKey) {
    return { ok: false, message: `还没有配置${PROVIDER_NAMES[provider]}的 API Key，请在扩展配置中填写后再搜索。` }
  }
  let response: NxtFetchResponse
  if (provider === 'bocha') {
    const bochaFreshness = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' } as const
    response = await nxt.http.fetch(new URL('/v1/web-search', endpoint).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        count,
        summary: true,
        freshness: freshness ? bochaFreshness[freshness] : 'noLimit',
      }),
    })
  } else if (provider === 'tavily') {
    response = await nxt.http.fetch(new URL('/search', endpoint).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, max_results: count, ...(freshness ? { time_range: freshness } : {}) }),
    })
  } else {
    const url = new URL('search', endpoint.toString().endsWith('/') ? endpoint : `${endpoint.toString()}/`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    if (freshness) url.searchParams.set('time_range', freshness)
    response = await nxt.http.fetch(url.toString(), { headers: { accept: 'application/json' } })
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message:
        provider === 'searxng'
          ? 'SearXNG 拒绝了请求，请确认实例允许 JSON 格式（search.formats 包含 json）。'
          : `${PROVIDER_NAMES[provider]}拒绝了请求，请检查 API Key 是否正确、额度是否用完。`,
    }
  }
  if (response.status >= 400) return { ok: false, message: `${PROVIDER_NAMES[provider]}返回错误 ${response.status}。` }
  const body = record(parseJson(response))
  const raw =
    provider === 'bocha'
      ? record(record(body['data'])['webPages'])['value']
      : provider === 'tavily'
        ? body['results']
        : body['results']
  const entries = Array.isArray(raw) ? raw.map(record) : []
  const results = entries
    .map((entry) =>
      provider === 'bocha'
        ? item(entry['name'], entry['url'], entry['summary'] ?? entry['snippet'], entry['datePublished'])
        : provider === 'tavily'
          ? item(entry['title'], entry['url'], entry['content'], entry['published_date'])
          : item(entry['title'], entry['url'], entry['content'], entry['publishedDate']),
    )
    .filter((entry): entry is SearchItem => entry !== undefined)
    .slice(0, count)
  return { ok: true, provider: PROVIDER_NAMES[provider], query, results }
}

const render = (value: SearchResult): string => {
  if (!value.ok) return value.message
  if (value.results.length === 0) return `没有找到与「${value.query}」相关的结果。`
  const lines = value.results.map(
    (entry, index) =>
      `${index + 1}. ${entry.title}${entry.published ? `（${entry.published}）` : ''}\n   ${entry.url}${entry.snippet ? `\n   ${entry.snippet}` : ''}`,
  )
  return `「${value.query}」的搜索结果（${value.provider}）：\n${lines.join('\n')}`
}

export default defineHostExtension(async ({ harness, nxt: host }) => ({
  inject: ['tools', 'nxt'],
  apply(ctx) {
    const nxt = ctx.nxt
    if (!nxt) throw new Error('网页搜索需要宿主能力 nxt。')
    nxt.prompt.static(
      'web-search-guide',
      '需要最新信息、事实核对或你不确定的内容时，先用 web_search 搜索；回答时注明信息来源的链接，不要编造搜索结果中没有的内容。',
    )
    harness.registerTool(
      ctx,
      harness.defineTool<SearchArgs, SearchResult>({
        name: 'web_search',
        description:
          '搜索网络上的最新信息，返回标题、链接、摘要与发布时间。query 写成简洁的关键词；需要时效性时设置 freshness。',
        parameters: {
          query: { type: 'string', required: true, description: '搜索关键词' },
          count: { type: 'integer', description: '返回条数，1 到 10，默认取配置值' },
          freshness: {
            type: 'string',
            enum: ['day', 'week', 'month', 'year'],
            description: '只要最近一天、一周、一个月或一年内的结果',
          },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: render(value) }] },
        execute: async ({ query, count, freshness }) => {
          const keywords = typeof query === 'string' ? query.trim() : ''
          if (!keywords) return { ok: false, message: '请提供搜索关键词。' }
          const service = record(harness.config())
          let endpoint: URL
          try {
            endpoint = new URL(
              typeof service['endpoint'] === 'string' ? service['endpoint'] : 'https://api.bochaai.com',
            )
          } catch {
            return { ok: false, message: '扩展配置中的搜索服务地址无效，请填写完整的 https:// 地址。' }
          }
          const maxResults = record(ctx.config())['maxResults']
          const fallback = typeof maxResults === 'number' ? maxResults : 5
          const wanted = Math.min(10, Math.max(1, Math.round(typeof count === 'number' ? count : fallback)))
          const window = ['day', 'week', 'month', 'year'].includes(freshness ?? '')
            ? (freshness as Freshness)
            : undefined
          try {
            return await search(
              host,
              endpoint,
              await host.secrets.get('apiKey'),
              keywords.slice(0, 200),
              wanted,
              window,
            )
          } catch (error) {
            return {
              ok: false,
              message: `搜索失败：${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
            }
          }
        },
      }),
    )
  },
}))
