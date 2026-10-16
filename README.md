# WorkBuddy 国际版：账号注册与 OAuth 流程 · 技术笔记

> 本文记录对 **WorkBuddy**（腾讯国际版 AI 编程工具，`workbuddy.ai`）账号注册/登录系统的
> 逆向分析与自动化探索。所有结论均来自实测；涉及账号凭证的信息已全部脱敏。
>
> ⚠️ **本文只做技术研究与流程记录，不构成任何「获取免费额度」的指导**。
> 实测结果表明：批量注册在当前风控下基本失效（详见文末「风控行为观察」）。

---

## 结论先行（2026-10 实测）

WorkBuddy 国际版的个人账号可以通过 **GitHub OAuth** 自助开通，注册即送一笔免费积分
（实测约 350 积分，具体金额随活动变化）。

但 **批量注册会被风控拦截**：

- 同一出口 IP 短时间内连开多个号，靠后的号会在 OAuth 阶段被拦，页面提示「安全风险较高，暂时无法访问」。
- 有些号虽然 OAuth 成功、也刷出了积分，但**实际使用时**上游会返回 `11140 request illegal`
  （面板源码里写死 = `account banned by upstream`），账号被判封号。

**一句话：单号能开能用；批量开号在当前风控下基本失效。**

---

## 一、登录方式（官方口径）

WorkBuddy 国际版个人账号支持三种登录方式：**Google / GitHub / 邮箱**。

- 一个 **Google 账号**只能关联 1 个主账号（1:1）。
- 一个 **邮箱**只能注册 1 个主账号。
- **GitHub** 是自助 OAuth，注册即建号（无邀请码，视阶段而定）。

> 国内版（`codebuddy.cn`）是另一套账号体系：个人版只有「微信扫码 / 手机号」两条路，
> 没有邮箱、没有 QQ 登录。两个版本由面板的 `realm` 字段（`cn` / `global`）区分。

---

## 二、OAuth 技术链路

面板（`workbuddy2api`）内置了完整的开户流程，可直接脚本化：

```
POST /panel/api/login/start   {"realm":"global"}
  → {"ok":true,"realm":"global","state":"<uuid>",
     "url":"https://www.workbuddy.ai/login?platform=CLI&state=<uuid>"}

GET  /panel/api/login/poll?state=<uuid>
  → 轮询；登录成功后凭证落盘并热加载进池
```

登录 UI 实际渲染在 **Keycloak iframe** 里（`/auth/realms/copilot/protocol/openid-connect/auth...`），
主文档是 SPA、`body` 长度为 0。走的是 **GitHub → Keycloak broker → WorkBuddy** 的授权链。

---

## 三、完整流程（GitHub 注册 → OAuth）

每一步都实测跑通：

| 步骤 | 怎么做 |
|---|---|
| ① 准备邮箱 | 打开 `mail.qq.com`，走「快捷登录」，点本机 QQ 的**头像授权登录**（无需扫码）|
| ② 注册 GitHub | `github.com/signup`：邮箱 / 密码 / 用户名 / **Country 选香港**（注意：国家是自定义下拉，不是 `<select>`，自动化脚本容易漏填）|
| ③ 读验证码 | 刷新邮箱，找 `GitHub` 主题邮件，正文有 8 位数字验证码（主题「🚀 Your GitHub launch code」）|
| ④ 填验证码 | 注册页有 8 个 `input[name='launch_code[]']`，**点第一格直接整串键入**即可自动跳格 |
| ⑤ 登录 GitHub | 用新号登录，页面提示「Your account was created successfully!」|
| ⑥ 接 WorkBuddy | `POST /panel/api/login/start {"realm":"global"}` 拿 state+url → 浏览器打开 → 进 Keycloak iframe 点 `#social-github` → GitHub 授权 |
| ⑦ 轮询完成 | `GET /panel/api/login/poll?state=<state>` 直到 `{"done":true,"uid":"<uid>","credits":N}` |

---

## 四、必踩的坑（都实测踩到）

1. **登录按钮在 Keycloak iframe 里，不在主页面** —— `www.workbuddy.ai/login` 主文档 `body` 长度是 0，
   真正的 UI 在 iframe 里。**别按主页面 body 判断「页面坏了」**，要遍历 `page.frames`。

2. **🔴 最坑：GitHub 授权页有两个 `button[name='authorize']`** ——
   `value=1` 是 **Authorize**，`value=0` 是 **Cancel**。按 name/`.last` 选会点到 Cancel，
   然后 GitHub 带着 `error=access_denied` 回调，跳到 `staging-codebuddy.tencent.com`（不可达的内网域名）。
   **正解**：按文字选 `get_by_role("button", name="Authorize", exact=True)`。
   > 教训：看到「用户拒绝授权」这类 error，先怀疑自己点错按钮，别先怀疑对方服务。

3. **DataDome 认 profile 不认 IP** —— `github.com/signup` 在用过一段时间的 profile 里秒过，
   在全新 profile 里卡 60 秒也不放行。**专门留一个「暖」profile 干注册**。

4. **两个浏览器实例协同** —— 一个走 GitHub（注册/授权）、一个读邮箱，用 Playwright
   同时连两个 CDP 端口（各自 `--user-data-dir` + 不同 `--remote-debugging-port`）跨窗口干活。

5. **QQ 邮箱要先绑手机号才收信** —— 某些 QQ 邮箱点头像进邮箱后跳「认证信息不全，请绑定手机号后继续使用」，
   收不到验证码。绑完手机号再读即可。

6. **GitHub 验证页会过期跳回首页** —— 验证码没及时填，`/account_verifications` 就跳回 `github.com/`。
   **兜底**：邮件里的确认链接 `github.com/account_verifications/confirm/<uuid>/<code>`，直接打开即完成验证。

7. **改昵称会被面板周期回滚** —— 改本地凭证文件的 `account.nickname` + 重启面板立即生效，
   但约 5–15 分钟后会被面板的周期同步回滚成 GitHub 用户名（`preferred_username`）。
   令牌有效期 1 年、手动刷余额都不回滚；真凶是面板内部周期任务（闭源二进制，定位不到具体哪个）。
   ⇒ **中文昵称不持久**。

8. **「国际版」徽章被长昵称截断** —— 面板前端判据就一行
   `(s.realm === 'global' ? ' <span class="realm-tag">国际版</span>' : '')`；
   但昵称列 `max-width:200px` + `overflow:hidden; text-overflow:ellipsis`，
   **邮箱式长昵称会把徽章挤出可视区**。修法＝把昵称缩短。

---

## 五、风控行为观察（为什么批量注册失效）

实测连续注册时观察到的风控信号：

| 现象 | 含义 |
|---|---|
| OAuth 停在 `first-broker-login`，提示「安全风险较高，暂时无法访问」| 新号在首次 broker 登录时被拦 |
| 注册成功、刷出积分，但一用就 `11140 request illegal` | 上游判该账号封号（面板据此自动禁用）|
| 同 IP 连开多个号 | 靠后的号更容易触发上述拦截 |

**结论**：WorkBuddy 对「同 IP / 同指纹 / 短时间批量注册」有明确的风控，
单纯堆号数量在当前策略下不可行。本文记录这套流程，主要是留存 OAuth 链路的逆向结论
和踩坑记录，供后续研究参考。

---

## 六、免责声明

- 本文仅记录技术研究与实测现象，不鼓励违反任何服务条款的行为。
- 涉及账号、积分、风控策略的具体数值与行为可能随平台调整而变化，以官方为准。
- 文中所有账号凭证信息均已脱敏。
