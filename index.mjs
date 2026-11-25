// magpie / OpenCode provider plugin: TokenFuture (tokenfuture.si)
//
// TokenFuture 是一个 OpenAI 兼容网关（sub2api 框架，与「星驰 xingchi」同源）：
//
//   1) 模型调用走标准 Responses / Chat Completions（/v1 下），用面板里生成的
//       API key（sk-…）鉴权，`Authorization: Bearer sk-…`。
//       网关按「分组（渠道）」分模型：GPT / DeepSeek / GLM / Kimi 各一组，
//       每组自己的模型清单和倍率（rate_multiplier），一把 key 只属一个分组。
//       DeepSeek/GLM/Kimi 的模型 id 自带 `cn:` / `global:` 前缀。
//
//   2) 每日签到 + 余额在面板的 /api/v1 下，用网页登录的 JWT（auth_token）鉴权，
//       API key 会被判 INVALID_API_KEY。面板登录被 Cloudflare Turnstile 挡着
//       （POST /api/v1/auth/login 不带 turnstile 返回 "turnstile verification
//       failed"），没法程序化登录，所以令牌由用户从浏览器 localStorage 复制。
//
//   3) 签到规则（站点内固定）：连续第 1 天 1 额度、2 天 2、…、第 6 天起 5，
//       中断一天后重新从第 1 天开始；每天北京时间 0 点更新，一账号一天一次。
//
// 这个插件做三件事：签到（checkin）、余额（usage）、模型调用（provider，多分组）。

const PROVIDER = "tokenfuture"
const BASE_URL = "https://tokenfuture.si/v1"
const PANEL_BASE = "https://tokenfuture.si"
const PANEL_PREFIX = "/api/v1"

// 模型静态兜底清单（context/output 为目录估算值，实际调用以上游为准）。
// 网关另报实时清单，provider.models 会按分组逐个拉取。
const MODELS = {
  // GPT（rate 5）
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
  // DeepSeek（rate 0.7）
  "cn:deepseek-v4-flash": { name: "DeepSeek V4 Flash（国内）", context: 128000, output: 8192 },
  "cn:deepseek-v4-pro": { name: "DeepSeek V4 Pro（国内）", context: 128000, output: 8192 },
  "cn:deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash（国内）", context: 128000, output: 8192 },
  "global:deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash（国际）", context: 128000, output: 8192 },
  "global:deepseek-v4.1-flash-sg": { name: "DeepSeek V4.1 Flash SG（国际）", context: 128000, output: 8192 },
  // GLM（rate 0.8）
  "cn:glm-5.2": { name: "GLM-5.2", context: 200000, output: 8192 },
  "cn:glm-5.3": { name: "GLM-5.3", context: 200000, output: 8192 },
  "cn:glm-5.3-flash": { name: "GLM-5.3 Flash", context: 200000, output: 8192 },
  // Kimi（rate 0.8）
  "cn:kimi-k3-1": { name: "Kimi K3.1", context: 256000, output: 8192 },
  "cn:kimi-k3.1-pro": { name: "Kimi K3.1 Pro", context: 256000, output: 8192 },
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

// ---- 面板 API 封装 -----------------------------------------------------
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

function extractList(data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== "object") return []
  for (const field of ["items", "list", "records", "rows", "data"]) {
    const value = data[field]
    if (Array.isArray(value)) return value
  }
  return []
}

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

// ---- 分组（渠道）与 key -------------------------------------------------
async function listGroups(token) {
  try {
    const res = await panelRequest("/groups/available", { token })
    if (!res.ok) return []
    const list = Array.isArray(res.data) ? res.data : extractList(res.data)
    return list
      .map((g) => ({
        id: Number(g?.id),
        name: typeof g?.name === "string" ? g.name : "",
        rate: Number(g?.rate_multiplier ?? 1) || 1,
      }))
      .filter((g) => Number.isFinite(g.id))
  } catch {
    return []
  }
}

async function listPanelKeys(token) {
  try {
    const res = await panelRequest("/keys", { token })
    if (!res.ok) return []
    return extractList(res.data)
  } catch {
    return []
  }
}

async function createPanelKey(token, name, groupId) {
  try {
    const res = await panelRequest("/keys", {
      method: "POST",
      token,
      body: { name, group_id: groupId },
    })
    if (res.ok && res.data?.key) {
      return { key: res.data.key, id: res.data.id, group_id: groupId }
    }
  } catch {
    // 忽略
  }
  return null
}

// 每个分组配一把 key：现成的优先，没有就建一把（名字 magpie-g<分组id>）。
async function ensureGroupKeys(token) {
  const groups = await listGroups(token)
  if (!groups.length) return { groups: [], groupKeys: {}, keyGroups: {} }
  const keys = await listPanelKeys(token)
  const groupKeys = {}
  const keyGroups = {}
  for (const g of groups) {
    const existing = keys.find(
      (k) => Number(k?.group_id) === g.id && isActiveKey(k) && typeof k?.key === "string" && k.key,
    )
    if (existing) {
      groupKeys[g.id] = existing.key
      keyGroups[existing.key] = g.id
      continue
    }
    const created = await createPanelKey(token, `magpie-g${g.id}`, g.id)
    if (created) {
      groupKeys[g.id] = created.key
      keyGroups[created.key] = g.id
    }
  }
  return { groups, groupKeys, keyGroups }
}

// 某个 key 能用的模型
async function listModelsForKey(key) {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const body = await res.json()
    return Array.isArray(body?.data) ? body.data : []
  } catch {
    return []
  }
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
function apiKeyOf(auth) {
  return auth?.key ?? auth?.access ?? auth?.metadata?.apiKey ?? ""
}

