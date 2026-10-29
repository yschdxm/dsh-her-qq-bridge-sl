<div align="center">

# dsh-her-qq-bridge-sl

DeepSeek Harness 插件：**QQ 桥接（SnowLuma / OneBot v11）**，对接 [dsh-her-kernel](https://github.com/yschdxm/dsh-her-kernel)。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![协议](https://img.shields.io/badge/OneBot-v11-green)](https://github.com/botuniverse/onebot-11)
[![宿主](https://img.shields.io/badge/宿主-DeepSeek%20Harness-blue)](https://github.com/deepseek-ai/dsh)
[![爱发电](https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E8%AF%B7%E6%88%91%E5%96%9D%E6%9D%B5%E9%B2%B8%E9%B1%BC-7e5fd9?logo=afdian&logoColor=white)](https://ifdian.net/a/yschdxm)

<a href="https://whale-star.whale-star.workers.dev/">
  <img src="https://whale-star.whale-star.workers.dev/?repo=yschdxm/dsh-her-qq-bridge-sl" alt="给个 Star 吧～" width="720">
</a>

> 🐳 顶部应援图来自 **[whale-star](https://github.com/yschdxm/whale-star)**

</div>

`sl` = **SnowLuma**。NapCat 版桥接仅作备份，新功能以本仓库为准。

## 做什么

- 入站：SnowLuma OneBot **WS 客户端**连 `ws://127.0.0.1:3001` → `kernel.ingest`（入库 + 通知，**不**直接注入会话）  
- 出站：`app_send` → 内核路由 → 分类器（关键词 + 可选 LLM）→ OneBot HTTP 发送  
- 已读：入站/出站后向 QQ 报 `mark_msg_as_read` / `_mark_all_as_read`，清手机客户端角标  
- 表情：`qq_custom_faces` / `qq_collect_face`（系统表情 + 收藏）  
- 面板：角色 → 渠道「QQ」

## 安装

Harness 配置 `link:` 本目录：

```json
"dsh-her-qq-bridge-sl": "link:/path/to/dsh-her-qq-bridge-sl"
```

需要已安装 **dsh-her-kernel**。不要与 nc 桥接同时启用。

## 默认连接（可配置）

| 项 | 默认 |
|----|------|
| OneBot HTTP | `http://127.0.0.1:3000` |
| Token | SnowLuma `onebot.json` 的 accessToken，或 `ops/onebot-token.txt`（勿提交） |
| OneBot WS | 客户端连 `ws://127.0.0.1:3001` |

## 开发

桥接开发总览见内核文档：[dsh-her-kernel · docs/bridge-plugin.md](https://github.com/yschdxm/dsh-her-kernel/blob/main/docs/bridge-plugin.md)

```
lib/
  index.js      注册渠道 / ingest / outbound / 已读 / 面板
  onebot.js     OneBot WS·HTTP、事件规范化、消息段
  classifier.js 出站安全分类器
  rules.json    各发送接口审核规则（用户可改）
```

日志：`/tmp/kernel-agent.log`

## License

MIT。协议致谢：OneBot v11、SnowLuma、NapCatQQ（设计参考）。  
借鉴见 [LICENSE](./LICENSE)。

## 赞助

[![爱发电](https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E7%82%B9%E8%BF%99%E9%87%8C-7e5fd9?logo=afdian&logoColor=white)](https://ifdian.net/a/yschdxm)
