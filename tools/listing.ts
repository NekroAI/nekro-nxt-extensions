/**
 * 社区条目信息：作者自己写的简介、介绍、标签与源码地址。它们不进扩展包，不影响 Revision 摘要。
 *
 * - `extensions/<名称>/listing.json`：`summary`（一句话简介，≤160 字）、`tags`（≤8 个）、`sourceUrl`；
 * - `extensions/<名称>/README.md`：去掉开头的一级标题后作为社区的介绍正文（Markdown，≤20000 字）。
 *
 * 发布新版本时随包附带（`pnpm publish:community`），也可以只更新条目信息（`pnpm listing:sync`）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export const ROOT = path.resolve(import.meta.dirname, '..')
export const EXTENSIONS = path.join(ROOT, 'extensions')
export const SOURCE_BASE = 'https://github.com/NekroAI/nekro-nxt-extensions/tree/main/extensions'

export const ListingSchema = z
  .object({
    summary: z.string().trim().min(1).max(160),
    tags: z
      .array(z.string().trim().min(1).max(20))
      .max(8)
      .refine((tags) => new Set(tags).size === tags.length, '标签不能重复'),
    sourceUrl: z.url({ protocol: /^https$/u }),
  })
  .strict()

const IdentitySchema = z.object({ id: z.string(), slug: z.string(), displayName: z.string() })

export interface Listing {
  readonly name: string
  readonly extensionId: string
  readonly slug: string
  readonly displayName: string
  readonly summary: string
  readonly description: string
  readonly tags: readonly string[]
  readonly sourceUrl: string
}

/** README 的第一行一级标题就是扩展名，社区页面已经显示名称，去掉以免重复。 */
export const readmeBody = (markdown: string): string =>
  markdown
    .replace(/^﻿/u, '')
    .replace(/^\s*#\s+[^\n]*\n/u, '')
    .trim()

export const loadListing = (directory: string): Listing => {
  const name = path.basename(directory)
  const identity = IdentitySchema.parse(JSON.parse(readFileSync(path.join(directory, 'extension.json'), 'utf8')))
  const listingFile = path.join(directory, 'listing.json')
  if (!existsSync(listingFile)) throw new Error(`${name}：缺少 listing.json（社区简介、标签与源码地址）。`)
  const parsed = ListingSchema.safeParse(JSON.parse(readFileSync(listingFile, 'utf8')))
  if (!parsed.success) throw new Error(`${name}/listing.json 不符合要求：${z.prettifyError(parsed.error)}`)
  const expected = `${SOURCE_BASE}/${name}`
  if (parsed.data.sourceUrl !== expected) {
    throw new Error(`${name}/listing.json 的 sourceUrl 应为 ${expected}。`)
  }
  const readmeFile = path.join(directory, 'README.md')
  if (!existsSync(readmeFile)) throw new Error(`${name}：缺少 README.md。`)
  const description = readmeBody(readFileSync(readmeFile, 'utf8'))
  if (!description) throw new Error(`${name}/README.md 没有正文。`)
  if (description.length > 20_000) throw new Error(`${name}/README.md 正文超过 20000 字。`)
  return {
    name,
    extensionId: identity.id,
    slug: identity.slug,
    displayName: identity.displayName,
    ...parsed.data,
    description,
  }
}

/** 全部扩展的条目信息，按目录名排序；`only` 非空时只取这些目录。 */
export const loadListings = (only: readonly string[] = []): readonly Listing[] => {
  const names = readdirSync(EXTENSIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(EXTENSIONS, entry.name, 'extension.json')))
    .map((entry) => entry.name)
    .filter((name) => only.length === 0 || only.includes(name))
    .sort()
  if (only.length > 0 && names.length !== only.length) {
    throw new Error(`找不到扩展：${only.filter((name) => !names.includes(name)).join('、')}`)
  }
  return names.map((name) => loadListing(path.join(EXTENSIONS, name)))
}

/** 发布接口的 multipart 字段：`tags` 是 JSON 字符串数组。 */
export const listingFormFields = (listing: Listing): Readonly<Record<string, string>> => ({
  summary: listing.summary,
  description: listing.description,
  tags: JSON.stringify(listing.tags),
  sourceUrl: listing.sourceUrl,
})

/** `PATCH /api/v1/official/extensions/:id` 的 JSON 内容。 */
export const listingPatchBody = (listing: Listing) => ({
  summary: listing.summary,
  description: listing.description,
  tags: [...listing.tags],
  sourceUrl: listing.sourceUrl,
})

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/**
 * 社区回传的扩展视图里与我们提交的不一致的字段名。
 * 社区还不认识这些字段时会忽略它们，回传的仍是旧值，据此发现「请求成功但没有保存」。
 */
export const listingMismatches = (listing: Listing, extension: unknown): readonly string[] => {
  const view = record(extension)
  const mismatched: string[] = []
  if (view['summary'] !== listing.summary) mismatched.push('summary')
  const tags = view['tags']
  if (!Array.isArray(tags) || JSON.stringify(tags) !== JSON.stringify(listing.tags)) mismatched.push('tags')
  // 列表视图没有 description 与 sourceUrl；只有回传了才核对。
  if ('description' in view && view['description'] !== listing.description) mismatched.push('description')
  if ('sourceUrl' in view && view['sourceUrl'] !== listing.sourceUrl) mismatched.push('sourceUrl')
  return mismatched
}

export type PatchOutcome =
  { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string }

/**
 * 解读 `PATCH /api/v1/official/extensions/:id` 的回复。成功必须是 JSON，且回传的条目信息与提交的一致；
 * 社区尚未上线该接口时（统一的 404「接口不存在」，或被前端页面兜底返回 HTML）明确报错，不当作成功。
 */
export const interpretPatch = (
  listing: Listing,
  status: number,
  contentType: string,
  bodyText: string,
): PatchOutcome => {
  const isJson = /^application\/(?:[\w.+-]+\+)?json\b/iu.test(contentType.trim())
  let body: Record<string, unknown> = {}
  if (isJson) {
    try {
      body = record(JSON.parse(bodyText))
    } catch {
      body = {}
    }
  }
  const error = record(body['error'])
  const reason = typeof error['message'] === 'string' ? error['message'] : ''
  if (status >= 200 && status < 300) {
    if (!isJson) {
      return {
        ok: false,
        message: `社区返回了 ${status}，但内容不是 JSON（${contentType || '未知类型'}），可能还不支持更新条目信息，没有确认保存。`,
      }
    }
    const extension = 'extension' in body ? body['extension'] : body
    const mismatched = listingMismatches(listing, extension)
    if (mismatched.length > 0) {
      return {
        ok: false,
        message: `社区回复成功，但这些字段没有保存：${mismatched.join('、')}。社区可能还不支持这些字段。`,
      }
    }
    return { ok: true, message: '条目信息已更新' }
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      message: `令牌无效或权限不足（${status}）：${reason || '请确认令牌 scope 为 publish 或 ops。'}`,
    }
  }
  if (status === 404) {
    if (!isJson || reason === '接口不存在。' || reason === '接口不存在') {
      return { ok: false, message: '社区还没有更新条目信息的接口（404）。等社区上线后再运行。' }
    }
    return {
      ok: false,
      message: `社区找不到这个扩展（404）：${reason || '可能还没有发布过，或不是官方扩展。'}先用 pnpm publish:community 发布。`,
    }
  }
  if (status === 405) return { ok: false, message: '社区还不支持更新条目信息（405）。等社区上线后再运行。' }
  return { ok: false, message: `更新失败：${status} ${reason}`.trim() }
}
