# BGSIM 联机服务端（中继）

这是**独立部署**的服务端：一个 WebSocket 中继，跑在 VPS 上，给装了 BGSIM 客户端的玩家匹配、
排序动作。它**不跑游戏引擎、不存游戏状态、不依赖 Python**，只有 `ws` 一个依赖。

```
  玩家 A（Tauri 客户端）                    玩家 B（Tauri 客户端）
  ┌───────────────────────┐                ┌───────────────────────┐
  │ 本机引擎 (127.0.0.1)  │                │ 本机引擎 (127.0.0.1)  │
  │ 完整八人模拟          │                │ 完整八人模拟          │
  └──────────┬────────────┘                └──────────┬────────────┘
             │  wss://bg.example.com/net             │
             └───────────────┬───────────────────────┘
                     ┌───────▼────────┐
                     │  relay (VPS)   │  只做三件事：
                     │  排队 / 编号   │  排队凑人、给动作盖 seq、按 seq 广播
                     │  截止时间      │  到点代发 END；存动作流供重连；
                     └────────────────┘  比对每回合摘要查不同步
```

客户端与服务端的耦合只有一个 WebSocket 协议（见 [../docs/MULTIPLAYER-HANDOVER.md](../docs/MULTIPLAYER-HANDOVER.md)）。
两边可以各自升级、各自回滚；协议版本不匹配时服务端会**拒绝**连接而不是让两边跑出不同的棋局。

## 30 秒跑起来

```bash
cd server
npm install
node relay.mjs --need 2 --verbose      # 本机测试：两人一桌，其余补电脑
curl -s localhost:8790/healthz         # → ok
```

Docker：

```bash
cd server
docker compose up -d
docker compose logs -f
```

systemd（推荐套反向代理做 TLS）：

```bash
sudo useradd --system --home /opt/bgsim-relay bgsim
sudo mkdir -p /opt/bgsim-relay && sudo cp package.json relay.mjs /opt/bgsim-relay/
cd /opt/bgsim-relay && sudo -u bgsim npm install --omit=dev
sudo cp bgsim-relay.service /etc/systemd/system/
sudo systemctl enable --now bgsim-relay
sudo systemctl status bgsim-relay
```

## 配置

所有配置都能用环境变量给（也支持 `--参数` 覆盖），完整清单见 [.env.example](.env.example)。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8790` / `127.0.0.1` | 监听地址。直接对外就 `0.0.0.0`；套反代就用回环 |
| `NEED` | `8` | 一桌几个真人（1–8），不满的座位由客户端侧的电脑补 |
| `MAX_TURNS` | `60` | 一局最多几回合，作为开局 `config` 下发给所有客户端 |
| `HERO_SELECT_MS` | `90000` | 选英雄阶段的等待上限（这个阶段不代发动作） |
| `ROOM_TTL_MS` | `300000` | 一局结束后房间保留多久，留给重连拉最终状态 |
| `MAX_ROOMS` / `MAX_CLIENTS` | `200` / `512` | 容量上限，超了拒绝新房间/新连接 |
| `RATE_PER_SEC` / `RATE_BURST` | `25` / `60` | 单连接令牌桶，防刷 |
| `RELAY_TOKEN` | 空 | 设了以后客户端必须 `wss://host/net?token=xxx` |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |

## TLS（wss://）与反向代理

浏览器/WebView 里从 `https` 页面连 `ws://` 会被拦；Tauri 里虽然是 `http://127.0.0.1`，但**外网一定要 `wss://`**，
否则客户端到 VPS 的动作流是明文。放一个 Caddy 就够了：

```
bg.example.com {
    reverse_proxy /net*     127.0.0.1:8790
    reverse_proxy /healthz  127.0.0.1:8790
}
```

nginx：

```nginx
location /net {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
location = /healthz {
    proxy_pass http://127.0.0.1:8790/healthz;
    access_log off;
}
```

> 一局大约十几分钟，动作流很小（十几 KB）。一个中继进程跑几百个房间也就一个核的一点点，
> 内存几 MB；带宽是「每个动作 × 8 客户端」的广播，估 10 KB/s/房间量级。

## 运维

| 端点 | 用途 |
| --- | --- |
| `GET /healthz` | 纯文本 `ok`，给 systemd/docker/uptime 监控用 |
| `GET /net/health` | JSON：协议版本、排队数、房间列表（回合/seq/是否 desync/座位连接状态）、累计统计 |
| `GET /stats` | 同上（别名，方便临时看） |

日志是一行一条：`[时间] LEVEL 内容`。值得监控的几条：

- `room rN DESYNC on round M: ...` —— 有客户端的状态和别的端不一致（引擎版本不同 / 被改过），**要报警**。
- `refusing a new room` —— 到 `MAX_ROOMS` 了。
- `client N flooding, closing` —— 触发了限流。

升级服务端：直接重启即可（内存态，进行中的对局会散场；客户端会显示「重连中」，房间没了则提示「这局已经结束了」）。
要做「重启不散场」得把 `room.actions` 追加写盘，见交接文档的 v2 清单。

## 兼容性规则（很重要）

1. **协议版本**（`PROTO`，当前 `1`）：客户端 `hello` 里带 `proto`，不一致直接 `incompatible` + 断开。
2. **引擎版本**：客户端 `hello` 里带 `engine` / `game`（如 `1.1.0` / `37.0.2.256589`），中继按
   `engine|game` 分**队列桶**。不同构建的客户端永远不会被匹配到同一桌——因为八个人必须在同一份确定性模拟上跑。
3. **重连**：座位记着开局时的构建版本，客户端升级后再想回旧房间会被拒（`gone` + `reason: "version"`），
   否则重放出来的棋局会和其他人不一样。

发新客户端时，服务端不需要动；只有协议字段变了才需要升 `PROTO` 并同时发新版客户端。

## 安全边界

- 中继**信任客户端**：它不知道动作含义，只保证顺序。改客户端就能作弊（看全图/改数值），这是这套架构的取舍，
  文档里写明了；要真公平得服务端跑引擎，接口已经留好。
- 它不存任何个人信息，只存昵称（客户端自己起的，最长 16 字）和动作流，进程退出就没了。
- 建议：外网只开反代的 443；`RELAY_TOKEN` 做朋友局的门帘；`MAX_ROOMS` 防被打爆内存。

## 目录

```
server/
  relay.mjs              # 全部服务端逻辑（单文件，零业务依赖）
  package.json           # 只有 ws
  Dockerfile
  compose.yaml
  bgsim-relay.service    # systemd 单元
  .env.example
```

改完 `relay.mjs` 重启进程即可，没有构建步骤。

## 验证情况

- `relay.mjs` 本体、`/healthz`、`/net/health`、排队/编号/超时/重连/版本分桶/token 都有自动化测试
  （`node scripts/relay-test.mjs`，含容器里用的那条 healthcheck 命令）。
- `Dockerfile` / `compose.yaml` / `bgsim-relay.service` 在本机**没有 docker daemon、也没装 systemd**，
  所以没实跑过；它们只做三件事（装 ws、`node relay.mjs`、探活 `/healthz`），照着改端口/路径即可。
  第一次上 VPS 建议先 `docker compose up` 或 `systemctl status` 看一眼日志再放流量。
