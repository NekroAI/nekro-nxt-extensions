import { defineHostExtension, type ExtensionJsonValue } from '@nekro-nxt/extension-sdk'

/**
 * 今日运势：成员 ID 与上海日期决定结果，同一天无论抽几次都相同；成员存储只记录连续签到天数。
 * 卡片只创建 Asset，由智能体决定是否发送到频道。
 */
type DrawArgs = Record<string, never>
type Fortune = {
  readonly date: string
  readonly level: string
  readonly luckyNumber: number
  readonly good: readonly string[]
  readonly avoid: readonly string[]
}
type DrawResult =
  | {
      readonly ok: true
      readonly member: string
      readonly fortune: Fortune
      readonly streak: number
      readonly assetId: string
    }
  | { readonly ok: false; readonly message: string }

const LEVELS = ['元气满格', '顺风顺水', '稳步向前', '小有惊喜', '从容蓄力']
const GOOD = [
  '给自己留一段散步时间',
  '把好点子记在纸上',
  '认真夸夸身边的人',
  '先完成一件小事',
  '为喜欢的事情腾点空',
  '向朋友分享一个笑话',
  '试试一种新的做法',
  '给努力的自己点个赞',
]
const AVOID = [
  '把休息排在最后',
  '拿别人的进度催自己',
  '空着肚子赶任务',
  '给小失误贴大标签',
  '一次答应太多事情',
  '没听完就急着下结论',
  '让未读消息占满心情',
  '为完美迟迟不开始',
]
const STORAGE_KEY = 'checkin'
const DAY_MS = 86_400_000

const shanghaiDate = (time = Date.now()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(time))
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** FNV-1a 的 32 位整数运算，保持跨进程、跨宿主的可重复性；不用于安全用途。 */
const hash = (text: string): number => {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193)
  }
  return value >>> 0
}

const pair = (pool: readonly string[], seed: string): readonly string[] => {
  const first = hash(`${seed}:first`) % pool.length
  const offset = 1 + (hash(`${seed}:second`) % (pool.length - 1))
  return [pool[first] as string, pool[(first + offset) % pool.length] as string]
}

const generate = (memberId: string, date: string): Fortune => {
  const seed = `${memberId}:${date}`
  return {
    date,
    level: LEVELS[hash(`${seed}:level`) % LEVELS.length] as string,
    luckyNumber: 1 + (hash(`${seed}:number`) % 99),
    good: pair(GOOD, `${seed}:good`),
    avoid: pair(AVOID, `${seed}:avoid`),
  }
}

/** 连续签到：昨天签过则加一，今天已签保持不变，否则从 1 开始。 */
const nextStreak = (saved: ExtensionJsonValue | undefined, today: string, yesterday: string): number => {
  const entry = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  const last = 'lastDate' in entry ? entry['lastDate'] : undefined
  const streak = 'streak' in entry && typeof entry['streak'] === 'number' ? entry['streak'] : 0
  if (last === today) return Math.max(1, streak)
  return last === yesterday ? streak + 1 : 1
}

const xml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const card = (fortune: Fortune, displayName: string, streak: number): string => {
  // 昵称先去控制字符、限制长度，再转义；所有其他文字来自内置表或日期。
  const name = [...displayName.replaceAll(/[\u0000-\u001f\u007f]/gu, '').trim()].slice(0, 12).join('') || '群友'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="560" viewBox="0 0 640 560">
  <rect width="640" height="560" rx="28" fill="#f7f4ed"/>
  <rect x="24" y="24" width="592" height="512" rx="20" fill="#ffffff"/>
  <circle cx="550" cy="130" r="60" fill="#edf5ec"/>
  <circle cx="550" cy="130" r="35" fill="#d8e8d4"/>
  <g font-family="sans-serif" fill="#273c32">
    <text x="52" y="68" font-size="20" fill="#697a6c">今日运势 · ${fortune.date}</text>
    <text x="52" y="112" font-size="24">${xml(name)}</text>
    <text x="52" y="185" font-size="48" font-weight="700">${xml(fortune.level)}</text>
    <text x="52" y="230" font-size="22" fill="#697a6c">幸运数字 ${fortune.luckyNumber} · 连续签到 ${streak} 天</text>
    <path d="M52 258H588" stroke="#e7ece5"/>
    <text x="52" y="296" font-size="23" font-weight="700">宜</text>
    ${fortune.good.map((line, index) => `<text x="104" y="${296 + index * 36}" font-size="22">${xml(line)}</text>`).join('')}
    <text x="52" y="390" font-size="23" font-weight="700" fill="#8b6547">忌</text>
    ${fortune.avoid.map((line, index) => `<text x="104" y="${390 + index * 36}" font-size="22" fill="#8b6547">${xml(line)}</text>`).join('')}
    <text x="52" y="492" font-size="18" fill="#7e897f">仅供娱乐，今天的节奏由你自己决定。</text>
  </g>
</svg>`
}

const render = (value: DrawResult): string => {
  if (!value.ok) return value.message
  const fortune = value.fortune
  return `${value.member} 的 ${fortune.date} 今日运势：${fortune.level}；幸运数字 ${fortune.luckyNumber}；连续签到 ${value.streak} 天。\n宜：${fortune.good.join('；')}。\n忌：${fortune.avoid.join('；')}。\n仅供娱乐。图片 assetId：${value.assetId}；请智能体用 send_channel_message 的 image 块发送这张图片。`
}

export default defineHostExtension(async ({ harness }) => ({
  inject: ['tools', 'nxt'],
  apply(ctx) {
    const nxt = ctx.nxt
    if (!nxt) throw new Error('今日运势需要宿主能力 nxt。')
    harness.registerTool(
      ctx,
      harness.defineTool<DrawArgs, DrawResult>({
        name: 'draw_fortune',
        description:
          '为频道里最近一位发言成员生成今日运势与 PNG 卡片，并记录连续签到天数，无需参数。同一成员在上海日期的同一天结果固定。结果里的 member 是被抽取的成员，转述前请确认就是请求的人。仅供娱乐，由智能体用 send_channel_message 发送返回的 assetId。',
        parameters: {},
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: render(value) }] },
        execute: async () => {
          try {
            const sender = (await nxt.context.current()).latestInbound?.sender
            if (!sender?.memberId)
              return { ok: false, message: '当前没有可识别的发言成员。请在有成员发言的群聊或私聊中抽取今日运势。' }
            const now = Date.now()
            const date = shanghaiDate(now)
            const scope = { scope: 'member' as const, memberId: sender.memberId }
            const streak = nextStreak(await nxt.storage.get(STORAGE_KEY, scope), date, shanghaiDate(now - DAY_MS))
            await nxt.storage.set(STORAGE_KEY, { lastDate: date, streak }, scope)
            const fortune = generate(sender.memberId, date)
            const member = sender.displayName ?? '群友'
            const image = await nxt.render.svg(card(fortune, member, streak), { format: 'png' })
            const asset = await nxt.assets.create({
              base64: image.base64,
              mediaType: image.mediaType,
              name: `fortune-${date}.png`,
            })
            return { ok: true, member, fortune, streak, assetId: asset.assetId }
          } catch {
            return {
              ok: false,
              message: '今日运势生成失败，暂时无法保存签到或生成图片，请稍后重试。当天的运势不会因重试而改变。',
            }
          }
        },
      }),
    )
  },
}))
