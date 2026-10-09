/**
 * 把 `extensions/<name>/` 打包为 `dist/<slug>.nxt-extension`。
 *
 * - `extension.json`：身份、展示信息与 Manifest 字段（权限、配置、贡献与验证样例）；
 * - `src/host.ts`、`src/client.ts`：单文件源码，只允许导入 `@nekro-nxt/extension-sdk`；
 * - `assets/`：可选的 Client CSS Module 与 SVG 等资源；`assets/icon.svg|png|webp`（至多一个）是扩展图标，
 *   写入 Manifest 的 `icon` 字段，PNG/WebP 以原始字节放进包内。需要 `@nekro-nxt/extension-format` 支持图标字段
 *   （0.2.0 起）；依赖版本不支持时，放入图标文件会让打包失败并给出说明，没有图标文件时行为不变；
 * - `release.json`：当前 Revision 的锁定记录。内容变化后必须运行 `pnpm release:prepare` 生成新 Revision，
 *   未变化时重复打包得到逐字节相同的包。
 *
 * 用法：`pnpm build [名称...]`、`pnpm release:prepare [名称...]`。
 */
import {
  extensionManifestSchema,
  normalizeSource,
  revisionDigests,
  sha256Hex,
  verifyExtensionPackage,
} from '@nekro-nxt/extension-format'
import { strToU8, zipSync } from 'fflate'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const ROOT = path.resolve(import.meta.dirname, '..')
const EXTENSIONS = path.join(ROOT, 'extensions')
const DIST = path.join(ROOT, 'dist')

const DefinitionSchema = z
  .object({
    id: z.string().regex(/^ext_[0-9A-Za-z]+$/u),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
    displayName: z.string().trim().min(1).max(80),
    description: z.string().max(500),
    createdAt: z.number().int().positive(),
    requires: z.object({ sdk: z.number().int().positive() }).strict().optional(),
    permissions: z.unknown().optional(),
    config: z.unknown().optional(),
    contributions: z.array(z.record(z.string(), z.unknown())),
    clientCss: z.string().optional(),
  })
  .strict()

const LockSchema = z
  .object({
    revisionNumber: z.number().int().positive(),
    revisionId: z.string().regex(/^xrv_[0-9A-Za-z]+$/u),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.number().int().positive(),
    /** 发布到社区时的更新说明；不影响包内容。 */
    notes: z.string().max(2000).optional(),
  })
  .strict()

type Lock = z.output<typeof LockSchema>

/** 与 ULID 同形的随机标识：时间戳在前便于排序。 */
const newId = (prefix: 'xrv'): string => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let time = Date.now()
  let head = ''
  for (let index = 0; index < 10; index += 1) {
    head = alphabet[time % 32] + head
    time = Math.floor(time / 32)
  }
  const tail = [...randomBytes(16)].map((byte) => alphabet[byte % 32]).join('')
  return `${prefix}_${head}${tail}`
}

const readText = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

const ICON_PATHS = ['assets/icon.svg', 'assets/icon.png', 'assets/icon.webp'] as const

export interface Icon {
  readonly path: (typeof ICON_PATHS)[number]
  /** 文件原始字节，按原样写入包内。 */
  readonly bytes: Uint8Array
  /** 内存中的资源值：SVG 是原文，PNG/WebP 是 base64。 */
  readonly resource: string
  /** 原始字节的 SHA-256，写入 Manifest。 */
  readonly sha256: string
}

/** 找出扩展目录下的图标文件；同时放了多种格式时报错，避免打包结果取决于文件顺序。 */
export const findIcon = (directory: string): Icon | undefined => {
  const present = ICON_PATHS.filter((iconPath) => existsSync(path.join(directory, iconPath)))
  if (present.length > 1) throw new Error(`只能放一个图标文件，现在有：${present.join('、')}。`)
  const iconPath = present[0]
  if (iconPath === undefined) return undefined
  const bytes = new Uint8Array(readFileSync(path.join(directory, iconPath)))
  const resource =
    iconPath === 'assets/icon.svg' ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64')
  return { path: iconPath, bytes, resource, sha256: sha256Hex(bytes) }
}

const collectResources = (directory: string, icon: Icon | undefined): Record<string, string> => {
  const assets = path.join(directory, 'assets')
  if (!existsSync(assets)) return {}
  const resources: Record<string, string> = {}
  for (const name of readdirSync(assets).sort()) {
    const resourcePath = `assets/${name}`
    resources[resourcePath] =
      resourcePath === icon?.path ? icon.resource : readFileSync(path.join(assets, name), 'utf8')
  }
  return resources
}

interface Built {
  readonly slug: string
  readonly bytes: Uint8Array
  readonly lock: Lock
  readonly changed: boolean
}

