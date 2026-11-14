/**
 * 扩展源码的仓库约定检查，`pnpm check` 的一部分。
 *
 * 凭据优先用 `secrets.placeholder` 放进请求，由宿主在发出时填入：`secrets.get` 读的是原文，凭据库里「只用于网络请求」的
 * 凭据读不到，扩展会误报没有配置。确实需要原文时（例如要在本地签名），在同一行或上一行写 `// secrets.get: 理由`。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '..')

const SECRETS_GET = /\bsecrets\s*\??\.\s*get\s*\(/u
const SECRETS_GET_REASON = /\/\/\s*secrets\.get:\s*\S/u

export interface RuleViolation {
  readonly file: string
  readonly line: number
  readonly message: string
}

/** 一个源文件里没有写明理由的 `secrets.get(`；`file` 只用来标注位置。 */
export const checkSource = (file: string, text: string): RuleViolation[] => {
  const lines = text.split(/\r?\n/u)
  return lines.flatMap((line, index) =>
    SECRETS_GET.test(line) &&
    !SECRETS_GET_REASON.test(line) &&
    !(index > 0 && SECRETS_GET_REASON.test(lines[index - 1]!))
      ? [
          {
            file,
            line: index + 1,
            message:
              '凭据请用 secrets.placeholder 放进请求；确实需要原文时，在同一行或上一行写「// secrets.get: 理由」。',
          },
        ]
      : [],
  )
}

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [file] : []
  })

/** 检查 `extensions/*\/src` 下的全部源文件。 */
export const checkExtensions = (root = ROOT): RuleViolation[] => {
  const extensions = path.join(root, 'extensions')
  if (!existsSync(extensions)) return []
  return readdirSync(extensions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(extensions, entry.name, 'src')))
    .flatMap((entry) => sourceFiles(path.join(extensions, entry.name, 'src')))
    .flatMap((file) => checkSource(path.relative(root, file), readFileSync(file, 'utf8')))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkExtensions()
  for (const violation of violations) console.error(`${violation.file}:${violation.line}  ${violation.message}`)
  if (violations.length > 0) process.exit(1)
  console.log('扩展源码符合仓库约定。')
}
