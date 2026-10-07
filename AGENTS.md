# 编写约定

本仓库的扩展同时是用户直接使用的功能和开发者、NekroNXT「创造」智能体的参考样例，质量要求高于普通扩展。

## 边界

- 只使用 `@nekro-nxt/extension-sdk` 公开的接口；源码是单个文件，不导入其他模块（宿主导入时会重新构建，只认 SDK）。
- 能力说明以 SDK 的 [README](https://github.com/NekroAI/nekro-nxt/blob/main/packages/extension-sdk/README.md) 与类型为准；不确定某个能力的行为时读 SDK 源码，不要猜。
- 权限最小：只声明真正用到的 `permissions.capabilities`。网络优先用 `domains`，地址由用户决定时用 `config`，尽量不用 `unrestricted`。
- 凭据一律是 `meta.role: 'secret'` 配置字段，用 `ctx.nxt.secrets.get` 读取；凭据字段不能有默认值。
- 扩展不能在频道发言：要发送图片、音频或文件时创建 Asset 并把 `assetId` 返回给智能体。
- 静态提示只放固定文字；会变化的状态放动态上下文，内容要粗粒度，不能含时间戳、随机数或精确计数。

## 行为

- 每个工具只做一件事，参数扁平；`description` 写清格式、范围与默认值。
- 缺少配置、输入不合法、外部服务出错时返回 `{ ok: false, message }`，`message` 是给用户看的中文说明，不抛出异常。保存与导入验证会真实调用工具，此时没有凭据。
- 用 `defineTool<Args, Result>` 标注参数与结果类型，`output.render` 输出给模型看的简洁文字；长内容截断，控制上下文占用。
- `extension.json` 中每个工具的 `verificationInput` 必须没有副作用（查询而不是提交、发送或付款）。
- 文案使用中文，面向用户的实体称「智能体」。测试、示例只用虚构数据，不写入真实凭据、账号、群号或网址以外的个人信息。

## 流程

1. 新扩展：在 `extensions/<名称>/` 写 `extension.json`、`src/host.ts`、`tests/host.test.ts` 与 `README.md`，`id` 用 `ext_` 加 26 位大写字母数字，创建后不再改变。
2. `pnpm check` 通过后运行 `pnpm release:prepare <名称>` 生成 Revision；内容未变化时打包结果逐字节相同，CI 发现内容变化而 `release.json` 未更新会失败。
3. 用一次性数据目录的 NekroNXT 运行 `pnpm verify`，确认通过导入验证。
4. 在根 README 的「扩展一览」登记。
5. 需要更新说明时，在 `release.json` 中写 `notes`（不影响包内容）；推送 `release-YYYY-MM-DD` 标签发布。

提交信息使用 `type(scope): 中文主题`，类型为 `feat`、`fix`、`refactor`、`docs`、`test`。
