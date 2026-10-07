import type { ExtensionJsonValue, NxtPlatformAction } from '@nekro-nxt/extension-sdk'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createTestHost } from '../../../tools/testing.js'
import factory from '../src/host.js'

const actions: readonly NxtPlatformAction[] = ['mute_member', 'kick_member', 'set_member_card'].map((name) => ({
  name,
  title: name,
  description: '测试管理动作',
  risk: 'admin',
  parameters: {},
}))
const inputs: Readonly<Record<string, Readonly<Record<string, ExtensionJsonValue>>>> = {
  mute_member: { memberId: 'mbr_ALICE', minutes: 10 },
  unmute_member: { memberId: 'mbr_ALICE' },
  kick_member: { memberId: 'mbr_ALICE' },
  set_member_card: { memberId: 'mbr_ALICE', card: '测试成员' },
}

describe('群管助手', () => {
  it('注册四个工具与固定授权约束', async () => {
    const host = await createTestHost(factory, { platformActions: actions })
    expect([...host.tools.keys()]).toEqual(Object.keys(inputs))
    const guide = host.prompts.static.get('group-admin-guide') ?? ''
    expect(guide).toContain('群主或管理员明确要求')
    expect(guide).toContain('执行前复述目标、动作与禁言时长')
    expect(guide).toContain('不得对机器人自身或群主')
    expect(guide.length).toBeLessThanOrEqual(500)
    expect(host.calls).toEqual([])
  })

  it('验证样例即使在支持动作的群中也不执行管理操作', async () => {
    const definition = JSON.parse(readFileSync(new URL('../extension.json', import.meta.url), 'utf8')) as {
      contributions: { name: string; verificationInput: Readonly<Record<string, ExtensionJsonValue>> }[]
    }
    const host = await createTestHost(factory, { platformActions: actions })
    for (const tool of definition.contributions) {
      expect((await host.call(tool.name, tool.verificationInput)).value).toMatchObject({ ok: false })
    }
    expect(host.calls).toEqual([])
  })

  it.each([1, 10, 43200])('把 %i 分钟转换为秒后调用禁言', async (minutes) => {
    const host = await createTestHost(factory, { platformActions: actions })
    const catalog = vi.spyOn(host.nxt.platform, 'actions')
    const { value, text } = await host.call('mute_member', { memberId: 'mbr_ALICE', minutes })
    expect(value).toMatchObject({ ok: true })
    expect(text).toContain(`禁言 mbr_ALICE ${minutes} 分钟`)
    expect(catalog).toHaveBeenCalledOnce()
    expect(host.calls).toEqual([
      { kind: 'invoke', target: 'mute_member', input: { memberId: 'mbr_ALICE', seconds: minutes * 60 } },
    ])
  })

  it.each([0, -1, 1.5, 43201, '10', null])('拒绝非法禁言时长 %s', async (minutes) => {
    const host = await createTestHost(factory, { platformActions: actions })
    expect((await host.call('mute_member', { memberId: 'mbr_ALICE', minutes })).text).toContain('1 到 43200')
    expect(host.calls).toEqual([])
  })

  it('没有时长时不使用默认禁言值', async () => {
    const host = await createTestHost(factory, { platformActions: actions })
    expect((await host.call('mute_member', { memberId: 'mbr_ALICE' })).value).toMatchObject({ ok: false })
    expect(host.calls).toEqual([])
  })

  it('解除禁言复用 mute_member 的零秒参数', async () => {
    const host = await createTestHost(factory, { platformActions: actions })
    expect((await host.call('unmute_member', inputs['unmute_member'])).text).toContain('解除 mbr_ALICE 的禁言')
    expect(host.calls).toEqual([
      { kind: 'invoke', target: 'mute_member', input: { memberId: 'mbr_ALICE', seconds: 0 } },
    ])
  })

  it('移出成员允许重新申请', async () => {
    const host = await createTestHost(factory, { platformActions: actions })
    const { value, text } = await host.call('kick_member', inputs['kick_member'])
    expect(value).toMatchObject({ ok: true })
    expect(text).toContain('移出 mbr_ALICE')
    expect(host.calls).toEqual([
      { kind: 'invoke', target: 'kick_member', input: { memberId: 'mbr_ALICE', rejectRejoin: false } },
    ])
  })

  it.each(['测试成员', '', '  保留原文  ', '名'.repeat(80)])('原样设置或清除群名片', async (card) => {
    const host = await createTestHost(factory, { platformActions: actions })
    const { value, text } = await host.call('set_member_card', { memberId: 'mbr_ALICE', card })
    expect(value).toMatchObject({ ok: true })
    expect(text).toContain(card === '' ? '清除' : '设置')
    expect(host.calls).toEqual([{ kind: 'invoke', target: 'set_member_card', input: { memberId: 'mbr_ALICE', card } }])
  })

  it.each([null, 123, '名'.repeat(81)])('拒绝无效群名片', async (card) => {
    const host = await createTestHost(factory, { platformActions: actions })
    expect((await host.call('set_member_card', { memberId: 'mbr_ALICE', card })).text).toContain('最多 80 字')
    expect(host.calls).toEqual([])
  })

  it.each(['mute_member', 'unmute_member', 'kick_member', 'set_member_card'])(
    '%s 拒绝昵称与无效成员 ID',
    async (name) => {
      const host = await createTestHost(factory, { platformActions: actions })
      for (const memberId of ['爱丽丝', 'mbr_', 'mbr_ALICE!', '', 123]) {
        expect((await host.call(name, { ...inputs[name], memberId })).text).toContain('成员 ID')
      }
      expect(host.calls).toEqual([])
    },
  )

  it.each(Object.keys(inputs))('%s 先检查动作列表，不支持时不调用平台', async (name) => {
    const host = await createTestHost(factory)
    const catalog = vi.spyOn(host.nxt.platform, 'actions')
    expect((await host.call(name, inputs[name])).text).toContain('当前频道不支持')
    expect(catalog).toHaveBeenCalledOnce()
    expect(host.calls).toEqual([])
  })

  it.each(['direct', 'internal'] as const)('在 %s 频道先拒绝，不查询动作列表', async (kind) => {
    const host = await createTestHost(factory, {
      platformActions: actions,
      context: { channel: { id: 'chn_TEST', kind } },
    })
    const catalog = vi.spyOn(host.nxt.platform, 'actions')
    for (const name of Object.keys(inputs)) {
      expect((await host.call(name, inputs[name])).text).toContain('只在群聊中可用')
    }
    expect(catalog).not.toHaveBeenCalled()
    expect(host.calls).toEqual([])
  })

  it('动作查询或上下文查询出错时返回中文错误', async () => {
    const host = await createTestHost(factory, { platformActions: actions })
    vi.spyOn(host.nxt.platform, 'actions').mockRejectedValueOnce(new Error('连接不可用'))
    expect((await host.call('unmute_member', inputs['unmute_member'])).text).toContain('连接不可用')
    vi.spyOn(host.nxt.context, 'current').mockRejectedValueOnce('频道不可用')
    expect((await host.call('unmute_member', inputs['unmute_member'])).text).toContain('频道不可用')
    expect(host.calls).toEqual([])
  })

  it.each(['failed', 'unknown'] as const)('不把 %s 回执误报为成功', async (status) => {
    const host = await createTestHost(factory, { platformActions: actions })
    const invoke = vi.spyOn(host.nxt.platform, 'invoke').mockResolvedValueOnce({ status, message: '测试平台回执' })
    const { value, text } = await host.call('kick_member', inputs['kick_member'])
    expect(value).toMatchObject({ ok: false })
    expect(text).toContain('测试平台回执')
    if (status === 'unknown') expect(text).toContain('结果不确定，请先核实')
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('调用抛错时说明操作没有执行，原因截断为 200 字', async () => {
    const host = await createTestHost(factory, { platformActions: actions })
    const invoke = vi.spyOn(host.nxt.platform, 'invoke').mockRejectedValueOnce(new Error('参数无效'.repeat(100)))
    const { value, text } = await host.call('kick_member', inputs['kick_member'])
    expect(value).toMatchObject({ ok: false })
    expect(text).toBe(`操作没有执行：${'参数无效'.repeat(50)}`)
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('保留预览模式回执，避免声称真实动作已完成', async () => {
    const host = await createTestHost(factory, { platformActions: actions })
    vi.spyOn(host.nxt.platform, 'invoke').mockResolvedValueOnce({
      status: 'succeeded',
      message: '预览模式：未执行真实平台动作。',
    })
    expect((await host.call('unmute_member', inputs['unmute_member'])).text).toContain('未执行真实平台动作')
  })
})
