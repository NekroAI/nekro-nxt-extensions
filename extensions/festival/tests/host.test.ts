import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestHost } from '../../../tools/testing.js'
import factory from '../src/host.js'

const NAMES = ['春节', '元宵节', '端午节', '七夕', '中秋节', '重阳节', '除夕']
// 独立抽样核对：与香港天文台对照表一致的若干日期（含闰月年份与和国庆同日的情况）。
const lunarCases = [
  { date: '2026-02-17', name: '春节' },
  { date: '2026-06-19', name: '端午节' },
  { date: '2026-09-25', name: '中秋节' },
  { date: '2027-02-06', name: '春节' },
  { date: '2028-05-28', name: '端午节' },
  { date: '2030-02-02', name: '除夕' },
  { date: '2031-10-01', name: '中秋节' },
  { date: '2033-10-01', name: '重阳节' },
]
const at = (date: string) => Date.parse(date + 'T08:00:00+08:00')
const due = (date: string) => ({
  label: '节日早晨提醒',
  declaredId: 'festival-morning',
  scheduledAt: at(date),
  firedAt: at(date),
})
type Upcoming = {
  ok: true
  from: string
  through: string
  festivals: { date: string; name: string; customs: string }[]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-07T08:00:00+08:00'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('节日提醒', () => {
  it('只声明固定计划，没有运行时任务或额外权限', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../extension.json', import.meta.url), 'utf8'))
    expect(manifest.permissions.capabilities).toEqual({
      jobs: {
        declared: [{ id: 'festival-morning', label: '节日早晨提醒', cron: '0 8 * * *', timezone: 'Asia/Shanghai' }],
      },
    })
    const host = await createTestHost(factory)
    expect([...host.tools.keys()]).toEqual(['upcoming_festivals'])
    expect(host.jobs.size).toBe(0)
    expect(host.calls).toEqual([])
    expect(host.assets).toEqual([])
    expect(host.storage.size).toBe(0)
  })

  it('默认查询包含今天的 30 天，结果按日期排序', async () => {
    const host = await createTestHost(factory)
    const { value, text } = await host.call('upcoming_festivals')
    expect(value).toMatchObject({
      ok: true,
      from: '2026-10-07',
      through: '2026-11-05',
      festivals: [{ date: '2026-10-18', name: '重阳节' }],
    })
    expect(text).toContain('登高')
    expect(text).toContain('2026–2035')
    expect(text.length).toBeLessThan(500)
  })

  it('当天查询为一天，并显示空结果说明', async () => {
    const host = await createTestHost(factory)
    expect(await host.call('upcoming_festivals', { days: 1 })).toMatchObject({
      value: { ok: true, from: '2026-10-07', through: '2026-10-07', festivals: [] },
      text: expect.stringContaining('没有收录的节日'),
    })
  })

  it.each([0, -1, 91, 1.5, '30', null, true, Number.NaN, Number.POSITIVE_INFINITY])('拒绝非法天数 %s', async (days) => {
    const host = await createTestHost(factory)
    expect(await host.call('upcoming_festivals', { days })).toMatchObject({
      value: { ok: false },
      text: expect.stringContaining('1 到 90 的整数'),
    })
  })

  it('跨年查询包含第 90 天，排除第 91 天', async () => {
    const host = await createTestHost(factory)
    vi.setSystemTime(new Date('2026-11-19T08:00:00+08:00'))
    const full = (await host.call('upcoming_festivals', { days: 90 })).value as Upcoming
    expect(full.through).toBe('2027-02-16')
    expect(full.festivals.map((item) => item.name)).toEqual(['圣诞节', '元旦', '除夕', '春节', '情人节'])
    vi.setSystemTime(new Date('2026-11-22T08:00:00+08:00'))
    const edge = (await host.call('upcoming_festivals', { days: 90 })).value as Upcoming
    expect(edge.through).toBe('2027-02-19')
    expect(edge.festivals.some((item) => item.name === '元宵节')).toBe(false)
    vi.setSystemTime(new Date('2026-11-23T08:00:00+08:00'))
    expect(((await host.call('upcoming_festivals', { days: 90 })).value as Upcoming).festivals.at(-1)?.name).toBe(
      '元宵节',
    )
  })

  it('上海零点切换查询日期，不使用宿主当地日期', async () => {
    const host = await createTestHost(factory)
    vi.setSystemTime(new Date('2026-09-30T15:59:59Z'))
    expect(((await host.call('upcoming_festivals', { days: 1 })).value as Upcoming).from).toBe('2026-09-30')
    vi.setSystemTime(new Date('2026-09-30T16:00:00Z'))
    expect((await host.call('upcoming_festivals', { days: 1 })).value).toMatchObject({
      from: '2026-10-01',
      festivals: [{ name: '国庆节' }],
    })
  })

  it('关闭国际节日同时影响工具与任务，保留国内及农历节日', async () => {
    const enabled = await createTestHost(factory)
    const disabled = await createTestHost(factory, { config: { includeInternational: false } })
    for (const [date, name] of [
      ['2026-02-14', '情人节'],
      ['2026-03-08', '妇女节'],
      ['2026-05-01', '劳动节'],
      ['2026-06-01', '儿童节'],
      ['2026-12-25', '圣诞节'],
    ]) {
      vi.setSystemTime(new Date(at(date as string)))
      expect(((await enabled.call('upcoming_festivals', { days: 1 })).value as Upcoming).festivals[0]?.name).toBe(name)
      expect(((await disabled.call('upcoming_festivals', { days: 1 })).value as Upcoming).festivals).toEqual([])
      expect((await enabled.due(due(date as string)))?.note).toContain(name)
      expect(await disabled.due(due(date as string))).toEqual({ wake: false })
    }
    for (const date of ['2026-01-01', '2026-03-12', '2026-05-04', '2026-09-10', '2026-10-01', '2026-02-17']) {
      vi.setSystemTime(new Date(at(date)))
      expect(
        ((await disabled.call('upcoming_festivals', { days: 1 })).value as Upcoming).festivals.length,
      ).toBeGreaterThan(0)
      expect((await disabled.due(due(date)))?.note).toBeTruthy()
    }
  })

  it('同日多个节日全部查询与提醒，note 小于 2000 字', async () => {
    const host = await createTestHost(factory)
    vi.setSystemTime(new Date(at('2031-10-01')))
    const { value } = await host.call('upcoming_festivals', { days: 1 })
    expect((value as Upcoming).festivals.map((item) => item.name)).toEqual(['国庆节', '中秋节'])
    const decision = await host.due(due('2031-10-01'))
    expect(decision?.note).toContain('国庆节、中秋节')
    expect(decision?.note).toContain('自行决定')
    expect(decision?.note?.length).toBeLessThan(2000)
  })

  it.each(lunarCases)('$date $name 的查询与提醒符合天文台对照表', async ({ date, name }) => {
    const host = await createTestHost(factory)
    vi.setSystemTime(new Date(at(date)))
    const result = (await host.call('upcoming_festivals', { days: 1 })).value as Upcoming
    expect(result.festivals).toContainEqual(expect.objectContaining({ date, name, customs: expect.any(String) }))
    expect((await host.due(due(date)))?.note).toContain(name)
  })

  it.each([2026, 2028, 2033])('%s 全年恰好包含七个农历节日，没有在闰月重复提醒', async (year) => {
    const host = await createTestHost(factory)
    const names: string[] = []
    for (let offset = 0; offset < 366; offset += 90) {
      vi.setSystemTime(new Date(Date.UTC(year, 0, 1) + offset * 86_400_000))
      const result = (await host.call('upcoming_festivals', { days: 90 })).value as Upcoming
      names.push(
        ...result.festivals
          .filter((item) => NAMES.includes(item.name) && item.date.startsWith(String(year)))
          .map((item) => item.name),
      )
    }
    expect(names.sort()).toEqual([...NAMES].sort())
  })

  it.each([2025, 2036])('农历范围外 %s 年只提供公历节日', async (year) => {
    const host = await createTestHost(factory)
    vi.setSystemTime(new Date(at(year + '-01-01')))
    const { value, text } = await host.call('upcoming_festivals', { days: 90 })
    expect((value as Upcoming).festivals.map((item) => item.name)).toEqual(['元旦', '情人节', '妇女节', '植树节'])
    expect(text).toContain('范围外只列出')
    expect((await host.due(due(year + '-01-01')))?.note).toContain('元旦')
    expect(await host.due(due(year + '-01-28'))).toEqual({ wake: false })
  })

  it('stays quiet on ordinary days, other jobs and the internal channel', async () => {
    const host = await createTestHost(factory)
    expect(await host.due(due('2026-10-07'))).toEqual({ wake: false })
    expect(await host.due({ ...due('2026-10-01'), declaredId: 'other-job' })).toEqual({ wake: false })
    expect(await host.due({ ...due('2026-10-01'), channel: { id: 'chn_INTERNAL', kind: 'internal' } })).toEqual({
      wake: false,
    })
    expect((await host.due({ ...due('2026-10-01'), channel: { id: 'chn_DM', kind: 'direct' } }))?.note).toContain(
      '国庆节',
    )
  })

  it('handles catch-up runs after the Host was offline', async () => {
    const host = await createTestHost(factory)
    // 当天迟到仍提醒。
    expect(
      (await host.due({ ...due('2026-10-01'), firedAt: Date.parse('2026-10-01T23:00:00+08:00') }))?.note,
    ).toContain('国庆节')
    // 从前一天起离线，节日当天 10:00 才恢复：合并的补跑包含了今天的提醒。
    expect(
      (await host.due({ ...due('2026-09-30'), firedAt: Date.parse('2026-10-01T10:00:00+08:00') }))?.note,
    ).toContain('国庆节')
    // 节日当天 06:00 补跑前一天的计划：跳过，等今天 08:00 的正常触发，不重复问候。
    expect(await host.due({ ...due('2026-09-30'), firedAt: Date.parse('2026-10-01T06:00:00+08:00') })).toEqual({
      wake: false,
    })
    // 节日已过才补跑：不发送过期问候。
    expect(await host.due({ ...due('2026-10-01'), firedAt: Date.parse('2026-10-02T09:00:00+08:00') })).toEqual({
      wake: false,
    })
  })
})
