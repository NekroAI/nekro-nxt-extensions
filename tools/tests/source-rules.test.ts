import { describe, expect, it } from 'vitest'
import { checkExtensions, checkSource } from '../source-rules.js'

describe('扩展源码约定', () => {
  it('rejects secrets.get without a stated reason', () => {
    expect(checkSource('a.ts', "const key = await nxt.secrets.get('apiKey')")).toEqual([
      expect.objectContaining({ file: 'a.ts', line: 1 }),
    ])
    expect(checkSource('a.ts', "\n\nconst key = await ctx.nxt?.secrets?.get ('apiKey')")).toEqual([
      expect.objectContaining({ line: 3 }),
    ])
    // 标记要写出理由，只写标记不算。
    expect(checkSource('a.ts', "// secrets.get:\nconst key = await nxt.secrets.get('apiKey')")).toHaveLength(1)
    // 标记只管紧挨着的一行。
    expect(checkSource('a.ts', "// secrets.get: 本地签名\n\nconst key = await nxt.secrets.get('apiKey')")).toHaveLength(
      1,
    )
  })

  it('accepts a reason on the same or the previous line, and the placeholder', () => {
    expect(
      checkSource('a.ts', "const key = await nxt.secrets.get('apiKey') // secrets.get: 用 Key 在本地计算签名"),
    ).toEqual([])
    expect(
      checkSource('a.ts', "// secrets.get: 用 Key 在本地计算签名\nconst key = await nxt.secrets.get('apiKey')"),
    ).toEqual([])
    expect(checkSource('a.ts', "headers: { authorization: `Bearer ${nxt.secrets.placeholder('apiKey')}` }")).toEqual([])
  })

  it('holds for the extensions in this repository', () => {
    expect(checkExtensions()).toEqual([])
  })
})
