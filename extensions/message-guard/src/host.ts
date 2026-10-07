import { defineHostExtension, type NxtInboundDecision } from '@nekro-nxt/extension-sdk'

/**
 * 消息守卫：factory 阶段注册入站钩子，仅做本地、确定的文字匹配。
 *
 * Schemastery 字符串数组用 array + inner，不是 JSON Schema 的 items。
 * 屏蔽同时 suppress 与 hideFromAgent；静默只 suppress，不附加标注，避免持续占用上下文。
 * SDK 没有机器人身份字段，不能按昵称或 memberId 猜测发送者是否为机器人。
 */

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase()

const keywords = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => normalize(item).trim())
            .filter(Boolean),
        ),
      ]
    : []

export default defineHostExtension(async ({ harness }) => {
  const raw = harness.config?.() ?? {}
  const config =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Readonly<Record<string, unknown>>) : {}
  // 配置随 Activation 切换；一次注册预处理一次，不在每条消息上重复规范化规则。
  const blocked = keywords(config['blockedKeywords'])
  const silent = keywords(config['silentKeywords'])
  const wake = keywords(config['wakeKeywords'])

  harness.onInbound?.((message): NxtInboundDecision | undefined => {
    const text = normalize(message.text)
    if (blocked.some((word) => text.includes(word))) return { trigger: 'suppress', hideFromAgent: true }
    if (silent.some((word) => text.includes(word))) return { trigger: 'suppress' }
    if (wake.some((word) => text.includes(word))) return { trigger: 'force' }
    return undefined
  })
  return { apply() {} }
})
