import { describe, expect, it } from 'vitest'
import { createTestHost } from '../../../tools/testing.js'
import factory from '../src/host.js'

describe('消息守卫', () => {
  it('默认规则为空，不增加工具或改变入站决定', async () => {
    const host = await createTestHost(factory)
    expect(await host.inbound({ text: '普通消息' })).toBeUndefined()
    expect(await host.inbound({ text: '', wouldTrigger: false })).toBeUndefined()
    expect(host.tools.size).toBe(0)
    expect(host.calls).toEqual([])
    expect(host.prompts.static.size).toBe(0)
  })

  it('屏蔽关键词隐藏且抑制触发，即使消息提及智能体', async () => {
    const host = await createTestHost(factory, { config: { blockedKeywords: ['测试广告'] } })
    const decision = await host.inbound({ text: '这里有测试广告', mentionsAgent: true, wouldTrigger: true })
    expect(decision).toEqual({ trigger: 'suppress', hideFromAgent: true })
    expect(decision?.annotation).toBeUndefined()
  })

  it('静默关键词只抑制触发，保留消息可见性且不附加标注', async () => {
    const host = await createTestHost(factory, { config: { silentKeywords: ['测试闲聊'] } })
    expect(await host.inbound({ text: '测试闲聊：一段普通内容', mentionsAgent: true })).toEqual({ trigger: 'suppress' })
  })

  it('唤醒关键词在未提及时也强制触发', async () => {
    const host = await createTestHost(factory, { config: { wakeKeywords: ['请回答'] } })
    expect(await host.inbound({ text: '智能体请回答这个测试问题', mentionsAgent: false, wouldTrigger: false })).toEqual(
      { trigger: 'force' },
    )
  })

  it.each([
    { text: '屏蔽 静默 唤醒', expected: { trigger: 'suppress', hideFromAgent: true } },
    { text: '屏蔽 唤醒', expected: { trigger: 'suppress', hideFromAgent: true } },
    { text: '静默 唤醒', expected: { trigger: 'suppress' } },
  ])('按屏蔽 > 静默 > 唤醒处理「$text」', async ({ text, expected }) => {
    const host = await createTestHost(factory, {
      config: { blockedKeywords: ['屏蔽'], silentKeywords: ['静默'], wakeKeywords: ['唤醒'] },
    })
    const decision = await host.inbound({ text, wouldTrigger: false })
    expect(decision).toMatchObject(expected)
    if (!('hideFromAgent' in expected)) expect(decision?.hideFromAgent).toBeUndefined()
  })

  it.each(['blockedKeywords', 'silentKeywords', 'wakeKeywords'])(
    '%s 对消息与关键词同时规范化大小写、全角和半角',
    async (field) => {
      const host = await createTestHost(factory, { config: { [field]: ['ＴｅＳｔ', 'ｶﾞｰﾄﾞ'] } })
      for (const text of ['test', 'TEST', 'ＴＥｓｔ', 'ガード']) {
        const decision = await host.inbound({ text, mentionsAgent: false, wouldTrigger: false })
        expect(decision?.trigger).toBe(field === 'wakeKeywords' ? 'force' : 'suppress')
        expect(decision?.hideFromAgent).toBe(field === 'blockedKeywords' ? true : undefined)
      }
    },
  )

  it('忽略空项与重复规则，不把空字符串匹配到所有消息', async () => {
    const host = await createTestHost(factory, {
      config: { blockedKeywords: ['', ' ', '　'], wakeKeywords: ['  TEST  ', 'ｔｅｓｔ'] },
    })
    expect(await host.inbound({ text: '普通消息' })).toBeUndefined()
    expect(await host.inbound({ text: 'test', wouldTrigger: false })).toEqual({ trigger: 'force' })
  })

  it('使用普通包含匹配，不把关键词解释为正则表达式', async () => {
    const host = await createTestHost(factory, { config: { blockedKeywords: ['a.b'] } })
    expect(await host.inbound({ text: 'aXb' })).toBeUndefined()
    expect(await host.inbound({ text: 'prefix a.b suffix' })).toEqual({ trigger: 'suppress', hideFromAgent: true })
  })

  it('未命中时保留默认触发策略，不强制唤醒也不压制正常提及', async () => {
    const host = await createTestHost(factory, {
      config: { blockedKeywords: ['屏蔽'], silentKeywords: ['静默'], wakeKeywords: ['唤醒'] },
    })
    expect(await host.inbound({ text: '普通消息', mentionsAgent: true, wouldTrigger: true })).toBeUndefined()
    expect(await host.inbound({ text: '普通消息', mentionsAgent: false, wouldTrigger: false })).toBeUndefined()
    expect(host.calls).toEqual([])
  })
})
