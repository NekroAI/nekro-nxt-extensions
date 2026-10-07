# NekroNXT 官方种子扩展

[NekroNXT](https://github.com/NekroAI/nekro-nxt) 官方维护的一批扩展：装上就能用，也是编写扩展时最直接的参考——每个扩展都只用公开 SDK，权限最小，带单元测试，并在真实的 NekroNXT 上通过与用户导入相同的验证。

在 NekroNXT 的「社区 → 发现」中筛选「官方」即可安装；也可以从 [Releases](https://github.com/NekroAI/nekro-nxt-extensions/releases) 下载 `.nxt-extension` 包，在「工坊 → 导入」中导入。安装后不会自动启用，在智能体页面为需要的智能体启用。

## 扩展一览

| 扩展                                 | 能做什么                                    | 示范的能力                              |
| ------------------------------------ | ------------------------------------------- | --------------------------------------- |
| [掷骰与抽签](extensions/dice)        | 骰子表达式、百分骰检定、随机抽签            | 最小的纯工具扩展                        |
| [网页搜索](extensions/web-search)    | 搜索网络并给出来源（博查、Tavily、SearXNG） | 凭据配置、按配置地址联网、静态提示      |
| [网页阅读](extensions/web-reader)    | 读取网页正文并转为 Markdown                 | 任意公网访问、网页解析服务              |
| [图片生成](extensions/image-gen)     | 用 OpenAI 兼容接口生成图片                  | 凭据配置、生成 Asset 交给智能体发送     |
| [语音合成](extensions/tts)           | 把文字转成语音消息                          | 二进制响应、音频 Asset                  |
| [今日运势](extensions/daily-fortune) | 每日运势卡片与连续签到                      | 成员作用域存储、SVG 渲染                |
| [节日提醒](extensions/festival)      | 节日当天提醒智能体问候，查询近期节日        | Manifest 固定定时任务、到期处理 `onJob` |
| [RSS 订阅](extensions/rss)           | 订阅源有新内容时让智能体转述                | 运行时定时任务、订阅源解析、频道存储    |
| [群管助手](extensions/group-admin)   | 在群聊中禁言、移出成员、修改群名片          | 平台动作与风险分级                      |
| [消息守卫](extensions/message-guard) | 按关键词隐藏、静默或强制唤醒                | 入站钩子                                |

## 开发

需要 Node.js 22 与 pnpm 11。

```bash
pnpm install
pnpm check            # 类型检查、单元测试、打包
pnpm release:prepare  # 内容变化后生成新的 Revision（更新 release.json）
pnpm verify           # 把 dist/ 中的包导入一个运行中的 NekroNXT 验证
```

每个扩展是 `extensions/<名称>/` 下的一个目录：

- `extension.json`：身份、展示信息与 Manifest 字段（权限、配置、贡献与验证样例）；
- `src/host.ts`（以及需要界面时的 `src/client.ts`）：单文件源码，只导入 `@nekro-nxt/extension-sdk`；
- `tests/`：用 [`tools/testing.ts`](tools/testing.ts) 的内存替身做的单元测试；
- `release.json`：当前 Revision 的锁定记录，由 `pnpm release:prepare` 维护；
- `README.md`：给使用者的说明，去掉标题后作为社区页面的介绍；
- `listing.json`：社区条目的一句话简介（≤160 字）、标签（≤8 个）与源码地址；
- `assets/icon.svg|png|webp`（可选）：扩展图标，需要 `@nekro-nxt/extension-format` 0.2.0 起才能打包。

`README.md` 与 `listing.json` 不进扩展包，修改它们不会产生新 Revision。

`pnpm verify` 需要一个使用一次性数据目录的 NekroNXT，例如：

```bash
docker run --rm -d -p 4960:4960 -e NEKRO_MANAGEMENT_KEY=<至少32个字符> ghcr.io/nekroai/nekro-nxt:preview
NXT_MANAGEMENT_KEY=<同上> pnpm verify
```

发布：推送 `release-YYYY-MM-DD` 标签后，CI 检查并在 NekroNXT 预览版上验证，然后以官方身份发布到社区（内容没有变化的扩展会跳过），并创建附带全部扩展包的 GitHub Release。发布时一并提交条目信息（简介、介绍、标签、源码地址）；只改了说明而包内容没变时，用 `COMMUNITY_PUBLISH_TOKEN=<令牌> pnpm listing:sync [名称...]` 单独更新（`--dry-run` 预览要提交的内容）。需要仓库密钥 `COMMUNITY_PUBLISH_TOKEN`，由社区管理员在后台「扩展 → 官方发布令牌」创建。

编写约定见 [AGENTS.md](AGENTS.md)。

## 许可

代码以 [MIT](LICENSE) 许可发布。NekroNXT 名称与品牌素材不属于该授权范围。
