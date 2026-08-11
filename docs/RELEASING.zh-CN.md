# 自动构建与发布

GPTTool 使用 GitHub Actions 构建 macOS 与 Windows 成品。生产服务器不负责编译桌面应用，只同步已经通过 CI 验证并发布到 GitHub Release 的文件。

## 发布触发规则

1. 修改 `package.json` 中的版本号。
2. 同步修改 `release-notes.json` 的版本和发布说明。
3. 将代码推送到 `main`。

当仓库中尚不存在对应的 `v<版本号>` Release 时，工作流会自动执行类型检查、测试和构建，并创建带安装包、SHA-256 校验文件及签名更新清单的 GitHub Release。同一版本后续提交不会重复发布。

也可以在 GitHub Actions 页面手动运行 `Build and publish desktop release`，或推送与 `package.json` 一致的版本标签。需要重新生成当前版本的安装包时，可手动勾选 `force_release`；日常提交不要启用该选项。

## 必需的 GitHub Actions Secrets

在仓库的 **Settings → Secrets and variables → Actions** 中配置：

| Secret | 用途 |
| --- | --- |
| `PRODUCTION_RELAY_URL` | 成品客户端连接的公网中继 WebSocket 地址 |
| `UPDATE_MANIFEST_URL` | 客户端读取的 HTTPS 更新清单地址 |
| `UPDATE_PUBLIC_KEY` | 嵌入客户端的 Ed25519 公钥（SPKI DER 的 Base64） |
| `UPDATE_SIGNING_KEY_B64` | Ed25519 私钥 PEM 的 Base64，仅用于发布工作流签名 |
| `UPDATE_BASE_URL` | 安装包更新目录，必须与 `UPDATE_MANIFEST_URL` 同源并以 `/` 结尾 |

私钥、服务器密码和生产 `.env` 不得提交到仓库。可使用以下命令生成私钥 Secret 的值：

```bash
base64 < ~/.config/gpttool-release/update-signing-ed25519.pem | tr -d '\n'
```

公钥 Secret 可由同一私钥导出：

```bash
openssl pkey -in ~/.config/gpttool-release/update-signing-ed25519.pem \
  -pubout -outform DER | base64 | tr -d '\n'
```

## 成品与官网同步

每个 Release 包含：

- Apple Silicon DMG；
- Intel DMG；
- macOS 通用 DMG；
- Windows x64 安装程序；
- `SHA256SUMS`；
- Ed25519 签名的 `latest.json`。

官网服务器应通过只读定时任务读取公开的 GitHub Latest Release，将这些文件原子同步到下载目录。这样官网源码、SSH 密钥和服务器配置不需要进入开源仓库。
