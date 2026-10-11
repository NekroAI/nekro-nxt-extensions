import { execFileSync } from 'node:child_process'
execFileSync(
  process.execPath,
  ['--import', 'tsx', new URL('./community-sync.ts', import.meta.url).pathname, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
