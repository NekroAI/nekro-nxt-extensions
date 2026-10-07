import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTENSIONS } from '../listing.js'
import { buildExtension, findIcon } from '../pack.js'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const copy = (name: string): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'pack-'))
  temps.push(root)
  const directory = path.join(root, name)
  cpSync(path.join(EXTENSIONS, name), directory, { recursive: true })
  return directory
}

/** 虚构的 PNG 字节：只需文件头，图标的尺寸校验由扩展包格式负责。 */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80])

describe('打包', () => {
  it('包内只有源码与资源，说明文档和条目信息不进包', () => {
    const directory = copy('dice')
    const before = buildExtension(directory, { bump: false })
    writeFileSync(path.join(directory, 'README.md'), '# 改过的说明\n')
    writeFileSync(path.join(directory, 'listing.json'), '{}')
    const after = buildExtension(directory, { bump: false })
    expect(Buffer.from(after.bytes).equals(Buffer.from(before.bytes))).toBe(true)
    expect(Object.keys(unzipSync(after.bytes)).sort()).toEqual([
      'manifest.json',
      'revision/manifest.json',
      'revision/source/host.ts',
    ])
  })

  it('识别图标：PNG 资源值是 base64，摘要按原始字节计算', () => {
    const directory = copy('dice')
    expect(findIcon(directory)).toBeUndefined()
    writeIcon(directory, 'icon.png', PNG)
    const icon = findIcon(directory)
    expect(icon?.path).toBe('assets/icon.png')
    expect(icon?.resource).toBe(Buffer.from(PNG).toString('base64'))
    expect(icon?.sha256).toBe(createHash('sha256').update(PNG).digest('hex'))
  })

  it('同时放了多种格式的图标时报错', () => {
    const directory = copy('dice')
    writeIcon(directory, 'icon.png', PNG)
    writeIcon(directory, 'icon.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    expect(() => findIcon(directory)).toThrow(/只能放一个图标文件/u)
  })

  it('依赖的扩展包格式不支持图标时，给出升级说明而不是悄悄丢掉图标', () => {
    const directory = copy('dice')
    writeIcon(directory, 'icon.png', PNG)
    expect(() => buildExtension(directory, { bump: false })).toThrow(/不支持扩展图标/u)
  })
})

function writeIcon(directory: string, name: string, bytes: Uint8Array): void {
  const assets = path.join(directory, 'assets')
  mkdirSync(assets, { recursive: true })
  writeFileSync(path.join(assets, name), bytes)
}
