import { defineHostExtension } from '@nekro-nxt/extension-sdk'

/**
 * 掷骰与抽签：最小的纯工具扩展，不需要任何宿主能力。
 *
 * 示范要点：
 * - 每个工具只做一件事，参数扁平，描述写清楚格式与上限；
 * - 输入不合法时返回 `{ ok: false, message }` 这样可读的结果，而不是抛出异常，智能体会据此向用户解释；
 * - `output.render` 决定模型看到的文字，结构化结果留给工具视图与测试。
 */

const MAX_DICE = 100
const MAX_SIDES = 1000

/** 宿主提供的安全随机数；[0, n) 内均匀分布。 */
const randomBelow = (n: number): number => {
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buffer = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buffer)
    const value = buffer[0] ?? 0
    if (value < limit) return value % n
  }
}

interface Term {
  readonly count: number
  readonly sides: number
  readonly sign: 1 | -1
}

type Parsed = { readonly ok: true; readonly dice: readonly Term[]; readonly modifier: number } | Failure
type Failure = { readonly ok: false; readonly message: string }

/** 支持 `NdM`、`dM`、`d%` 与整数加减，例如 `3d6+2`、`d20-1`、`2d8+1d4`。 */
const parseExpression = (raw: string): Parsed => {
  const expression = raw.replaceAll(/\s+/gu, '').toLowerCase()
  if (!/^[+-]?(\d*d(\d+|%)|\d+)([+-](\d*d(\d+|%)|\d+))*$/u.test(expression)) {
    return { ok: false, message: `看不懂「${raw}」。请用 3d6、d20、2d8+3 这样的写法。` }
  }
  const dice: Term[] = []
  let modifier = 0
  let total = 0
  for (const match of expression.matchAll(/([+-]?)(\d*d(?:\d+|%)|\d+)/gu)) {
    const sign = match[1] === '-' ? -1 : 1
    const body = match[2] ?? ''
    if (!body.includes('d')) {
      modifier += sign * Number(body)
      continue
    }
    const [countText, sidesText] = body.split('d')
    const count = countText === '' || countText === undefined ? 1 : Number(countText)
    const sides = sidesText === '%' ? 100 : Number(sidesText)
    if (count < 1 || sides < 2) return { ok: false, message: '骰子数量至少 1 颗，面数至少 2。' }
    if (sides > MAX_SIDES) return { ok: false, message: `骰子面数不能超过 ${MAX_SIDES}。` }
    total += count
    if (total > MAX_DICE) return { ok: false, message: `一次最多掷 ${MAX_DICE} 颗骰子。` }
    dice.push({ count, sides, sign })
  }
  if (dice.length === 0) return { ok: false, message: '表达式里至少要有一个骰子，例如 1d6。' }
  return { ok: true, dice, modifier }
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

type RollArgs = { readonly expression?: string; readonly label?: string }
type RollResult =
  | {
      readonly ok: true
      readonly expression: string
      readonly total: number
      readonly rolls: readonly string[]
      readonly label?: string
    }
  | Failure
type CheckArgs = { readonly target?: number; readonly label?: string }
type CheckResult =
  | {
      readonly ok: true
      readonly roll: number
      readonly target: number
      readonly result: string
      readonly label?: string
    }
  | Failure
type DrawArgs = { readonly options?: readonly string[]; readonly count?: number }
type DrawResult = { readonly ok: true; readonly picked: readonly string[]; readonly from: number } | Failure

export default defineHostExtension(async ({ harness }) => ({
  inject: ['tools'],
  apply(ctx) {
    harness.registerTool(
      ctx,
      harness.defineTool<RollArgs, RollResult>({
        name: 'roll_dice',
        description:
          '按骰子表达式掷骰。支持 NdM（N 颗 M 面骰）、d%（百分骰）与整数加减，例如 3d6+2、d20、2d8+1d4-1；一次最多 100 颗。',
        parameters: {
          expression: { type: 'string', required: true, description: '骰子表达式，例如 3d6+2' },
          label: { type: 'string', description: '这次掷骰的用途，例如「攻击」，会写进结果' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) =>
            value.ok
              ? text(
                  `${value.label ? `${value.label}：` : ''}${value.expression} = ${value.total}（${value.rolls.join('，')}）`,
                )
              : text(value.message),
        },
        execute: ({ expression, label }) => {
          if (typeof expression !== 'string' || expression.trim() === '') {
            return { ok: false, message: '请提供骰子表达式，例如 1d20。' }
          }
          const parsed = parseExpression(expression)
          if (!parsed.ok) return parsed
          const rolls: string[] = []
          let total = parsed.modifier
          for (const term of parsed.dice) {
            const values = Array.from({ length: term.count }, () => 1 + randomBelow(term.sides))
            total += term.sign * values.reduce((sum, value) => sum + value, 0)
            rolls.push(`${term.sign < 0 ? '-' : ''}${term.count}d${term.sides}: ${values.join(' ')}`)
          }
          if (parsed.modifier !== 0) rolls.push(`修正 ${parsed.modifier > 0 ? '+' : ''}${parsed.modifier}`)
          return {
            ok: true,
            expression: expression.replaceAll(/\s+/gu, ''),
            total,
            rolls,
            ...(typeof label === 'string' && label.trim() ? { label: label.trim().slice(0, 40) } : {}),
          }
        },
      }),
    )

    harness.registerTool(
      ctx,
      harness.defineTool<CheckArgs, CheckResult>({
        name: 'check_d100',
        description:
          '百分骰检定（常见于跑团）：掷 1d100，小于等于目标值即成功；结果不超过目标值的一半为困难成功，不超过五分之一为极难成功，1 为大成功，96 及以上且失败为大失败。',
        parameters: {
          target: { type: 'integer', required: true, description: '技能或属性值，1 到 100' },
          label: { type: 'string', description: '检定名称，例如「侦查」' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) =>
            value.ok
              ? text(
                  `${value.label ? `${value.label} ` : ''}检定：1d100 = ${value.roll} / ${value.target}，${value.result}`,
                )
              : text(value.message),
        },
        execute: ({ target, label }) => {
          if (typeof target !== 'number' || !Number.isInteger(target) || target < 1 || target > 100) {
            return { ok: false, message: '目标值需要是 1 到 100 的整数。' }
          }
          const roll = 1 + randomBelow(100)
          const result =
            roll === 1
              ? '大成功'
              : roll <= target / 5
                ? '极难成功'
                : roll <= target / 2
                  ? '困难成功'
                  : roll <= target
                    ? '成功'
                    : roll >= 96
                      ? '大失败'
                      : '失败'
          return {
            ok: true,
            roll,
            target,
            result,
            ...(typeof label === 'string' && label.trim() ? { label: label.trim().slice(0, 40) } : {}),
          }
        },
      }),
    )

    harness.registerTool(
      ctx,
      harness.defineTool<DrawArgs, DrawResult>({
        name: 'draw_lots',
        description: '从给出的选项中随机抽取若干个，不重复。适合抽签、点名、决定吃什么。',
        parameters: {
          options: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: '候选项，2 到 100 个',
          },
          count: { type: 'integer', description: '抽取数量，默认 1' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => (value.ok ? text(`抽中：${value.picked.join('、')}`) : text(value.message)),
        },
        execute: ({ options, count }) => {
          const candidates = Array.isArray(options)
            ? [...new Set(options.filter((item): item is string => typeof item === 'string' && item.trim() !== ''))]
            : []
          if (candidates.length < 2) return { ok: false, message: '至少需要两个不同的选项。' }
          if (candidates.length > 100) return { ok: false, message: '选项最多 100 个。' }
          const wanted = count === undefined ? 1 : count
          if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 1 || wanted > candidates.length) {
            return { ok: false, message: `抽取数量需要在 1 到 ${candidates.length} 之间。` }
          }
          // 部分 Fisher–Yates 洗牌：只洗出需要的前几位。
          const pool = [...candidates]
          for (let index = 0; index < wanted; index += 1) {
            const swap = index + randomBelow(pool.length - index)
            const current = pool[index] as string
            pool[index] = pool[swap] as string
            pool[swap] = current
          }
          return { ok: true, picked: pool.slice(0, wanted), from: candidates.length }
        },
      }),
    )
  },
}))
