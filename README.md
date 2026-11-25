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
- **模型**：四渠道全支持，登录后自动给每个分组（渠道）配一把 key，模型名带倍率：
  - **GPT**（5x）：gpt-5.6 / gpt-6 / gpt-6.1 / gpt-6.2 系列
  - **DeepSeek**（0.7x）：deepseek-v4-flash / v4-pro / v4.1-flash（cn + global）
  - **GLM**（0.8x）：glm-5.2 / glm-5.3 / glm-5.3-flash
  - **Kimi**（0.8x）：kimi-k3-1 / kimi-k3.1-pro

## 说明

- 主分组（通常是 GPT）的模型用裸 id，其余分组的模型 id 带 `-g<分组id>` 后缀，请求时自动切换到该分组的 key。
- 模型清单以网关实时返回为准，静态目录只作兜底。

## License

MIT