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

7. **改昵称会被「刷余额」回滚**（实测坐实真凶）—— 改本地凭证文件的 `account.nickname` + 重启面板
   立即生效，但**面板每次刷余额（`POST /panel/api/balance_all`，默认每 5 分钟自动跑一次 ＋ 点「刷新」
   也会跑）都会把昵称从上游重新同步回来**（`preferred_username`）。
   - **实测证据**：改成 `SHORTTEST` → 重启 → 面板显示 `SHORTTEST` → 手动跑一次 `balance_all`
     → **立刻变回原来的邮箱**。
   - 二进制里坐实：`balanceAll` 里带 `syncNicknames`；面板**没有「设置昵称」接口**。
   - ⚠️ **只对「启用中」的号生效** —— 被禁用的号会被 `syncNicknames` **跳过**，所以禁用号的改名能保住。
   - ⇒ **中文昵称不持久**；想持久只能改**上游账号名**（Google 登录的号 = 邮箱，改不了）。

8. **「国际版」徽章被长昵称截断** —— 面板前端判据就一行
   `(s.realm === 'global' ? ' <span class="realm-tag">国际版</span>' : '')`；
   但昵称列 `max-width:200px` + `overflow:hidden; text-overflow:ellipsis`，
   **邮箱式长昵称会把徽章挤出可视区**。修法＝把昵称缩短。

---

## 五、风控行为观察（为什么批量注册失效）

### 5.1 实测对照：4 个号 = 1 个「试水」+ 3 个「连开」

| # | 做法 | 结果 |
|---|---|---|
| 1 | **单独开一个**（与后面那批间隔较久）| ✅ 注册成功、350 积分，**实测可用** |
| 2 | **紧接着连开**（同一出口 IP）| ⚠️ 注册成功、也刷出 350 积分，但**实际使用时**被上游拦 |
| 3 | 连开 | ⚠️ 同上（注册成功，一用就被拦）|
| 4 | 连开 | ❌ **OAuth 阶段就被拦**（提示「安全风险较高，暂时无法访问」）|

⇒ 对照组很清楚：**单开能活；紧接着连开的那 3 个全挂**。
据此判断：**触发风控的不是「注册」这个动作本身，而是「短时间内连续注册」**（同出口 IP / 同设备指纹）。

### 5.2 两种被拦的形态

| 现象 | 含义 |
|---|---|
| OAuth 停在 `first-broker-login`，提示「安全风险较高，暂时无法访问」| 新号在**首次 broker 登录**时就被拦（第 4 个号）|
| 注册成功、刷出积分，但一用就 `11140 request illegal` | 上游判该账号封号（第 2、3 个号；面板据此自动禁用）|

第 2、3 个号上游回的原文（实测）：

```json
{"msg":"request illegal",
 "displayMsg":{"zh":"请求被拦截，请重新发送","en":"Request blocked. Please send it again"}}
```

### 5.3 ⚠️ 重新 OAuth 登录**不能**解封（实测）

对被判 `request illegal` 的号，重新走一遍 GitHub OAuth：

- **登录能成功** —— 拿回**同一个 uid**（是「更新现有账号」而非新建）
- 但**一发请求仍被拦**：`503 no_healthy_account`，上游同样回 `request illegal`
- **换模型也一样**（两个模型都试了）→ **不是模型问题，是账号整体被拦**
- **连发 3 次全失败** → **不是一过性拦截**

⇒ **封在「账号层」（上游风控），不在「会话层」** —— **重新登录无用**。

不过上游的措辞是「**请重新发送** / Please send it again」，**不是永久封号的措辞**
⇒ 大概率是**临时风控**，**可能过几小时 / 几天自动解除**，只能等。

### 5.4 结论

WorkBuddy 对「**同 IP / 同指纹 / 短时间批量注册**」有明确的风控：**单开能活，连开必挂**。
本文记录这套流程，主要是留存 OAuth 链路的逆向结论和踩坑记录，供后续研究参考。

---

## 六、配套脚本：`banned-retry.mjs`（封号复检）

被风控封掉的号**不会自己恢复**，也不值得天天人工去点「解冻」试。这个脚本就是干这个的：
**每天一次**，自动替你去「敲门」——

```
① 解冻（POST /panel/api/accounts/<uid>/revive）
② 临时暂停「同域其它启用号」   ← 关键：面板按池子自动选号，不暂停的话请求会落到健康号身上，测不出真相
③ 发一个最小请求（max_tokens:5）
④ 恢复被暂停的号
   ├ 200 → ✅ 真解封了！保持启用 + 移出跟踪名单
   └ 失败 → ⛔ 重新禁用，等明天再试
```

### 用法

```bash
node banned-retry.mjs              # 跑一轮（计划任务用的就是这个）
node banned-retry.mjs --status     # 看跟踪名单
node banned-retry.mjs --dry        # 只报告，不发请求、不改状态
node banned-retry.mjs --probe-now  # 无视 1 小时间隔，立刻复检
node banned-retry.mjs --add=<uid>  # 手工把某个 uid 加进名单
node banned-retry.mjs --remove=<uid>
```

可调参数：`--base= --min-interval=3600 --model-global=global:hy3 --model-cn=cn:hy3`

### ⚠️ 跟踪名单怎么来（别踩这个坑）

`/status` 里的 `reason` / `disabled_reason` **会被「最后一次禁用动作」覆盖** ——
如果你**手动禁用**了一个本来被封的号，它的封号原因就会被改写成 `manual disable (panel)`，
**光靠 `reason` 筛会漏**。所以脚本维护自己的名单：

- **种子**：脚本里 `SEED` 数组（可选，填你自己的 uid）
- **自动识别**：每轮扫 `/status`，`reason` 含 `banned by upstream` 的自动加入
- **移除**：探测通了 / 号已不在池子里
- 另外：脚本**只测名单里的号**，绝不会去动你手动禁用的健康号（不覆盖你的手动意图）

### 依赖与交付

- **依赖**：Node.js（用原生 `fetch`，**零 npm 依赖**）
- 需要面板在跑（默认 `http://127.0.0.1:7863`，Bearer = `config.json` 的 `api_key`）
- **定时**：Windows 下用 `wscript.exe //B banned_retry_run.vbs`（隐藏窗口、不闪黑框）+ 计划任务每日一次

---

## 七、免责声明

- 本文仅记录技术研究与实测现象，不鼓励违反任何服务条款的行为。
- 涉及账号、积分、风控策略的具体数值与行为可能随平台调整而变化，以官方为准。
- 文中所有账号凭证信息均已脱敏。
