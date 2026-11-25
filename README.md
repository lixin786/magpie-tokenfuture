# magpie-tokenfuture

TokenFuture（https://tokenfuture.si）的 magpie / OpenCode provider 插件：**每日自动签到 + 余额查询 + GPT 模型调用**。

TokenFuture 是一个 OpenAI 兼容网关（sub2api 框架，与「星驰 xingchi」同源），模型走标准 Responses / Chat Completions，签到与余额在面板 `/api/v1` 下。

## 装

```
magpie plugin add github:lixin786/magpie-tokenfuture
```

## 登录（粘贴网页令牌）

面板登录被 Cloudflare Turnstile 挡着，没法程序化登录，所以令牌要从浏览器里复制：

1. 在你自己的浏览器里登录 https://tokenfuture.si
2. 按 F12 → Console，执行：

```js
copy(JSON.stringify({ access_token: localStorage.getItem('auth_token'), refresh_token: localStorage.getItem('refresh_token') }))
```

3. 回到 magpie，`magpie plugin login tokenfuture`，选「TokenFuture 网页令牌（可自动签到）」，把剪贴板内容粘到 access_token 那格（refresh_token 可选，填了才能自动续期）。

登录后插件会自动从你账号里选一把 API key 用来调模型；没有就会自动新建成员名 `magpie` 的 key。

## 三个功能

- **每日签到**：`/api/v1/user/checkin`。规则是连续 1→5 天递增、第 6 天起 5 额度、断签重头；北京时间 0 点更新。受 magpie「设置 → 用量 → 插件 → 每日签到」开关控制。
- **余额**：`/v1/usage` 返回余额 + 每日消费，magpie 会记进余额走势。
- **模型**：GPT-5.6 / GPT-6 / GPT-6.1 / GPT-6.2 系列共 12 个模型，支持 reasoning（low ~ xhigh；max 会落到 xhigh）。

## 说明

- 不同账号的可用分组（倍率）不同，本插件取账号默认分组，不展开多分组。
- 模型清单以网关实时返回为准，静态目录只作兜底。

## License

MIT