# 前后端分离开发与部署

## 工程边界

原来 Web 已经通过 HTTP / WebSocket 调用服务，但源码与静态资源混在桌面端和中继部署目录。本次拆为独立 npm 工程，保留现有原生 JavaScript 界面和协议，不引入额外 UI 框架。

| 工程 | 源码 | 独立构建产物 | 职责 |
| --- | --- | --- | --- |
| Web 前端 | `frontend/src/` | `frontend/dist/` | 登录/设备入口、远程消息、管理后台 |
| API 后端 | `backend/src/` | `backend/dist/` | 身份认证、数据库、规则管理、设备中继 |
| 桌面客户端 | `src/desktop`、`src/codex`、`src/remote`、`src/renderer` | `dist/` | 本地控制、官方适配、桌面窗口 |

浏览器 → 同域 Nginx → 静态前端或 API/WSS 后端 → 桌面设备 → 官方客户端。

`frontend`、`backend` 各有 `package.json` 和锁文件，可以单独安装依赖和构建。桌面进程是设备端代理，不应搬到云端；其本地 8518 服务仍可提供内置 Web 页面。桌面打包复用 `frontend/dist/remote`，没有维护第二套界面。

## 开发

使用 Node.js **22.12 或更新的 22 LTS**。从仓库根目录执行：

```bash
npm ci
npm ci --prefix frontend
npm ci --prefix backend
cp backend/.env.example backend/.env
```

编辑 `backend/.env`；默认采用本地 JSON 开发存储、关闭公开注册。先创建开发账号（不要使用生产密码）：

```bash
npm run admin --prefix backend -- create-user admin '<开发密码>'
```

JSON 存储用于登录/配对/消息中继测试，不提供完整管理功能。测试管理员统计、用户权限和云端规则时，请配置 PostgreSQL；PostgreSQL 模式下 `admin` 为系统管理员。

在两个终端分别启动：

```bash
npm run dev:backend
npm run dev:web
```

访问 `http://localhost:5173/remote/`。开发代理监听回环地址，前端静态资源由 5173 提供，API 和 WebSocket 转发到 8790。数据库只由后端访问。前端源文件修改后重新运行 `dev:web`（不需要重启后端）；后端使用 Node watch。

可选开发环境变量：`FRONTEND_PORT`、`FRONTEND_BASE_PATH`（默认 `/remote/`）、`FRONTEND_BACKEND_URL`（固定后端 origin，默认 `http://127.0.0.1:8790`）。更改前端地址后，必须同步后端 `ASTERGATE_PUBLIC_URL`。本地请使用 localhost；生产必须 HTTPS，不能为了 HTTP 调试去掉 Secure Cookie。

## 独立构建

```bash
npm run build --prefix frontend  # 不依赖 Electron、数据库或后端配置
npm run build --prefix backend   # 不打包任何网页、.env 或运行数据
npm run build                   # 桌面编译 + 内置远程 Web
npm run check
npm test
```

Web 三个入口位于 `frontend/dist/gateway`、`frontend/dist/admin`、`frontend/dist/remote`。二维码解码器在前端构建阶段生成，源码中不包含生成后的大型文件。

后端产物可独立复制到服务器，进入该目录运行 `npm ci --omit=dev`，由 systemd 提供环境变量并执行 `node server.mjs`。无须安装 Electron，也无须上传整个仓库。

## 生产部署

1. 备份服务器配置与数据库，先在测试域名验证。
2. 将 `frontend/dist/` 内容部署到 `/srv/gpttool-web/`。
3. 将 `backend/dist/` 内容部署到 `/opt/gpttool-relay/`；安装该目录的生产依赖。
4. 保留原数据库、会话和设备数据路径；设置 `ASTERGATE_SERVE_FRONTEND=false`、正确的 `ASTERGATE_PUBLIC_URL`。
5. 使用 `deploy/relay-server/nginx-separated.conf.example` 替换该应用原来的 proxy-all 路由，合并到现有 HTTPS server。不要直接覆盖整台服务器的配置。
6. 执行 `nginx -t` 后热加载，重启后端并检查登录、设备列表、配对、管理权限和 WSS 消息。

前后端可以分开发布：更新静态文件不重启中继，更新 API 不重建前端。首次切换须同时配置新静态路由与 API-only 模式；不能只升级后端而留下旧 proxy-all 配置。

### 老部署过渡与回滚

已有服务器暂不改 Nginx 时，显式设置 `ASTERGATE_SERVE_FRONTEND=true`，并将三个产物目录分别配置为 `ASTERGATE_GATEWAY_DIR`、`ASTERGATE_ADMIN_DIR`、`ASTERGATE_ASSETS_DIR`。后端继续代为托管静态文件，旧 URL 和 Cookie 保持有效。这只是过渡选项，新部署默认分离。

`npm run deploy:web` 仍是**仅远程消息页面**的兼容发布命令，来源已改为 `frontend/dist/remote`；不会更新门户、管理页或 Nginx。全量前端部署请发布整个 `frontend/dist`，不要把这条命令误当全站发布。回滚时同时恢复对应后端、静态文件和 Nginx 配置；此改造没有数据库 schema 变更。

## API 与安全约定

后端路径不带公开前缀，由代理剥离 `/remote/`（或自定义前缀）：

| 路由 | 功能及边界 |
| --- | --- |
| `GET /healthz` | 健康与连接数 |
| `/api/session`、`/api/login`、`/api/logout`、`/api/register` | 登录会话与注册策略 |
| `/api/devices`、`/api/pair/*` | 当前账号设备、一次性二维码配对 |
| `/api/admin/*` | 管理员权限；规则上传另有受控令牌接口 |
| `GET /api/cdp-rules` | 按官方版本拉取兼容规则 |
| `WS /agent` | 设备 ID + Bearer 密钥验证 |
| `WS /device/:id/ws` | Session + Origin + 设备所有权验证 |

控制 RPC 格式沿用 `{ id, type, ...参数 }` 和 `{ id, ok, result, error }`；HTTP 用户管理由后端处理，任务与模型操作经 WSS 转发到设备端。Web 协议版本继续由 `frontend/src/remote/web-version.json` 管理。

分离是工程与运行职责分离，不要求跨域。推荐同一 HTTPS 域名反向代理，保留 HttpOnly / Secure / SameSite=Strict Cookie 和 Origin 校验。不要启用通配 CORS，不要把 Origin 改写成可信域名。静态消息页不含用户数据，可公开加载空壳；未登录用户会跳转登录页，实际数据始终由 API/WSS 鉴权。二维码相机权限依旧要求 HTTPS。

数据库密码、会话密钥、规则上传令牌只存在后端运行环境；前端构建不读取根 `.env`。私有官网与采集工具不属于这次拆分，也不纳入公开仓库。
