// magpie / OpenCode provider plugin: TokenFuture (tokenfuture.si)
//
// TokenFuture 是一个 OpenAI 兼容网关（sub2api 框架，与「星驰 xingchi」同源）：
//
//   1) 模型调用走标准 Responses / Chat Completions（/v1 下），用面板里生成的
//       API key（sk-…）鉴权，`Authorization: Bearer sk-…`。
//
//   2) 每日签到 + 余额在面板的 /api/v1 下，用网页登录的 JWT（auth_token）鉴权，
//       API key 会被判 INVALID_API_KEY。面板登录被 Cloudflare Turnstile 挡着
//       （POST /api/v1/auth/login 不带 turnstile 返回 "turnstile verification
//       failed"），没法程序化登录，所以令牌由用户从浏览器 localStorage 复制。
//
//   3) 签到规则（站点内固定）：连续第 1 天 1 额度、2 天 2、…、第 6 天起 5，
//       中断一天后重新从第 1 天开始；每天北京时间 0 点更新，一账号一天一次。
//
// 这个插件只做三件事：签到（checkin）、余额（usage）、模型调用（provider）。

const PROVIDER = "tokenfuture"
const BASE_URL = "https://tokenfuture.si/v1"
const PANEL_BASE = "https://tokenfuture.si"
const PANEL_PREFIX = "/api/v1"

