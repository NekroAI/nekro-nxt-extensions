import { describe, expect, it, vi } from 'vitest'
import { createTestHost } from '../../../tools/testing.js'
import factory from '../src/host.js'

const fixedRandom = (...values: number[]) =>
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    const next = values.shift() ?? 0
    ;(array as Uint32Array)[0] = next
    return array
  })

describe('掷骰与抽签', () => {
  it('registers three tools without any host capability', async () => {
    const host = await createTestHost(factory)
    expect([...host.tools.keys()]).toEqual(['roll_dice', 'check_d100', 'draw_lots'])
    expect(host.calls).toEqual([])
  })

  it('rolls dice expressions with modifiers', async () => {
    const host = await createTestHost(factory)
    // 0 → 1 点，5 → 6 点（6 面骰）
    const spy = fixedRandom(0, 5)
    const { value, text } = await host.call('roll_dice', { expression: '2d6 + 3', label: '伤害' })
    spy.mockRestore()
    expect(value).toMatchObject({ ok: true, total: 10, expression: '2d6+3', label: '伤害' })
    expect(text).toBe('伤害：2d6+3 = 10（2d6: 1 6，修正 +3）')
  })

  it('explains invalid expressions instead of throwing', async () => {
    const host = await createTestHost(factory)
    expect((await host.call('roll_dice', { expression: 'abc' })).text).toContain('看不懂')
    expect((await host.call('roll_dice', { expression: '101d6' })).text).toContain('最多掷 100')
    expect((await host.call('roll_dice', { expression: '1d1' })).text).toContain('面数至少 2')
    expect((await host.call('roll_dice', { expression: '5' })).text).toContain('至少要有一个骰子')
    expect((await host.call('roll_dice', {})).text).toContain('请提供')
  })

  it('grades d100 checks', async () => {
    const host = await createTestHost(factory)
    const grade = async (raw: number, target = 60) => {
      const spy = fixedRandom(raw)
      const { value } = await host.call('check_d100', { target })
      spy.mockRestore()
      return value
    }
    expect(await grade(0)).toMatchObject({ roll: 1, result: '大成功' })
    expect(await grade(9)).toMatchObject({ roll: 10, result: '极难成功' })
    expect(await grade(29)).toMatchObject({ roll: 30, result: '困难成功' })
    expect(await grade(59)).toMatchObject({ roll: 60, result: '成功' })
    expect(await grade(60)).toMatchObject({ roll: 61, result: '失败' })
    expect(await grade(97)).toMatchObject({ roll: 98, result: '大失败' })
    expect((await host.call('check_d100', { target: 0 })).text).toContain('1 到 100')
  })

  it('draws distinct options', async () => {
    const host = await createTestHost(factory)
    const { value } = await host.call('draw_lots', { options: ['甲', '乙', '丙', '乙'], count: 3 })
    expect(value).toMatchObject({ ok: true, from: 3 })
    expect(new Set((value as { picked: string[] }).picked).size).toBe(3)
    expect((await host.call('draw_lots', { options: ['甲'] })).text).toContain('两个不同')
    expect((await host.call('draw_lots', { options: ['甲', '乙'], count: 5 })).text).toContain('1 到 2')
  })
})
