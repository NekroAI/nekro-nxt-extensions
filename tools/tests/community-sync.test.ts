import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { CatalogSchema, assertCatalogEvolution, loadCatalog, OFFICIAL_REPOSITORY } from '../catalog.js'
import { prepareSync, syncCommunity, isPolicySkip } from '../community-sync.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const setup = (names = ['fixture-one']) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nxt-catalog-test-'))
  roots.push(root)
  mkdirSync(path.join(root, 'extensions'))
  mkdirSync(path.join(root, 'dist'))
  const entries = names.map((name, index) => ({
    extensionId: `ext_FIXTURE${index}`,
    state: 'active' as const,
    directory: name,
  }))
  writeFileSync(
    path.join(root, 'catalog.json'),
    JSON.stringify({ schemaVersion: 1, repository: OFFICIAL_REPOSITORY, version: 1, entries }),
  )
  for (const entry of entries) {
    const directory = path.join(root, 'extensions', entry.directory)
    mkdirSync(directory)
    writeFileSync(
      path.join(directory, 'extension.json'),
      JSON.stringify({ id: entry.extensionId, slug: entry.directory, displayName: entry.directory }),
    )
    writeFileSync(
      path.join(directory, 'release.json'),
      JSON.stringify({ revisionId: `xrv_FIXTURE${entry.extensionId}`, notes: '虚构样例更新' }),
    )
    writeFileSync(
      path.join(directory, 'listing.json'),
      JSON.stringify({
        summary: '示例简介',
        tags: ['测试'],
        sourceUrl: `https://github.com/NekroAI/nekro-nxt-extensions/tree/main/extensions/${entry.directory}`,
      }),
    )
    writeFileSync(path.join(directory, 'README.md'), '# 示例\n\n仅用于自动化测试。')
    writeFileSync(path.join(root, 'dist', `${entry.directory}.nxt-extension`), 'fixture-package')
  }
  return root
}
it('requires explicit retirement, stable identities and catalog generations', () => {
  const root = setup()
  const old = loadCatalog(root)
  expect(() => assertCatalogEvolution(old, { ...old, version: 2, entries: [] })).toThrow('退役记录')
  const retired = { ...old, entries: [{ extensionId: 'ext_FIXTURE0', state: 'retired' as const, reason: '停止维护' }] }
  expect(() => assertCatalogEvolution(old, retired)).toThrow('catalog:bump')
  expect(() => assertCatalogEvolution(old, { ...retired, version: 2 })).not.toThrow()
  rmSync(path.join(root, 'extensions/fixture-one'), { recursive: true })
  expect(() => loadCatalog(root)).toThrow('目录缺失')
  writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ ...retired, version: 2 }))
  expect(loadCatalog(root).entries[0]?.state).toBe('retired')
  rmSync(path.join(root, 'extensions'), { recursive: true })
  expect(loadCatalog(root).entries[0]?.state).toBe('retired')
  expect(CatalogSchema.safeParse({ ...old, entries: [old.entries[0], old.entries[0]] }).success).toBe(false)
})
it('pins presentation changes even when the package revision stays unchanged', () => {
  const root = setup()
  const old = prepareSync(root).entries[0]
  writeFileSync(path.join(root, 'extensions/fixture-one/README.md'), '# 示例\n\n介绍更新。')
  const next = prepareSync(root).entries[0]
  expect(old?.state === 'active' && next?.state === 'active' && old.revisionId === next.revisionId).toBe(true)
  expect(old?.state === 'active' && next?.state === 'active' && old.listingDigest !== next.listingDigest).toBe(true)
})
it('skips only explicit moderation errors, syncs duplicate metadata and continues independent failures', async () => {
  const root = setup(['fixture-one', 'fixture-two', 'fixture-three'])
  const status = {
    repository: OFFICIAL_REPOSITORY,
    version: 1,
    entries: [
      {
        extensionId: 'ext_FIXTURE0',
        state: 'active',
        exists: true,
        canPublish: true,
        canDistribute: true,
        restriction: null,
      },
      {
        extensionId: 'ext_FIXTURE1',
        state: 'active',
        exists: true,
        canPublish: false,
        canDistribute: false,
        restriction: { code: 'extension_delisted', reason: '管理员暂停' },
      },
      {
        extensionId: 'ext_FIXTURE2',
        state: 'active',
        exists: true,
        canPublish: true,
        canDistribute: false,
        restriction: null,
      },
    ],
  }
  let posts = 0
  const fake = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/official/catalog/sync') || url.endsWith('/official/catalog')) return Response.json(status)
    if (url.endsWith('/official/releases')) {
      posts++
      return posts === 1
        ? Response.json({ error: { code: 'duplicate_release' } }, { status: 409 })
        : Response.json({ error: { code: 'token_owner_inactive', message: '令牌已失效' } }, { status: 403 })
    }
    return Response.json({ extension: JSON.parse(String(init?.body)) })
  })
  const report = await syncCommunity({
    root,
    base: 'https://community.test',
    token: 'fixture-only',
    commitSha: 'a'.repeat(40),
    fetch: fake,
  })
  expect(report.results.map((entry) => entry.outcome)).toEqual(['unchanged', 'skipped', 'failed'])
  expect(report.failed).toBe(true)
  expect(posts).toBe(2)
  expect(
    fake.mock.calls.some(
      ([url, init]) => String(url).includes('/official/extensions/ext_FIXTURE0') && init?.method === 'PATCH',
    ),
  ).toBe(true)
  expect(report.packages).toEqual([path.join(root, 'dist/fixture-one.nxt-extension')])
  expect(isPolicySkip(403, 'repository_token_required')).toBe(false)
  expect(isPolicySkip(500, 'extension_archived')).toBe(false)
})
it('state-only synchronizes a retired catalog without uploading packages or descriptions', async () => {
  const root = setup()
  const catalog = JSON.parse(readFileSync(path.join(root, 'catalog.json'), 'utf8'))
  catalog.entries = [{ extensionId: 'ext_FIXTURE0', state: 'retired', reason: '停止维护' }]
  writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(catalog))
  const fake = vi.fn<typeof fetch>(async () =>
    Response.json({
      repository: OFFICIAL_REPOSITORY,
      version: 1,
      entries: [
        {
          extensionId: 'ext_FIXTURE0',
          state: 'retired',
          exists: false,
          canPublish: false,
          canDistribute: false,
          restriction: { code: 'extension_retired', reason: '停止维护' },
        },
      ],
    }),
  )
  const result = await syncCommunity({
    root,
    base: 'https://community.test',
    token: 'fixture-only',
    commitSha: 'a'.repeat(40),
    stateOnly: true,
    fetch: fake,
  })
  expect(fake).toHaveBeenCalledTimes(1)
  expect(result.results[0]?.outcome).toBe('retired')
  expect(result.packages).toEqual([])
})

it('retains completed results but withholds all assets when the final status cannot be confirmed', async () => {
  const root = setup()
  const status = {
    repository: OFFICIAL_REPOSITORY,
    version: 1,
    entries: [
      {
        extensionId: 'ext_FIXTURE0',
        state: 'active',
        exists: true,
        canPublish: true,
        canDistribute: true,
        restriction: null,
      },
    ],
  }
  const fake = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/official/catalog/sync')) return Response.json(status)
    if (url.endsWith('/official/catalog')) return Response.json({}, { status: 503 })
    if (url.endsWith('/official/releases'))
      return Response.json({ error: { code: 'duplicate_release' } }, { status: 409 })
    return Response.json({ extension: JSON.parse(String(init?.body)) })
  })
  const report = await syncCommunity({
    root,
    base: 'https://community.test',
    token: 'fixture-only',
    commitSha: 'a'.repeat(40),
    fetch: fake,
  })
  expect(report.results.map((result) => result.outcome)).toEqual(['unchanged', 'failed'])
  expect(report.packages).toEqual([])
  expect(report.failed).toBe(true)
})
