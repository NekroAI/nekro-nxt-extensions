# NekroNXT 官方种子扩展

[NekroNXT](https://github.com/NekroAI/nekro-nxt) 官方维护的一批扩展：装上就能用，也是编写扩展时最直接的参考——每个扩展都只用公开 SDK，权限最小，带单元测试，并在真实的 NekroNXT 上通过与用户导入相同的验证。

在 NekroNXT 的「社区 → 发现」中筛选「官方」即可安装；也可以从 [Releases](https://github.com/NekroAI/nekro-nxt-extensions/releases) 下载 `.nxt-extension` 包，在「工坊 → 导入」中导入。扩展安装到本机后，页面与本机配置立即可用；带有智能体能力的扩展还要在智能体页面为需要的智能体启用。

这些扩展使用 NekroNXT 扩展格式 V7（需要支持 V7 的 NekroNXT）：一个扩展可以同时提供智能体工具、页面和面板，本机配置（如共用的 API Key）在安装时填写一次，所有智能体共用。

## 扩展一览

| 扩展                                     | 能做什么                                         | 示范的能力                                                   |
| ---------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| [掷骰与抽签](extensions/dice)            | 骰子表达式、百分骰检定、随机抽签                 | 最小的纯工具扩展                                             |
| [网页搜索](extensions/web-search)        | 搜索网络并给出来源（博查、Tavily、SearXNG）      | 本机配置共用凭据、按配置地址联网、静态提示                   |
| [网页阅读](extensions/web-reader)        | 读取网页正文并转为 Markdown                      | 任意公网访问、网页解析服务                                   |
| [图片生成](extensions/image-gen)         | 用 OpenAI 兼容接口生成图片                       | 本机与智能体两层配置、生成 Asset 交给智能体发送              |
| [语音合成](extensions/tts)               | 把文字转成语音消息                               | 本机与智能体两层配置、音频 Asset                             |
| [今日运势](extensions/daily-fortune)     | 每日运势卡片与连续签到                           | 成员作用域存储、SVG 渲染                                     |
| [节日提醒](extensions/festival)          | 节日当天提醒智能体问候，查询近期节日             | Manifest 固定定时任务、到期处理 `onJob`                      |
| [RSS 订阅](extensions/rss)               | 订阅源有新内容时让智能体转述                     | 运行时定时任务、订阅源解析、频道面板                         |
| [群管助手](extensions/group-admin)       | 在群聊中禁言、移出成员、修改群名片               | 平台动作与风险分级                                           |
| [消息守卫](extensions/message-guard)     | 按关键词隐藏、静默或强制唤醒                     | 入站钩子、本机配置共用规则                                   |
| [团队采购清单](extensions/purchase-list) | 智能体记录要买的东西，在页面上勾选已买           | 工具与页面同在一个扩展、共享数据、导航入口                   |
| [Emotion 表情包](extensions/stickers)    | 收集表情包，按情绪挑图发送，公共表情包跨频道共享 | 扩展资源库、检索索引、工具结果附图、批量导入与本机层模型调用 |

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
- `assets/icon.svg|png|webp`（可选，只放一个）：扩展图标，正方形 64–512 像素、不超过 128 KiB，在工坊、社区和智能体的扩展列表中显示。

`README.md` 与 `listing.json` 不进扩展包，修改它们不会产生新 Revision。

`pnpm verify` 需要一个使用一次性数据目录的 NekroNXT，例如：

```bash
docker run --rm -d -p 4960:4960 -e NEKRO_MANAGEMENT_KEY=<至少32个字符> ghcr.io/nekroai/nekro-nxt:preview
NXT_MANAGEMENT_KEY=<同上> pnpm verify
```

发布：推送 `release-*` 标签后，CI 检查并在 NekroNXT 预览版上验证，再同步仓库清单、发布允许分发的扩展并更新介绍，最后创建或更新 GitHub Release。内容没变会跳过上传，但仍同步介绍；管理员下架、归档或仓库退役的扩展不会作为本次的新附件发布。旧 GitHub Release 附件不自动删除。

仓库密钥 `COMMUNITY_PUBLISH_TOKEN` 必须在社区后台「令牌」页绑定 `NekroAI/nekro-nxt-extensions`。先部署支持清单同步的社区，再绑定令牌，最后启用这里的工作流。创建令牌的账号仍需保持管理员和官方成员身份。

### 清单、退役与恢复

根目录 `catalog.json` 是本仓库参与分发的唯一清单。条目 ID 一旦创建不能更换。维护条目记录 `extensionId/state: active/directory`；退役条目保留 `extensionId/state: retired/reason`，不得直接删掉记录。源码目录可在退役后删除，也可保留作为参考；退役目录不参与打包、导入验证或发布。打包和发布只消费清单中的条目，忽略 `dist` 中残留的其他包。

变更代码后先运行 `pnpm release:prepare <名称>`。每次要同步的新内容（包括 README、listing.json、Revision 或维护状态）都运行 `pnpm catalog:bump`，提交新的清单版本。相同版本的清单内容和介绍摘要必须一致；旧版本不能覆盖新版本。`pnpm catalog:check` 校验 ID、目录及退役记录，CI 还对比基准提交，拒绝删除已登记的 ID。

- 退役：把清单条目改成 `retired` 并填写原因，提升清单版本，提交后发布标签，或手动运行 Release 工作流。手动运行始终同步 `main` 的状态，不上传包或创建 GitHub Release。
- 恢复维护：使用原 ID 恢复 `active` 和目录，提升版本后同步。社区已有管理员下架或归档时继续保持限制，不能靠 CI 恢复。
- 只改介绍：`COMMUNITY_PUBLISH_TOKEN=<令牌> pnpm listing:sync [名称...]`；`--dry-run` 只显示完整清单和摘要，不联网。指定名称只限制内容更新，完整清单的维护状态仍会同步。
- 只同步状态：`pnpm catalog:sync`。`COMMUNITY_URL` 默认正式站；测试站显式设置为 `https://nxt-staging.nekro.ai`。

`POST /api/v1/official/catalog/sync` 提交完整清单、Git 提交、当前 Revision ID 和条目信息摘要。社区保留管理员状态并返回每项的限制和分发许可。CI 只把明确的 `extension_delisted/extension_retired/extension_archived` 当作跳过；令牌失效、接口异常和校验错误都失败。某个扩展失败后继续处理其他条目，已成功上传的版本不会回滚，重试时按重复版本跳过。

每次联网同步在 `dist/community-report.json` 写逐项报告，GitHub Actions 同时显示摘要并保留报告附件。GitHub Release 在所有处理完成且没有真正失败后发布，只上传最终获准分发的包；已存在的 Release 可重试更新。

编写约定见 [AGENTS.md](AGENTS.md)。

## 许可

代码以 [MIT](LICENSE) 许可发布。NekroNXT 名称与品牌素材不属于该授权范围。