// 模型静态兜底清单（网关另有实时清单，provider.models 会按需拉取）。
// context/output 取 GPT-6 系的目录值；codex-auto-review / gpt-reserve 无目录
// 记录，用通用兜底。
const MODELS = {
  "gpt-5.6-luna": { name: "GPT-5.6 Luna", context: 1050000, output: 128000 },
  "gpt-5.6-sol": { name: "GPT-5.6 Sol", context: 1050000, output: 128000 },
  "gpt-5.6-terra": { name: "GPT-5.6 Terra", context: 1050000, output: 128000 },
  "gpt-6-astra": { name: "GPT-6 Astra", context: 1050000, output: 128000 },
  "gpt-6-luna": { name: "GPT-6 Luna", context: 1050000, output: 128000 },
  "gpt-6-sol": { name: "GPT-6 Sol", context: 1050000, output: 128000 },
  "gpt-6.1-sol": { name: "GPT-6.1 Sol", context: 1050000, output: 128000 },
  "gpt-6.1-terra": { name: "GPT-6.1 Terra", context: 1050000, output: 128000 },
  "gpt-6.2-astra": { name: "GPT-6.2 Astra", context: 1050000, output: 128000 },
  "gpt-6.2-sol": { name: "GPT-6.2 Sol", context: 1050000, output: 128000 },
  "codex-auto-review": { name: "Codex Auto Review", context: 128000, output: 32768 },
  "gpt-reserve": { name: "GPT Reserve", context: 128000, output: 32768 },
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

// ---- 面板 API 封装 -----------------------------------------------------
//
// 面板统一包一层 { code: 0, message: "success", data: {...} }，
// 错误则是 { code, message, reason? }。这里拆成 { status, ok, data, reason, message }。
async function panelRequest(path, options = {}) {
  const { token, method = "GET", body } = options
  const headers = { accept: "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers["content-type"] = "application/json"

  const res = await fetch(`${PANEL_BASE}${PANEL_PREFIX}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })

  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const payload = parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed

  return {
    status: res.status,
    ok: res.ok,
    data: payload,
    reason: parsed && typeof parsed === "object" ? parsed.reason : undefined,
    message: parsed && typeof parsed === "object" ? parsed.message : undefined,
  }
}

// 面板的分页返回形状各版本不一样，把可能的容器都摊平。
function extractList(data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== "object") return []
  for (const field of ["items", "list", "records", "rows", "data"]) {
    const value = data[field]
    if (Array.isArray(value)) return value
  }
  return []
}

// 用户粘贴的令牌可能是裸 token，也可能是浏览器 copy 出来的 JSON 块。
function parseTokenInput(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return { accessToken: "", refreshToken: "" }
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text)
      return {
        accessToken: String(obj.access_token ?? obj.accessToken ?? obj.token ?? "").trim(),
        refreshToken: String(obj.refresh_token ?? obj.refreshToken ?? "").trim(),
      }
    } catch {
      // 不是 JSON，当作裸 token
    }
  }
  return { accessToken: text, refreshToken: "" }
}

function isActiveKey(item) {
  const status = String(item?.status ?? "").toLowerCase()
  return status === "" || status === "active" || status === "enabled"
}

function hasGroup(item) {
  return item?.group_id !== null && item?.group_id !== undefined
}

// 从账号里挑一把能用的 API key：
//   1. 有分组且可用的 key 直接用；
//   2. 有可用的孤儿 key（没有分组）给它补上默认分组；
//   3. 都没有就新建一把（带默认分组）。
async function resolvePanelApiKey(token) {
  let list = []
  try {
    const res = await panelRequest("/keys", { token })
    if (res.ok) list = extractList(res.data)
  } catch {
    // 列表拿不到就往下走
  }

  const usable = list.find((item) => isActiveKey(item) && hasGroup(item) && item?.key)
  if (usable) return usable.key

  // 取一个默认分组
  let groupId = 0
  try {
    const res = await panelRequest("/groups/available", { token })
    if (res.ok) {
      const groups = Array.isArray(res.data) ? res.data : extractList(res.data)
      const active = groups.find((g) => {
        const s = String(g?.status ?? "").toLowerCase()
        return s === "" || s === "active"
      })
      groupId = Number(active?.id) || 0
    }
  } catch {
    // 拿不到分组就建一把不带分组的（或带 0）
  }

  const orphan = list.find(
    (item) => isActiveKey(item) && !hasGroup(item) && item?.key && item?.name === "magpie",
  )
  if (orphan && groupId && orphan.id) {
    try {
      const updated = await panelRequest(`/keys/${orphan.id}`, {
        method: "PUT",
        token,
        body: { group_id: groupId },
      })
      if (updated.ok) {
        const key = updated.data?.key ?? orphan.key
        if (key) return key
      }
    } catch {
      // 补不上就新建
    }
  }

  try {
    const created = await panelRequest("/keys", {
      method: "POST",
      token,
      body: { name: "magpie", ...(groupId ? { group_id: groupId } : {}) },
    })
    if (created.ok && created.data?.key) return created.data.key
  } catch {
    // 忽略
  }
  return ""
}

// 用 refresh_token 换一张新的面板会话。
async function refreshPanelSession(refreshToken) {
  if (!refreshToken) return null
  try {
    const res = await panelRequest("/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
    })
    if (!res.ok) return null
    const data = res.data ?? {}
    if (!data.access_token) return null
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
    }
  } catch {
    return null
  }
}

// ---- 凭据读取 ----------------------------------------------------------
//
// 这个插件只用一种登录方式：api 型（粘贴网页令牌）。key 存网关 API key（sk-…），
// 面板令牌与 refresh_token 存 metadata。
function apiKeyOf(auth) {
  return auth?.key ?? auth?.access ?? auth?.metadata?.apiKey ?? ""
}

function panelTokenOf(auth) {
  return auth?.metadata?.accessToken ?? auth?.metadata?.panelToken ?? auth?.access ?? ""
}

function refreshTokenOf(auth) {
  return auth?.refresh ?? auth?.metadata?.refreshToken ?? ""
}

// ---- 模型声明 ----------------------------------------------------------
function modelEntry(spec, id) {
  const variants = {}
  for (const effort of spec.efforts ?? EFFORTS) variants[effort] = {}
  return {
    id,
    name: spec.name,
    limit: { context: spec.context, output: spec.output },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text"] },
    variants,
  }
}

function wireEntry(entry, { apiId, name } = {}) {
  return {
    ...entry,
    id: apiId ?? entry.id,
    name: name ?? entry.name,
    api: { id: apiId ?? entry.id, url: BASE_URL, npm: "@ai-sdk/openai" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true },
      output: { text: true },
    },
    variants: entry.variants ?? {},
  }
}

// Responses 请求体轻量改写：网关不接 store 链；推理档位 max/ultra 落到 xhigh。
function normalizeResponsesBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return text
  }
  if (!body || typeof body !== "object") return text
  if (!("input" in body)) return text

  if ("previous_response_id" in body) delete body.previous_response_id
  body.store = false

  if (body.reasoning && typeof body.reasoning === "object") {
    const effort = String(body.reasoning.effort ?? "").toLowerCase()
    if (effort === "max" || effort === "ultra") body.reasoning = { ...body.reasoning, effort: "xhigh" }
  }
  return JSON.stringify(body)
}

function modelInBody(text) {
  try {
    const body = JSON.parse(text)
    return typeof body?.model === "string" ? body.model : null
  } catch {
    return null
  }
}

function modelSpec(id) {
  return MODELS[id] ?? { name: id, context: 128000, output: 32768 }
}

// 把签到状态翻译成 magpie 的 checkin 结果。
// outcome: claimed / done / ineligible / inactive / captcha / failed
function classifyCheckin(status, amount) {
  if (!status || typeof status !== "object") {
    return { outcome: "failed", message: "签到状态返回异常" }
  }
  if (status.enabled === false) {
    return { outcome: "inactive", message: status.closed_message || "站点当前没有开启每日签到活动" }
  }
  if (status.checked_in === true) {
    const total = Number(status.total_days)
    const reward = Number(status.total_reward)
    return {
      outcome: "done",
      streak: Number.isFinite(total) ? total : undefined,
      message: `今天已签到${Number.isFinite(reward) ? `，累计 ${reward} 额度` : ""}（连续第 ${status.streak_day ?? "?"} 天）`,
    }
  }
  return {
    outcome: "claimed",
    credit: typeof amount === "number" ? amount : undefined,
    streak: Number.isFinite(Number(status.total_days)) ? Number(status.total_days) : undefined,
    message: `签到成功，获得 ${typeof amount === "number" ? amount : 0} 额度`,
  }
}// ---- 主工厂 ------------------------------------------------------------
export const TokenfuturePlugin = async (input) => {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "TokenFuture",
        npm: "@ai-sdk/openai", // OpenAI Responses（支持 reasoning）
        api: BASE_URL,
        models: Object.fromEntries(
          Object.entries(MODELS).map(([id, spec]) => [id, modelEntry({ ...spec, efforts: EFFORTS }, id)]),
        ),
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          // 网页令牌方式：签到需要面板的 JWT，API key 干不了这事。
          // 面板登录被 Turnstile 挡着，只能让用户从浏览器里复制令牌。
          type: "api",
          label: "TokenFuture 网页令牌（可自动签到）",
          prompts: [
            {
              type: "password",
              key: "accessToken",
              message: "网页 access_token（auth_token）",
              placeholder: "localStorage 的 auth_token",
              validate: (value) => (String(value ?? "").trim() ? undefined : "请输入 access_token"),
            },
            {
              type: "password",
              key: "refreshToken",
              message: "refresh_token（可选，用于自动续期）",
              placeholder: "localStorage 的 refresh_token",
            },
          ],
          async authorize(inputs) {
            const parsed = parseTokenInput(inputs?.accessToken)
            const accessToken = parsed.accessToken
            const refreshToken = parsed.refreshToken || String(inputs?.refreshToken ?? "").trim()

            if (!accessToken) {
              return { type: "failed", error: "缺少 access_token" }
            }

            // 先验令牌，顺便拿账号邮箱。
            let email
            try {
              const me = await panelRequest("/auth/me", { token: accessToken })
              if (!me.ok) {
                return {
                  type: "failed",
                  error: `网页令牌无效：${me.message ?? `HTTP ${me.status}`}`,
                }
              }
              email = me.data?.email ?? undefined
            } catch (err) {
              return { type: "failed", error: `无法访问面板：${String(err?.message ?? err)}` }
            }

            // 自动选一把可用的 API key 给模型调用用。
            const key = await resolvePanelApiKey(accessToken)
            if (!key) {
              return {
                type: "failed",
                error: "没有取到可用的 API key，请到面板「API 密钥」页新建一把后重试",
              }
            }

            return {
              type: "success",
              key,
              accountId: email,
              metadata: {
                email,
                accessToken,
                refreshToken,
              },
            }
          },
        },
      ],

      // 余额：网关 /v1/usage 返回 balance + daily_usage（顶层 balance 是关键，
      // magpie 会记进 balance-history.json 画走势图）。失败退回面板 /auth/me。
      async usage(getAuth) {
        const auth = await getAuth()
        const key = apiKeyOf(auth)
        if (!key) return { error: "没有登录", windows: [] }
        try {
          const res = await fetch(`${BASE_URL}/usage`, {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) return { error: `TokenFuture answered ${res.status}`, windows: [] }
          const u = await res.json()

          const balance = Number(u?.balance)
          const days = Array.isArray(u?.daily_usage) ? u.daily_usage : []
          const windows = []

          // 今日消费
          const today = days.find((d) => d?.date === new Date().toISOString().slice(0, 10))
          if (today) {
            const cost = Number(today.actual_cost ?? today.cost ?? 0)
            const tokens = Number(today.total_tokens ?? 0)
            const requests = Number(today.requests ?? 0)
            if (cost > 0) {
              const bits = [`$${cost.toFixed(4)}`]
              if (requests > 0) bits.push(`${requests} 次请求`)
              if (tokens > 0) bits.push(`${tokens} tokens`)
              windows.push({ name: "今日消费", display: bits.join(" · "), aside: true })
            }
          }

          // 近 7 天累计消费（可选窗口）
          const sum7 = days.reduce((a, d) => a + Number(d?.actual_cost ?? d?.cost ?? 0), 0)
          if (Number.isFinite(sum7) && sum7 > 0) {
            windows.push({ name: "近 7 天消费", display: `$${sum7.toFixed(4)}`, aside: true })
          }

          const out = { plan: "TokenFuture", windows }
          if (Number.isFinite(balance)) out.balance = `$${balance.toFixed(2)}`
          return out
        } catch (err) {
          return { error: String(err?.message ?? err), windows: [] }
        }
      },

      // 每日签到：面板 /user/checkin，用网页会话令牌鉴权。
      async checkin(getAuth) {
        const auth = await getAuth()
        if (!apiKeyOf(auth)) return { outcome: "failed", message: "账号未登录" }

        let token = String(panelTokenOf(auth) ?? "").trim()
        if (!token) {
          return {
            outcome: "ineligible",
            message: "该账号没有网页会话令牌，无法自动签到。请用「TokenFuture 网页令牌」方式登录。",
          }
        }

        let state
        try {
          state = await panelRequest("/user/checkin", { token })
        } catch (err) {
          return { outcome: "failed", message: `无法访问面板：${String(err?.message ?? err)}` }
        }

        // 会话过期：拿 refresh_token 换一张新的，再试一次。
        if (state.status === 401) {
          const renewed = await refreshPanelSession(refreshTokenOf(auth))
          if (!renewed) {
            return {
              outcome: "failed",
              message: "网页会话已过期，请重新登录（magpie plugin login tokenfuture）",
            }
          }
          token = renewed.accessToken
          try {
            await persistSession(input, auth, renewed)
          } catch {
            // 写不回去也不影响本次签到
          }
          try {
            state = await panelRequest("/user/checkin", { token })
          } catch (err) {
            return { outcome: "failed", message: `无法访问面板：${String(err?.message ?? err)}` }
          }
        }

        if (!state.ok) {
          return {
            outcome: "failed",
            message: `读取签到状态失败：${state.message ?? `HTTP ${state.status}`}`,
          }
        }

        const status = state.data ?? {}
        if (status.enabled === false) {
          return { outcome: "inactive", message: status.closed_message || "站点当前没有开启每日签到活动" }
        }
        if (status.checked_in === true) {
          return classifyCheckin(status)
        }

        // 领取
        let claim
        try {
          claim = await panelRequest("/user/checkin", { method: "POST", token, body: {} })
        } catch (err) {
          return { outcome: "failed", message: `签到失败：${String(err?.message ?? err)}` }
        }

        if (claim.ok) {
          const amount = Number(claim.data?.record?.amount ?? claim.data?.amount ?? status.reward_amount)
          const total = Number(claim.data?.status?.total_days ?? status.total_days)
          return {
            outcome: "claimed",
            credit: Number.isFinite(amount) ? amount : undefined,
            streak: Number.isFinite(total) ? total : undefined,
            message: `签到成功，获得 ${Number.isFinite(amount) ? amount : 0} 额度`,
          }
        }
        if (claim.data?.already_checked_in === true || claim.reason === "CHECKIN_ALREADY_CLAIMED") {
          return { outcome: "done", message: "今天已经签过到了" }
        }
        return {
          outcome: "failed",
          message: `签到失败：${claim.message ?? `HTTP ${claim.status}`}`,
        }
      },

      // 面板令牌过期不影响模型调用，但签到要用，所以续期保住面板令牌。
      refreshLead: 5 * 60 * 1000,
      async refresh(auth) {
        const refreshToken = refreshTokenOf(auth)
        if (!refreshToken) return undefined
        const renewed = await refreshPanelSession(refreshToken)
        if (!renewed) return undefined
        return {
          access: apiKeyOf(auth),
          refresh: renewed.refreshToken,
          expires: renewed.expiresAt,
          metadata: {
            ...(auth?.metadata ?? {}),
            accessToken: renewed.accessToken,
            refreshToken: renewed.refreshToken,
          },
        }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        const key = apiKeyOf(auth)
        if (!key) return {}
        return {
          baseURL: BASE_URL,
          apiKey: key,
          async fetch(input, init) {
            const headers = new Headers(init?.headers)
            let body = init?.body
            if (body != null && !String(headers.get("content-type") ?? "").includes("multipart")) {
              const text = typeof body === "string" ? body : new TextDecoder().decode(body)
              const normalized = normalizeResponsesBody(text)
              if (normalized !== text) {
                body = typeof body === "string" ? normalized : new TextEncoder().encode(normalized)
              }
            }
            if (!headers.get("authorization")) headers.set("authorization", `Bearer ${key}`)
            return await fetch(input, { ...init, headers, body })
          },
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        // 实时拉网关的模型清单，逐个映射回静态目录（含 context/output）。
        // 拉不到就用静态清单兜底。
        return provider?.models ?? Object.fromEntries(
          Object.entries(MODELS).map(([id, spec]) => [id, wireEntry(modelEntry({ ...spec, efforts: EFFORTS }, id))]),
        )
      },
    },
  }
}

// 换到新的面板会话后，把新令牌写回账号。写不进去也不影响本次签到。
async function persistSession(input, auth, renewed) {
  try {
    const body = {
      type: "api",
      key: apiKeyOf(auth),
      metadata: {
        ...(auth?.metadata ?? {}),
        accessToken: renewed.accessToken,
        refreshToken: renewed.refreshToken,
      },
    }
    await input?.client?.auth?.set?.({ path: { id: PROVIDER }, body })
  } catch {
    // 忽略
  }
}

export default TokenfuturePlugin