export const buildExtension = (directory: string, options: { readonly bump: boolean }): Built => {
  const name = path.basename(directory)
  const definition = DefinitionSchema.parse(JSON.parse(readFileSync(path.join(directory, 'extension.json'), 'utf8')))
  const host = readText(path.join(directory, 'src/host.ts'))
  const client = readText(path.join(directory, 'src/client.ts'))
  const sources = {
    ...(host === undefined ? {} : { host: normalizeSource(host) }),
    ...(client === undefined ? {} : { client: normalizeSource(client) }),
  }
  const icon = findIcon(directory)
  const resources = collectResources(directory, icon)
  const lockFile = path.join(directory, 'release.json')
  const lockText = readText(lockFile)
  const previous = lockText === undefined ? undefined : LockSchema.parse(JSON.parse(lockText))

  const manifestFields = (revisionId: string) => ({
    schemaVersion: 7,
    extensionId: definition.id,
    revisionId,
    entrypoints: {
      ...(sources.host === undefined ? {} : { host: 'source/host.ts' }),
      ...(sources.client === undefined ? {} : { client: 'source/client.ts' }),
    },
    ...(definition.requires === undefined ? {} : { requires: definition.requires }),
    ...(definition.permissions === undefined ? {} : { permissions: definition.permissions }),
    ...(definition.config === undefined ? {} : { config: definition.config }),
    ...(definition.clientCss === undefined
      ? {}
      : {
          clientCss: {
            path: definition.clientCss,
            sha256: sha256Hex(resources[definition.clientCss] ?? ''),
          },
        }),
    contributions: definition.contributions,
    ...(icon === undefined ? {} : { icon: { path: icon.path, sha256: icon.sha256 } }),
  })
  const manifestFor = (revisionId: string) => {
    const fields = manifestFields(revisionId)
    const parsed = extensionManifestSchema.safeParse(fields)
    if (parsed.success) return parsed.data
    if (icon !== undefined) {
      const { icon: _icon, ...withoutIcon } = fields
      if (extensionManifestSchema.safeParse(withoutIcon).success) {
        throw new Error(
          `当前依赖的 @nekro-nxt/extension-format 不支持扩展图标（${icon.path}）。升级到支持 icon 字段的版本（0.2.0 起）后再打包，或先移除图标文件。`,
        )
      }
    }
    throw parsed.error
  }

  // payloadDigest 不含身份，可以先用旧 Revision 的身份计算，判断内容是否变化。
  const probe = revisionDigests({ manifest: manifestFor(previous?.revisionId ?? 'xrv_PROBE'), sources, resources })
  const changed = previous?.payloadDigest !== probe.payloadDigest
  if (changed && !options.bump) {
    throw new Error(
      `${name}：内容与 release.json 记录的 Revision 不一致。确认要发布新版本时运行 pnpm release:prepare ${name}。`,
    )
  }
  const lock: Lock =
    changed || previous === undefined
      ? {
          revisionNumber: (previous?.revisionNumber ?? 0) + 1,
          revisionId: newId('xrv'),
          payloadDigest: probe.payloadDigest,
          createdAt: Date.now(),
        }
      : previous
  const manifest = manifestFor(lock.revisionId)
  const digests = revisionDigests({ manifest, sources, resources })

  const files: Record<string, Uint8Array> = {
    'revision/manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
  }
  if (sources.host !== undefined) files['revision/source/host.ts'] = strToU8(sources.host)
  if (sources.client !== undefined) files['revision/source/client.ts'] = strToU8(sources.client)
  for (const [resourcePath, content] of Object.entries(resources)) {
    // PNG/WebP 图标在包内是原始字节，内存中的资源值才是 base64。
    files[`revision/${resourcePath}`] = resourcePath === icon?.path ? icon.bytes : strToU8(content)
  }
  const transfer = {
    schemaVersion: 2,
    kind: 'nekro-nxt-extension',
    extension: {
      id: definition.id,
      slug: definition.slug,
      displayName: definition.displayName,
      description: definition.description,
      createdAt: definition.createdAt,
    },
    revision: { id: lock.revisionId, revisionNumber: lock.revisionNumber, ...digests, createdAt: lock.createdAt },
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      size: content.byteLength,
      sha256: sha256Hex(content),
    })),
    sourceVerification: null,
  }
  // 固定压缩时间戳，内容不变时包也逐字节不变。
  const mtime = new Date(lock.createdAt)
  const bytes = zipSync(
    Object.fromEntries(
      Object.entries({ 'manifest.json': strToU8(`${JSON.stringify(transfer, null, 2)}\n`), ...files }).map(
        ([filePath, content]) => [filePath, [content, { mtime }]],
      ),
    ),
    { level: 9 },
  )
  // 与 NekroNXT 导入、社区发布前相同的结构与摘要校验。
  verifyExtensionPackage(bytes)
  if (changed || previous === undefined) writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`)
  return { slug: definition.slug, bytes, lock, changed: changed || previous === undefined }
}

const main = (): void => {
  const args = process.argv.slice(2)
  const bump = args.includes('--bump')
  const only = args.filter((arg) => !arg.startsWith('--'))
  const names = readdirSync(EXTENSIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(EXTENSIONS, entry.name, 'extension.json')))
    .map((entry) => entry.name)
    .filter((name) => only.length === 0 || only.includes(name))
    .sort()
  if (only.length > 0 && names.length !== only.length) throw new Error(`找不到扩展：${only.join('、')}`)
  mkdirSync(DIST, { recursive: true })
  const failures: string[] = []
  for (const name of names) {
    try {
      const built = buildExtension(path.join(EXTENSIONS, name), { bump })
      writeFileSync(path.join(DIST, `${built.slug}.nxt-extension`), built.bytes)
      const note = built.changed
        ? `新 Revision #${built.lock.revisionNumber}`
        : `Revision #${built.lock.revisionNumber}`
      console.log(`✓ ${name} → dist/${built.slug}.nxt-extension（${note}，${built.bytes.byteLength} 字节）`)
    } catch (error) {
      failures.push(`✗ ${name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
