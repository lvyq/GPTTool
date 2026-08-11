# GPTTool 架构

## 设计目标

GPTTool 把“远程入口、桌面编排、Codex 适配、任务呈现”分成独立边界。官方客户端升级导致某个 UI 选择器失效时，不应同时破坏账户、设备、中继和 app-server 基础能力。

## 组件

### Desktop（Electron）

- 桌面控制台、托盘、窗口与自动更新；
- 固定在 `127.0.0.1:8518` 的本地远程服务；
- 设备凭据、连接模式与用户偏好；
- 与公网 Relay 保持出站 WSS 连接；
- 生命周期编排、错误隔离与兼容状态提示。

### Codex adapters

- `app-server-service.ts`：结构化任务、回合和事件通道；
- `cdp-client.ts` / `codex-service.ts`：仅在官方同步模式下读取和操作本机官方 UI；
- `official-client-probe.ts`：被动探测官方客户端，不在启动时前台自动点击；
- `codex-session-store.ts`：只读解析官方本地会话与 rollout 数据；
- `compatibility.ts`：能力分级，而不是以单个版本号硬阻断全部功能。

### Remote Web UI

纯静态 HTML/CSS/JavaScript，通过桌面端或 Relay 提供。浏览器只接收当前用户绑定设备的数据，不接触官方登录令牌或 CDP 调试端口。

### Relay

- 账户注册、登录会话与速率限制；
- 一次性二维码设备绑定；
- 设备和浏览器双向 WebSocket 中继；
- PostgreSQL 中的用户、设备、消息队列、偏好和压缩快照；
- 不作为模型服务，不持有 ChatGPT 登录态。

## 数据流

```text
Browser -- HTTPS/WSS --> Relay -- authenticated WSS --> Desktop
Desktop --> 127.0.0.1:8518 --> Orchestrator
Orchestrator --> app-server
Orchestrator --> CDP (hybrid mode only)
```

附件采用分块转发并限制单条消息、分块数量与超时。设备断线后，队列元数据可由本机存储和 PostgreSQL 快照恢复；真正的官方会话历史仍由官方客户端管理。

## 信任边界

1. **公网边界**：必须使用 HTTPS/WSS；Nginx 终止 TLS。
2. **账户边界**：浏览器会话使用 HttpOnly、Secure、SameSite Cookie。
3. **设备边界**：每台设备持有独立随机密钥；服务端只保存哈希。
4. **本机边界**：CDP 与 8518 端口只绑定回环地址。
5. **更新边界**：签名清单、公钥校验、SHA-256、HTTPS 同源下载。
6. **官方数据边界**：GPTTool 不修改或替换官方历史数据库。

## 兼容策略

- app-server 是稳定的基础能力层；
- CDP 是可降级的同步增强层；
- 能力探测按“消息发送、任务恢复、附件、设置”等功能分别报告；
- 官方客户端不兼容时可回退至 app-server，而不是让整个桌面端失效；
- 选择器和协议变化必须通过自动化回归后才能进入发布版本。
