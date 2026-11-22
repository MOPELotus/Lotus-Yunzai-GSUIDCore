# Lotus-Yunzai GSUIDCore

Lotus-Yunzai 的可选早柚核心协议适配器。保留旧 TRSS 的反向 WebSocket 入口 `/GSUIDCore`，由对端连接宿主。Gscore 主动连接早柚核心的 `/ws/{bot_id}` 是另一条链路。

适配器默认关闭。宿主先核验反向连接的身份，再把连接交给 `createGsuidCoreGateway`。路由保留平台、机器人、私聊、群和频道的原始标识。旧反向协议没有投递回执，提交给连接后报告结果未知。

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
```

来源见 [TRSS 旧反向适配器](https://github.com/TimeRainStarSky/Yunzai/blob/641d0dc069c3c9bf0ac8fd167d2f3cfa4dab0d94/plugins/adapter/GSUIDCore.js) 和 [早柚协议文档](https://docs.sayu-bot.com/CodeAdapter/Protocol.html)。