function panelTokenOf(auth) {
  return auth?.metadata?.accessToken ?? auth?.metadata?.panelToken ?? auth?.access ?? ""
}

function refreshTokenOf(auth) {
  return auth?.refresh ?? auth?.metadata?.refreshToken ?? ""
}

function groupKeysOf(auth) {
  const value = auth?.metadata?.groupKeys
  return value && typeof value === "object" ? value : {}
}

// ---- 模型声明与分组标记 ------------------------------------------------
const GROUP_MARK = /-g(\d+)$/

function rateLabel(rate) {
  const n = Number(rate)
  if (!Number.isFinite(n)) return "1x"
  return String(n) + "x"
}

function modelInBody(text) {
  try {
    const body = JSON.parse(text)
    return typeof body?.model === "string" ? body.model : null
  } catch {
    return null
  }
}

function stripModelMark(text, raw) {
  try {
    const body = JSON.parse(text)
    if (typeof body?.model === "string") body.model = raw.replace(GROUP_MARK, "")
    return JSON.stringify(body)
  } catch {
    return text
  }
}

function modelSpec(id) {
  return MODELS[id] ?? { name: id, context: 128000, output: 8192 }
}

function modelEntry(spec, id) {
  const variants = {}
  for (const effort of EFFORTS) variants[effort] = {}
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

function wireEntry(entry, { apiId, name, rate } = {}) {
  const out = {
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
  if (typeof rate === "number") out.rate = rate
  return out
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

// 把签到状态翻译成 magpie 的 checkin 结果。
function classifyCheckin(status) {
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
    credit: Number.isFinite(Number(status.reward_amount)) ? Number(status.reward_amount) : undefined,
    streak: Number.isFinite(Number(status.total_days)) ? Number(status.total_days) : undefined,
    message: `签到成功，获得 ${Number.isFinite(Number(status.reward_amount)) ? Number(status.reward_amount) : 0} 额度`,
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

            // 每个分组（渠道）各配一把 key，模型清单能同时列出全部渠道。
            let groupKeys = {}
            let primaryGroup = 0
            try {
              const { groups, groupKeys: gk } = await ensureGroupKeys(accessToken)
              groupKeys = gk
              primaryGroup = groups[0]?.id ?? 0
            } catch {
              // 拿不到分组就退回主 key
            }

            const primaryKey = groupKeys[primaryGroup] ?? Object.values(groupKeys)[0] ?? ""
            if (!primaryKey) {
              return {
                type: "failed",
                error: "没有取到可用的 API key，请到面板「API 密钥」页新建一把后重试",
              }
            }

            return {
              type: "success",
              key: primaryKey,
              accountId: email,
              metadata: {
                email,
                accessToken,
                refreshToken,
                groupKeys,
                primaryGroup,
              },
            }
          },
        },
      ],

      // 余额：网关 /v1/usage 返回 balance + daily_usage（顶层 balance 是关键，
      // magpie 会记进 balance-history.json 画走势图）。
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

              // 模型 id 带分组标记时：换成那个分组的 key，并把标记去掉。
              const model = modelInBody(text)
              if (model) {
                const m = GROUP_MARK.exec(model)
                if (m) {
                  const gkey = groupKeysOf(auth)[m[1]]
                  if (gkey) headers.set("authorization", `Bearer ${gkey}`)
                  const stripped = stripModelMark(text, model)
                  if (stripped !== text) {
                    body = typeof body === "string" ? stripped : new TextEncoder().encode(stripped)
                  }
                }
              }

              const normalized = normalizeResponsesBody(typeof body === "string" ? body : new TextDecoder().decode(body))
              if (normalized !== (typeof body === "string" ? body : new TextDecoder().decode(body))) {
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
      async models(provider, { auth } = {}) {
        const key = apiKeyOf(auth)
        if (!key) return provider?.models ?? {}

        const token = String(panelTokenOf(auth) ?? "").trim()
        const groupKeys = groupKeysOf(auth)
        const primary = Number(auth?.metadata?.primaryGroup ?? 0)

        // 有面板会话 + 多分组 key：每个分组都列出自己的模型，名字带倍率，
        // 非主分组的模型 id 带 -g<分组id> 标记（loader 据此换 key）。
        if (token && Object.keys(groupKeys).length) {
          try {
            const groups = await listGroups(token)
            if (groups.length) {
              const out = {}
              const rateSeen = new Map()
              for (const g of groups) {
                const label = rateLabel(g.rate)
                rateSeen.set(label, (rateSeen.get(label) ?? 0) + 1)
              }
              for (const g of groups) {
                const gkey = groupKeys[g.id]
                if (!gkey) continue
                const rows = await listModelsForKey(gkey)
                for (const row of rows) {
                  const id = row?.id
                  if (!id) continue
                  const spec = modelSpec(id)
                  const label = rateLabel(g.rate)
                  const entryId = g.id === primary ? id : `${id}-g${g.id}`
                  const name =
                    `${spec?.name ?? row.display_name ?? id} · ${label}` +
                    (rateSeen.get(label) > 1 && g.name ? `（${g.name}）` : "")
                  out[entryId] = wireEntry(modelEntry(spec, id), { apiId: entryId, name, rate: g.rate })
                }
              }
              if (Object.keys(out).length) return out
            }
          } catch {
            // 拿不到分组就退回静态清单
          }
        }

        // 没有多分组信息：退回静态清单（按主 key 兜底）。
        return Object.fromEntries(
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