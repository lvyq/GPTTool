# GPTTool CDP 规则采集器

CDP 规则采集器是与 GPTTool 主客户端分离的维护工具。官方 ChatGPT 客户端升级后，维护者可以在明确授权的前提下生成对应版本的结构化兼容规则，而不必重新发布 GPTTool 安装包。

## 隐私边界

采集器默认不执行任何页面采集。只有勾选授权并点击“授权并开始采集”后，才会连接本机回环地址上的 CDP。若官方客户端尚未启用 CDP，重启前还会显示第二次系统确认。

规则包只包含：

- 官方客户端版本、平台、Chromium 运行时版本；
- 输入框、模型入口、账户入口和任务行等语义选择器；
- 每个选择器的匹配数量；
- 功能是否存在的布尔探测值；
- 采集器版本与采集时间。

规则包不包含聊天正文、任务标题、附件路径、原始 DOM、Cookie、登录令牌或账号凭据。

## 使用方式

```bash
npm ci
npm run collector
```

或构建独立安装包：

```bash
npm run pack:collector
```

1. 打开官方 ChatGPT 并进入任意可显示 Codex 输入框的任务；
2. 打开采集器并检查识别到的版本；
3. 勾选本次采集授权；
4. 如果 CDP 未启用，可勾选允许重启，随后在系统确认框再次确认；
5. 预览生成的 JSON 规则；
6. 选择自动上传、手动点击上传，或导出 JSON 后在管理后台上传。

## 自动上传配置

默认接口为 `https://www.ebbbe.com/astergate/api/admin/cdp-rules`。自托管用户应改为自己的 HTTPS 中继地址，并在服务器环境中配置独立的 `GPTTOOL_CDP_RULE_ADMIN_TOKEN`。

上传令牌不会写入仓库或安装包。在 macOS 和 Windows 上，采集器使用 Electron `safeStorage` 调用系统安全存储加密后保存在采集器自己的用户数据目录。若系统安全存储不可用，采集器拒绝以明文保存令牌。

维护者也可以通过标准输入完成首次安全配置，避免令牌出现在命令行参数或 shell 历史中：

```bash
printf '%s' "$GPTTOOL_CDP_RULE_ADMIN_TOKEN" | \
  "/Applications/GPTTool CDP Rule Collector.app/Contents/MacOS/GPTTool CDP Rule Collector" \
  --configure-upload-token-stdin
```

通过该命令配置令牌时会同时启用自动上传。采集失败或上传失败不会丢失规则，仍可导出 JSON 后手动上传。

导出的 JSON 文件不包含上传令牌，可以交由管理后台人工审核后再上线。

## 回滚与兼容

规则使用 `exactOfficialVersion` 精确匹配官方版本，并按平台与优先级存储。GPTTool 启动时会拉取匹配版本的规则并缓存；云端不可用时仍回退到本地缓存或内置规则。旧版本规则不会因上传新版本而被覆盖，因此可同时支持多个官方客户端版本。
