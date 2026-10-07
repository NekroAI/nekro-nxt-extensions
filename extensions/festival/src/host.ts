import { defineHostExtension, type ExtensionJsonValue } from '@nekro-nxt/extension-sdk'

/**
 * 节日提醒：固定任务在 Manifest 声明，factory 注册 onJob，普通日不唤醒智能体。
 * 查询与提醒共用同一份节日表，不联网、不建运行时任务、不直接发言。
 */
type Festival = {
  readonly date: string
  readonly name: string
  readonly customs: string
}
type UpcomingArgs = { readonly days?: number }
type UpcomingResult =
  | {
      readonly ok: true
      readonly from: string
      readonly through: string
      readonly festivals: readonly Festival[]
      readonly lunarCoverage: string
    }
  | { readonly ok: false; readonly message: string }
type FixedFestival = {
  readonly monthDay: string
  readonly name: string
  readonly customs: string
  readonly international?: boolean
}

const DAY_MS = 86_400_000
const JOB_ID = 'festival-morning'
const LUNAR_COVERAGE = '农历节日日期表覆盖公历 2026–2035 年；范围外只列出和提醒公历固定节日。'
const FIXED: readonly FixedFestival[] = [
  { monthDay: '01-01', name: '元旦', customs: '迎接公历新年，可以互道新年好、分享新年小计划。' },
  {
    monthDay: '02-14',
    name: '情人节',
    customs: '向在意的人表达感谢和关心，尊重每个人的相处方式。',
    international: true,
  },
  {
    monthDay: '03-08',
    name: '妇女节',
    customs: '尊重女性的贡献与选择，可以送上平等、真诚的祝福。',
    international: true,
  },
  { monthDay: '03-12', name: '植树节', customs: '关注身边的绿意，可以参与植树或照顾一盆植物。' },
  { monthDay: '05-01', name: '劳动节', customs: '感谢劳动者的付出，也给自己安排适当的休息。', international: true },
  { monthDay: '05-04', name: '青年节', customs: '关注青年的成长与探索，可以分享一个想尝试的新目标。' },
  { monthDay: '06-01', name: '儿童节', customs: '祝愿孩子健康快乐，也可以聊聊童年的游戏和故事。', international: true },
  { monthDay: '09-10', name: '教师节', customs: '感谢教导与陪伴过自己的人，可以分享一段学习中的回忆。' },
  { monthDay: '10-01', name: '国庆节', customs: '庆祝中华人民共和国成立，可以交流出游计划或送上节日祝福。' },
  {
    monthDay: '12-25',
    name: '圣诞节',
    customs: '有些人会互赠礼物、布置装饰或相聚，按群聊习惯送上祝福即可。',
    international: true,
  },
]
const LUNAR = [
  { name: '春节', customs: '农历正月初一；拜年、团聚，互道新春祝福，各地习俗有所不同。' },
  { name: '元宵节', customs: '农历正月十五；赏灯、猜灯谜，吃汤圆或元宵。' },
  { name: '端午节', customs: '农历五月初五；吃粽子、观看龙舟比赛，一些地方会挂艾草。' },
  { name: '七夕', customs: '农历七月初七；传统有乞巧习俗，也常用来表达珍惜与关心。' },
  { name: '中秋节', customs: '农历八月十五；赏月、吃月饼，向亲友表达团圆的祝愿。' },
  { name: '重阳节', customs: '农历九月初九；登高、赏菊，也可以关心长辈、送上问候。' },
  { name: '除夕', customs: '农历岁末最后一天；吃年夜饭、贴春联、团聚迎新。' },
] as const

/**
 * 香港天文台公历与农历对照表，按公历年分组：
 * https://www.hko.gov.hk/en/gts/time/conversion1_text.htm
 * 年度文本 T2026e.txt … T2035e.txt。
 * 顺序：春节、元宵、端午、七夕、中秋、重阳、除夕；不重复计入闰月，除夕是春节前一天。
 */
