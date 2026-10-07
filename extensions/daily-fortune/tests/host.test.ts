import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestHost } from '../../../tools/testing.js'
import factory from '../src/host.js'

type Success = {
  ok: true
  member: string
  fortune: { date: string; level: string; luckyNumber: number; good: string[]; avoid: string[] }
  streak: number
  assetId: string
}

const at = (iso: string) => vi.setSystemTime(new Date(iso))
const draw = async (host: Awaited<ReturnType<typeof createTestHost>>) =>
  (await host.call('draw_fortune')).value as Success

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-07T10:00:00+08:00')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('今日运势', () => {
  it('returns a PNG card, the member and a short sending hint', async () => {
    const host = await createTestHost(factory)
    const { value, text } = await host.call('draw_fortune')
    const result = value as Success
    expect(result).toMatchObject({ ok: true, member: '爱丽丝', streak: 1, fortune: { date: '2026-10-07' } })
    expect(result.fortune.luckyNumber).toBeGreaterThanOrEqual(1)
    expect(result.fortune.luckyNumber).toBeLessThanOrEqual(99)
    expect(new Set(result.fortune.good).size).toBe(2)
    expect(new Set(result.fortune.avoid).size).toBe(2)
    expect(host.assets[0]).toMatchObject({ mediaType: 'image/png', name: 'fortune-2026-10-07.png' })
    const svg = Buffer.from(host.assets[0]?.base64 ?? '', 'base64').toString()
    expect(svg).toContain('font-family="sans-serif"')
    expect(svg).toContain('爱丽丝')
    expect(svg).toContain('连续签到 1 天')
    expect(svg).not.toMatch(/href=|<!DOCTYPE|<image/u)
    expect(text).toContain('爱丽丝 的 2026-10-07 今日运势')
    expect(text).toContain('send_channel_message')
    expect(host.calls).toEqual([])
  })

  it('keeps the same fortune within a day and changes it the next day', async () => {
    const host = await createTestHost(factory)
    const first = await draw(host)
    expect((await draw(host)).fortune).toEqual(first.fortune)
    // 不依赖存储：新的宿主实例同一天也得到相同结果。
    expect((await draw(await createTestHost(factory))).fortune).toEqual(first.fortune)
    at('2026-10-08T00:00:01+08:00')
    expect((await draw(host)).fortune.date).toBe('2026-10-08')
  })

  it('counts consecutive check-in days per member', async () => {
    const host = await createTestHost(factory)
    expect((await draw(host)).streak).toBe(1)
    expect((await draw(host)).streak).toBe(1)
    at('2026-10-08T09:00:00+08:00')
    expect((await draw(host)).streak).toBe(2)
    at('2026-10-10T09:00:00+08:00')
    expect((await draw(host)).streak).toBe(1)
    expect(host.storage.get('member:mbr_ALICE:checkin')?.value).toEqual({ lastDate: '2026-10-10', streak: 1 })
    const bob = await createTestHost(factory, {
      context: {
        latestInbound: { logicalMessageId: 'msg_B', sender: { memberId: 'mbr_BOB' }, text: '运势', receivedAt: 1 },
      },
    })
    expect((await draw(bob)).member).toBe('群友')
  })

  it('escapes display names in the card', async () => {
    const host = await createTestHost(factory, {
      context: {
        latestInbound: {
          logicalMessageId: 'msg_X',
          sender: { memberId: 'mbr_X', displayName: '<b>&"昵称"\u0007很长很长很长很长很长' },
          text: '抽',
          receivedAt: 1,
        },
      },
    })
    await draw(host)
    const svg = Buffer.from(host.assets[0]?.base64 ?? '', 'base64').toString()
    expect(svg).toContain('&lt;b&gt;&amp;&quot;昵称&quot;')
    expect(svg).not.toContain('<b>')
  })

  it('explains when there is no sender or the card cannot be made', async () => {
    const noSender = await createTestHost(factory, {
      context: { latestInbound: { logicalMessageId: 'msg_N', text: '系统消息', receivedAt: 1 } },
    })
    expect((await noSender.call('draw_fortune')).text).toContain('没有可识别的发言成员')
    const broken = await createTestHost(factory)
    vi.spyOn(broken.nxt.render, 'svg').mockRejectedValue(new Error('字体缺失'))
    expect((await broken.call('draw_fortune')).text).toContain('今日运势生成失败')
  })
})
