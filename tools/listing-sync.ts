/**
 * 只更新社区上官方扩展的条目信息（简介、介绍、标签、源码地址），不发布新版本。
 * 用于给已经上架的扩展补上或修改介绍：内容来自各扩展的 `listing.json` 与 `README.md`。
 *
 * 用法：`pnpm listing:sync [名称...]`，`--dry-run` 只打印将要提交的内容，不联网。
 *
 * 环境变量：
 * - `COMMUNITY_URL`：社区地址，默认 `https://nxt.nekro.ai`；
 * - `COMMUNITY_PUBLISH_TOKEN`：社区后台「扩展 → 官方发布令牌」创建的令牌（scope 为 publish 或 ops）。
 *
 * 任何一个扩展没有确认保存（包括社区尚未支持该接口）都以失败退出，不会静默成功。
 */
import { interpretPatch, listingPatchBody, loadListings } from './listing.js'

const base = (process.env['COMMUNITY_URL'] ?? 'https://nxt.nekro.ai').replace(/\/+$/u, '')
const token = process.env['COMMUNITY_PUBLISH_TOKEN']

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const listings = loadListings(args.filter((arg) => !arg.startsWith('--')))
  if (dryRun) {
    for (const listing of listings) {
      console.log(`# ${listing.name}（${listing.extensionId}）`)
      console.log(JSON.stringify({ ...listingPatchBody(listing), description: `${listing.description.length} 字` }))
    }
    return
  }
  if (!token) throw new Error('缺少 COMMUNITY_PUBLISH_TOKEN。')
  let failed = 0
  for (const listing of listings) {
    let outcome
    try {
      const response = await fetch(`${base}/api/v1/official/extensions/${encodeURIComponent(listing.extensionId)}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(listingPatchBody(listing)),
      })
      outcome = interpretPatch(
        listing,
        response.status,
        response.headers.get('content-type') ?? '',
        await response.text(),
      )
    } catch (error) {
      outcome = { ok: false, message: `请求失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (outcome.ok) {
      console.log(`✓ ${listing.name}（${listing.displayName}）${outcome.message}`)
    } else {
      failed += 1
      console.error(`✗ ${listing.name}（${listing.displayName}）${outcome.message}`)
    }
  }
  if (failed > 0) {
    console.error(`${failed} 个扩展的条目信息没有更新。`)
    process.exitCode = 1
  }
}

await main()
