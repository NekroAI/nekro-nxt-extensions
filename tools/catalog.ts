import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'

export const OFFICIAL_REPOSITORY = 'NekroAI/nekro-nxt-extensions'
export const CatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.literal(OFFICIAL_REPOSITORY),
    version: z.number().int().positive(),
    entries: z
      .array(
        z.discriminatedUnion('state', [
          z
            .object({
              extensionId: z.string().regex(/^ext_[A-Za-z0-9]+$/u),
              state: z.literal('active'),
              directory: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
            })
            .strict(),
          z
            .object({
              extensionId: z.string().regex(/^ext_[A-Za-z0-9]+$/u),
              state: z.literal('retired'),
              reason: z.string().trim().min(1).max(1000),
            })
            .strict(),
        ]),
      )
      .max(200),
  })
  .strict()
  .refine(
    (catalog) => new Set(catalog.entries.map((entry) => entry.extensionId)).size === catalog.entries.length,
    '扩展 ID 不能重复。',
  )
export type Catalog = z.infer<typeof CatalogSchema>
export const ROOT = path.resolve(import.meta.dirname, '..')
export const loadCatalog = (root = ROOT): Catalog => {
  const catalog = CatalogSchema.parse(JSON.parse(readFileSync(path.join(root, 'catalog.json'), 'utf8')))
  const directories = new Set<string>()
  const slugs = new Set<string>()
  for (const entry of catalog.entries) {
    if (entry.state !== 'active') continue
    if (directories.has(entry.directory)) throw new Error(`清单目录重复：${entry.directory}`)
    directories.add(entry.directory)
    const file = path.join(root, 'extensions', entry.directory, 'extension.json')
    if (!existsSync(file)) throw new Error(`扩展目录缺失：${entry.directory}。停止维护时请保留退役记录。`)
    const definition = JSON.parse(readFileSync(file, 'utf8')) as { id: string; slug: string }
    if (slugs.has(definition.slug)) throw new Error(`清单中的打包名称重复：${definition.slug}`)
    slugs.add(definition.slug)
    if (definition.id !== entry.extensionId) throw new Error(`${entry.directory} 的 ID 与清单不一致。`)
  }
  for (const folder of existsSync(path.join(root, 'extensions'))
    ? readdirSync(path.join(root, 'extensions'), { withFileTypes: true })
    : []) {
    const file = path.join(root, 'extensions', folder.name, 'extension.json')
    if (!folder.isDirectory() || !existsSync(file)) continue
    const definition = JSON.parse(readFileSync(file, 'utf8')) as { id: string }
    const entry = catalog.entries.find((item) => item.extensionId === definition.id)
    if (!entry || (entry.state === 'active' && entry.directory !== folder.name))
      throw new Error(`${folder.name} 没有登记在清单中。`)
  }
  return catalog
}
export const assertCatalogEvolution = (previous: Catalog, current: Catalog) => {
  if (current.version < previous.version) throw new Error('清单版本不能倒退。')
  if (current.version === previous.version && JSON.stringify(current.entries) !== JSON.stringify(previous.entries))
    throw new Error('清单发生变化，请运行 pnpm catalog:bump。')
  for (const entry of previous.entries)
    if (!current.entries.some((item) => item.extensionId === entry.extensionId))
      throw new Error(`清单移除了 ${entry.extensionId}，请保留退役记录。`)
}
export const activeEntries = (root = ROOT) => loadCatalog(root).entries.filter((entry) => entry.state === 'active')

if (import.meta.url === `file://${process.argv[1]}`) {
  const catalog = loadCatalog()
  if (process.argv.includes('--bump')) {
    writeFileSync(
      path.join(ROOT, 'catalog.json'),
      `${JSON.stringify({ ...catalog, version: catalog.version + 1 }, null, 2)}\n`,
    )
  } else {
    const base = process.env['CATALOG_BASE']
    if (base && /^[a-f0-9]{40}$/u.test(base) && !/^0+$/u.test(base)) {
      let previous: string | undefined
      try {
        previous = execFileSync('git', ['show', `${base}:catalog.json`], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        /* First adoption has no catalog. */
      }
      if (previous) assertCatalogEvolution(CatalogSchema.parse(JSON.parse(previous)), catalog)
    }
    console.log(
      `清单版本 ${catalog.version}：${catalog.entries.length} 个条目，${catalog.entries.filter((entry) => entry.state === 'retired').length} 个已退役。`,
    )
  }
}
