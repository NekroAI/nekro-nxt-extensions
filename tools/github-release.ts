/** Retry safely after a partial GitHub failure; never attach packages excluded by community moderation. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './catalog.js'

const tag = process.env['GITHUB_REF_NAME']
if (!tag?.startsWith('release-')) throw new Error('只能为 release-* 标签创建发布。')
const report = JSON.parse(readFileSync(path.join(ROOT, 'dist/community-report.json'), 'utf8')) as {
  failed: boolean
  packages: string[]
  results: { name: string; outcome: string; message: string }[]
}
if (report.failed) throw new Error('社区同步尚有失败，不能完成 GitHub Release。')
const notes = path.join(ROOT, 'dist/release-notes.md')
writeFileSync(
  notes,
  `官方扩展包，可在 NekroNXT「工坊 → 导入」中导入。\n\n${report.results.map((item) => `- ${item.name}：${item.outcome}，${item.message}`).join('\n')}\n`,
)
const gh = (args: string[]) => execFileSync('gh', args, { cwd: ROOT, stdio: 'inherit' })
let exists = false
try {
  execFileSync('gh', ['release', 'view', tag], { cwd: ROOT, stdio: 'pipe' })
  exists = true
} catch {
  /* create will report auth/network errors as errors too */
}
if (!exists) gh(['release', 'create', tag, '--verify-tag', '--draft', '--title', tag, '--notes-file', notes])
if (report.packages.length) gh(['release', 'upload', tag, ...report.packages, '--clobber'])
gh(['release', 'edit', tag, '--draft=false', '--notes-file', notes])