const LUNAR_DATES: Readonly<Record<number, readonly string[]>> = {
  2026: ['02-17', '03-03', '06-19', '08-19', '09-25', '10-18', '02-16'],
  2027: ['02-06', '02-20', '06-09', '08-08', '09-15', '10-08', '02-05'],
  2028: ['01-26', '02-09', '05-28', '08-26', '10-03', '10-26', '01-25'],
  2029: ['02-13', '02-27', '06-16', '08-16', '09-22', '10-16', '02-12'],
  2030: ['02-03', '02-17', '06-05', '08-05', '09-12', '10-05', '02-02'],
  2031: ['01-23', '02-06', '06-24', '08-24', '10-01', '10-24', '01-22'],
  2032: ['02-11', '02-25', '06-12', '08-12', '09-19', '10-12', '02-10'],
  2033: ['01-31', '02-14', '06-01', '08-01', '09-08', '10-01', '01-30'],
  2034: ['02-19', '03-05', '06-20', '08-20', '09-27', '10-20', '02-18'],
  2035: ['02-08', '02-22', '06-10', '08-10', '09-16', '10-09', '02-07'],
}

const dateAt = (timestamp: number): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

const hourAt = (timestamp: number): number =>
  Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(timestamp),
    ),
  )

/** 把上海的日历日期当作 UTC 日期做加减，只用于日历运算，不受宿主时区影响。 */
const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

const includesInternational = (config: ExtensionJsonValue): boolean => {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    return (config as Record<string, ExtensionJsonValue>)['includeInternational'] !== false
  }
  return true
}

const onDate = (date: string, international: boolean): readonly Festival[] => {
  const monthDay = date.slice(5)
  const fixed = FIXED.filter((item) => item.monthDay === monthDay && (international || !item.international)).map(
    (item) => ({ date, name: item.name, customs: item.customs }),
  )
  const lunar = (LUNAR_DATES[Number(date.slice(0, 4))] ?? []).flatMap((day, index) => {
    const item = LUNAR[index]
    return day === monthDay && item ? [{ date, ...item }] : []
  })
  return [...fixed, ...lunar]
}

const render = (value: UpcomingResult): string => {
  if (!value.ok) return value.message
  const lines = value.festivals.map((item) => `${item.date} ${item.name}：${item.customs}`)
  return `${value.from} 至 ${value.through}（上海日期，含起止日）：\n${lines.length ? lines.join('\n') : '这段时间没有收录的节日。'}\n${value.lunarCoverage}`
}

export default defineHostExtension(async ({ harness }) => {
  // 按 SDK 在 factory 阶段注册一次；宿主负责固定计划和到期去重。
  harness.onJob?.((job) => {
    // 内置频道没有群友，不需要问候。
    if (job.declaredId !== JOB_ID || job.channel.kind === 'internal') return { wake: false }
    const today = dateAt(job.firedAt)
    // 宿主离线多日后，错过的触发会合并为一次补跑，scheduledAt 是最早错过的那次。
    // 补跑发生在今天 08:00 之后，说明今天的提醒也被合并进来了，按今天处理；早于 08:00 则等今天的正常触发。
    if (dateAt(job.scheduledAt) !== today && hourAt(job.firedAt) < 8) return { wake: false }
    const festivals = onDate(today, includesInternational(harness.config?.() ?? {}))
    if (festivals.length === 0) return { wake: false }
    return {
      note: `今天（上海日期 ${today}）是${festivals.map((item) => item.name).join('、')}。\n${festivals.map((item) => `${item.name}：${item.customs}`).join('\n')}\n请智能体结合聊天氛围自行决定是否问候、如何问候，不必强制发言。`,
    }
  })
  return {
    inject: ['tools'],
    apply(ctx) {
      harness.registerTool(
        ctx,
        harness.defineTool<UpcomingArgs, UpcomingResult>({
          name: 'upcoming_festivals',
          description:
            '查询近期节日名称、公历日期与习俗要点。days 为 1–90 的整数，默认 30；范围包含上海日期的今天，共 days 天。农历日期仅覆盖 2026–2035 年，国际节日按配置开关筛选。',
          parameters: { days: { type: 'integer', description: '包含今天在内的查询天数，1–90，默认 30' } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: render(value) }] },
          execute: ({ days }) => {
            const wanted = days === undefined ? 30 : days
            if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 1 || wanted > 90) {
              return { ok: false, message: '查询天数需要是 1 到 90 的整数，不填写时默认 30 天。' }
            }
            const from = dateAt(Date.now())
            const international = includesInternational(harness.config?.() ?? {})
            const festivals = Array.from({ length: wanted }, (_entry, index) =>
              onDate(addDays(from, index), international),
            ).flat()
            return { ok: true, from, through: addDays(from, wanted - 1), festivals, lunarCoverage: LUNAR_COVERAGE }
          },
        }),
      )
    },
  }
})
