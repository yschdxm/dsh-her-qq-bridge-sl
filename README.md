# dsh-her-qq-bridge-sl

DeepSeek Harness 插件：**QQ 桥接（SnowLuma / OneBot v11）**。

- 协议：OneBot v11（与 NapCat 桥接同构，底层换成 [SnowLuma](https://github.com/SnowLuma/SnowLuma)）
- 入站：反向 WS / 上报 → 内核只入库 + 通知（不直接注入会话）
- 出站：`app_send` → 内核 `sendOutbound` → 出站安全分类器 → OneBot 发送
- 面板：与 nc 相同，数据路由 `/qq-bridge/rules` 等（若与 nc 同时装，仅允许启用其一）

`sl` = SnowLuma。`nc` = NapCat（`dsh-her-qq-bridge-nc`）。

## 默认连接（可配置）

| 项 | 默认 |
|----|------|
| OneBot HTTP | `http://127.0.0.1:3000` |
| Token 文件 | `ops/onebot-token.txt` |
| 反向 WS 监听 | `127.0.0.1:8643` |
| SnowLuma WebUI | `http://127.0.0.1:5099`（刷新二维码等运维） |

与 nc 的差异主要在：WebUI 端口与鉴权、容器名、刷新登录接口路径；OneBot 事件/动作兼容。

## 安装

```json
"dsh-her-qq-bridge-sl": "link:/mnt/nvme/agent/dsh/forks/dsh-her-qq-bridge-sl"
```

**不要与 nc 同时启用**（避免重复注册 `qq-*` 渠道与路由）。

## License

MIT。协议致谢：OneBot v11、SnowLuma、NapCatQQ（设计参考）。
