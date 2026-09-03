# GPTTool Relay

多租户 HTTPS/WebSocket 中继，用于把已认证的 Web 会话连接到用户自己绑定的 GPTTool 桌面设备。

生产环境推荐 PostgreSQL。Relay 保存账户、设备、一次性配对、登录会话和设备持久化记录；官方 ChatGPT/Codex 的原始 rollout 与本地数据库仍由桌面端和官方客户端管理。

## 运行

源码已迁移到 `backend/src/`，网页源码在 `frontend/src/`。这个目录仅保留部署示例，完整新流程见[前后端分离指南](../../docs/FRONTEND_BACKEND.zh-CN.md)。

```bash
# 仓库根目录
npm ci --prefix backend
cp backend/.env.example backend/.env
# 修改 .env 后再运行；不要提交它。
npm start --prefix backend
```

完整服务器配置见 [`../../docs/SELF_HOSTING.zh-CN.md`](../../docs/SELF_HOSTING.zh-CN.md)。

## 存储后端

- 设置 `ASTERGATE_POSTGRES_HOST`：使用 PostgreSQL（推荐）；
- 仅设置 `ASTERGATE_MYSQL_HOST`：兼容旧 MySQL 部署；
- 均不设置：使用本地 JSON，仅适合开发与测试。

PostgreSQL 启用时会自动创建 schema，并可一次性迁移旧 JSON/MySQL 数据。迁移前请备份。

## 独立 Web UI 发布

根目录运行 `npm ci --prefix frontend && npm run build:web` 生成 `frontend/dist/`。Web UI 有独立版本号，不修改 Electron 版本；仅协议、桌面服务或 Electron 变化时才需要重新发桌面安装包。

下面的兼容发布命令仅更新远程消息页（`frontend/dist/remote`），不更新门户/后台或 API。新部署应发布整个 `frontend/dist` 并使用 `nginx-separated.conf.example`。命令不包含默认主机：

```bash
GPTTOOL_WEB_DEPLOY_HOST='deploy@gpttool.example.com' \
GPTTOOL_WEB_DEPLOY_DIR='/opt/gpttool-relay/public/' \
npm run deploy:web
```

## 安全要求

- Relay 只监听 `127.0.0.1`，公网必须由 HTTPS Nginx 代理；
- 环境文件位于仓库外并限制为 `0640` 或更严格；
- PostgreSQL 不对公网开放；
- 定期备份、轮换数据库口令并检查登录/配对限流；
- 不在日志中记录 Cookie、设备 secret、消息或附件正文。
