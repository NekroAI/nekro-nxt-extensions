# NekroNXT 官方种子扩展

[NekroNXT](https://github.com/NekroAI/nekro-nxt) 官方维护的一批扩展：装上就能用，也是编写扩展时最直接的参考——每个扩展都只用公开 SDK，权限最小，带单元测试，并在真实的 NekroNXT 上通过与用户导入相同的验证。

在 NekroNXT 的「社区 → 发现」中筛选「官方」即可安装；也可以从 [Releases](https://github.com/NekroAI/nekro-nxt-extensions/releases) 下载 `.nxt-extension` 包，在「工坊 → 导入」中导入。安装后不会自动启用，在智能体页面为需要的智能体启用。

## 扩展一览

| 扩展                              | 能做什么                                    | 示范的能力                         |
| --------------------------------- | ------------------------------------------- | ---------------------------------- |
| [掷骰与抽签](extensions/dice)     | 骰子表达式、百分骰检定、随机抽签            | 最小的纯工具扩展                   |
| [网页搜索](extensions/web-search) | 搜索网络并给出来源（博查、Tavily、SearXNG） | 凭据配置、按配置地址联网、静态提示 |

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
- `README.md`：给使用者的说明。

`pnpm verify` 需要一个使用一次性数据目录的 NekroNXT，例如：

```bash
docker run --rm -d -p 4960:4960 -e NEKRO_MANAGEMENT_KEY=<至少32个字符> ghcr.io/nekroai/nekro-nxt:preview
NXT_MANAGEMENT_KEY=<同上> pnpm verify
```

发布：推送 `release-YYYY-MM-DD` 标签后，CI 检查并在 NekroNXT 预览版上验证，然后以官方身份发布到社区（内容没有变化的扩展会跳过），并创建附带全部扩展包的 GitHub Release。需要仓库密钥 `COMMUNITY_PUBLISH_TOKEN`，由社区管理员在后台「扩展 → 官方发布令牌」创建。

编写约定见 [AGENTS.md](AGENTS.md)。

## 许可

代码以 [MIT](LICENSE) 许可发布。NekroNXT 名称与品牌素材不属于该授权范围。
