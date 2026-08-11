# 自托管指南

以下示例以 Ubuntu/Debian、Nginx、PostgreSQL 和 systemd 为基础。路径和域名均为占位符，不能原样用于生产环境。

## 1. 准备服务器

建议：2 核 CPU、2 GB 内存、Node.js 22、PostgreSQL 14+、Nginx，以及一个已解析到服务器的 HTTPS 域名。

```bash
sudo useradd --system --home /opt/gpttool-relay --shell /usr/sbin/nologin gpttool
sudo install -d -o gpttool -g gpttool /opt/gpttool-relay /var/lib/gpttool-relay
```

## 2. PostgreSQL

```sql
CREATE ROLE gpttool_app LOGIN PASSWORD 'replace-with-random-password';
CREATE DATABASE gpttool OWNER gpttool_app;
```

数据库应只监听回环或私网。不要把 5432 暴露到公网。Relay 首次启动会创建所需表。

## 3. 安装 Relay

将以下文件复制到 `/opt/gpttool-relay`：

- `deploy/relay-server/*.mjs`
- `deploy/relay-server/package*.json`
- `deploy/relay-server/gateway/`
- `deploy/relay-server/public/`（先运行 `npm run build:web`）

```bash
cd /opt/gpttool-relay
npm ci --omit=dev
```

复制 `deploy/relay-server/.env.example` 为 `/etc/gpttool-relay.env`，填入真实域名和随机密码，然后：

```bash
sudo chown root:gpttool /etc/gpttool-relay.env
sudo chmod 0640 /etc/gpttool-relay.env
```

## 4. systemd 与 Nginx

复制 `gpttool-relay.service.example` 为 `/etc/systemd/system/gpttool-relay.service`，按实际路径调整；把 `nginx-location.conf.example` 合并到现有 HTTPS server block。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gpttool-relay
curl --fail https://gpttool.example.com/remote/healthz
```

`ASTERGATE_PUBLIC_URL` 必须与 Nginx 暴露的路径完全一致，并以 `/` 结尾。

## 5. 构建桌面端

```bash
export GPTTOOL_RELAY_URL='wss://gpttool.example.com/remote/agent'
export GPTTOOL_UPDATE_MANIFEST_URL='https://updates.example.com/gpttool/latest.json'
export GPTTOOL_UPDATE_PUBLIC_KEY='<base64-der-ed25519-public-key>'
npm ci
npm run pack
```

不需要自动更新时，保持公钥为空；客户端不会启动后台更新检查。

## 6. 首次使用

1. 启动桌面端并生成一次性配对二维码；
2. 在公网门户注册或登录自己的账号；
3. 手机扫描桌面二维码并确认绑定；
4. 门户只会显示绑定到当前账号的设备；
5. 启动远程控制后选择连接模式。

## 运维检查

- 定期备份 PostgreSQL，并加密保存；
- 限制注册频率或将 `ASTERGATE_REGISTRATION_MODE=closed`；
- 更新前在测试域名验证 WebSocket 与附件链路；
- 日志中不要输出 Cookie、设备密钥、附件内容和官方登录信息；
- 生产部署配置永远保存在仓库之外。
