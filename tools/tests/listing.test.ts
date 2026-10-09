import { mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXTENSIONS,
  SOURCE_BASE,
  interpretPatch,
  listingFormFields,
  listingMismatches,
  loadListing,
  loadListings,
  readmeBody,
} from '../listing.js'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 复制一个真实扩展到临时目录（保留目录名，sourceUrl 校验依赖它），再改写 listing.json。 */
const copyWithListing = (listing: unknown): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'listing-'))
  temps.push(root)
  const directory = path.join(root, 'dice')
  cpSync(path.join(EXTENSIONS, 'dice'), directory, { recursive: true })
  writeFileSync(path.join(directory, 'listing.json'), JSON.stringify(listing))
  return directory
}

describe('条目信息', () => {
  it('每个扩展都有合规的 listing.json 与 README', () => {
    const listings = loadListings()
    expect(listings.map((listing) => listing.name)).toEqual([
      'daily-fortune',
      'dice',
      'festival',
      'group-admin',
      'image-gen',
      'message-guard',
      'purchase-list',
      'rss',
      'tts',
      'web-reader',
      'web-search',
    ])
    for (const listing of listings) {
      expect(listing.sourceUrl).toBe(`${SOURCE_BASE}/${listing.name}`)
      expect(listing.description.startsWith('# ')).toBe(false)
      expect(listing.description.length).toBeGreaterThan(100)
    }
  })

  it('README 去掉开头的一级标题作为介绍', () => {
    expect(readmeBody('# 掷骰与抽签\n\n一句话。\n\n## 能做什么\n')).toBe('一句话。\n\n## 能做什么')
    expect(readmeBody('没有标题\n')).toBe('没有标题')
  })

  it('发布字段按契约编码，tags 是 JSON 字符串数组', () => {
    const [listing] = loadListings(['dice'])
    if (!listing) throw new Error('missing')
    const fields = listingFormFields(listing)
    expect(Object.keys(fields).sort()).toEqual(['description', 'sourceUrl', 'summary', 'tags'])
    expect(JSON.parse(fields['tags'] ?? '')).toEqual(listing.tags)
  })

  it('拒绝过长的简介、过多的标签与错误的源码地址', () => {
    const valid = { summary: '示例', tags: ['一'], sourceUrl: `${SOURCE_BASE}/dice` }
    expect(() => loadListing(copyWithListing({ ...valid, summary: '字'.repeat(161) }))).toThrow(/listing\.json/u)
    expect(() =>
      loadListing(copyWithListing({ ...valid, tags: Array.from({ length: 9 }, (_v, i) => `t${i}`) })),
    ).toThrow(/listing\.json/u)
    expect(() => loadListing(copyWithListing({ ...valid, tags: ['重复', '重复'] }))).toThrow(/listing\.json/u)
    expect(() => loadListing(copyWithListing({ ...valid, sourceUrl: `${SOURCE_BASE}/rss` }))).toThrow(/sourceUrl/u)
    expect(() => loadListing(copyWithListing({ ...valid, sourceUrl: 'http://example.com/' }))).toThrow(/listing\.json/u)
    expect(() => loadListing(copyWithListing({ ...valid, extra: 1 }))).toThrow(/listing\.json/u)
    expect(loadListing(copyWithListing(valid)).summary).toBe('示例')
  })
})

describe('只更新条目信息的回复', () => {
  const [listing] = loadListings(['dice'])
  if (!listing) throw new Error('missing')
  const saved = {
    summary: listing.summary,
    tags: listing.tags,
    description: listing.description,
    sourceUrl: listing.sourceUrl,
  }

  it('回传与提交一致才算成功', () => {
    expect(interpretPatch(listing, 200, 'application/json', JSON.stringify({ extension: saved })).ok).toBe(true)
    expect(interpretPatch(listing, 200, 'application/json; charset=utf-8', JSON.stringify(saved)).ok).toBe(true)
  })

  it('社区忽略了字段时报告没有保存', () => {
    const outcome = interpretPatch(
      listing,
      200,
      'application/json',
      JSON.stringify({ extension: { summary: '旧简介', tags: [] } }),
    )
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining('summary、tags') })
    expect(listingMismatches(listing, { summary: listing.summary, tags: [...listing.tags] })).toEqual([])
  })

  it('接口尚未上线时明确失败', () => {
    const missing = JSON.stringify({ error: { code: 'not_found', message: '接口不存在。' } })
    expect(interpretPatch(listing, 404, 'application/json', missing)).toEqual({
      ok: false,
      message: expect.stringContaining('还没有更新条目信息的接口'),
    })
    expect(interpretPatch(listing, 200, 'text/html', '<!doctype html>').ok).toBe(false)
    expect(interpretPatch(listing, 404, 'text/html', '<!doctype html>').ok).toBe(false)
    expect(interpretPatch(listing, 405, '', '').ok).toBe(false)
  })

  it('区分找不到扩展与令牌问题', () => {
    const notFound = JSON.stringify({ error: { code: 'not_found', message: '扩展不存在。' } })
    expect(interpretPatch(listing, 404, 'application/json', notFound)).toEqual({
      ok: false,
      message: expect.stringContaining('找不到这个扩展'),
    })
    expect(interpretPatch(listing, 401, 'application/json', '{}')).toEqual({
      ok: false,
      message: expect.stringContaining('令牌'),
    })
  })
})
