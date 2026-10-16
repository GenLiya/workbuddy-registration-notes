#!/usr/bin/env node
/**
 * 封号复检（banned-retry）
 * ---------------------------------------------------------------------------
 * 背景（2026-10-16 实测）：
 *   · WorkBuddy 上游会对「同 IP 短时间批量注册」的号做风控，返回
 *       {"msg":"request illegal","displayMsg":{"zh":"请求被拦截，请重新发送"}}
 *   · 面板把它当成「账号被封」→ 自动 `disabled=true`
 *   · 实测确认：**重新 OAuth 登录不能解封**（登录能成功，但一发请求仍被拦），
 *     连发 3 次也全失败 ⇒ 封在「账号层」，只能**等风控自动解除**。
 *
 * 本程序做的事：**每天一次**，替你去"敲门"——
 *   ① 把跟踪名单里被封的号解冻（revive）
 *   ② 临时暂停**同域其它启用号**（保证测试请求落到被测号身上）
 *   ③ 发一个最小请求探一下
 *        · 200 → **真的解封了**！保持启用（自动恢复），从名单里移除
 *        · 失败 → 重新禁用（等明天再试）
 *   ④ 恢复被临时暂停的号
 *
 * ⚠️ 为什么必须"暂停同域其它号"：面板是按池子自动选号的，不暂停的话请求会落到
 *    健康号身上，测不出被测号的真实状态。
 *
 * ⚠️ 跟踪名单怎么来：
 *   · 种子：state 文件里手工列出的 uid（首轮已填入两个已知被封号）
 *   · 自动：每轮扫 /status，凡 `reason`/`disabled_reason` 含 "banned by upstream" 的自动加入
 *   · 移除：探通了 / 号已不在池子里
 *   · 注意：`reason` 会被「最后一次禁用动作」覆盖（手动禁用会盖掉封号原因），
 *     所以**不能只靠 reason 筛**，名单才是权威。
 *
 * 用法：
 *   node banned-retry.mjs               跑一轮（给计划任务用）
 *   node banned-retry.mjs --dry         只报告，不发请求、不改任何状态
 *   node banned-retry.mjs --status      只打印跟踪名单，不联网
 *   node banned-retry.mjs --probe-now   无视最短间隔，立刻复检
 *   node banned-retry.mjs --add=<uid>   手工把某个 uid 加进跟踪名单
 *   node banned-retry.mjs --remove=<uid> 手工从名单移除
 * 可调：--base= --min-interval=3600(秒，防手抖重复跑) --model-global= --model-cn=
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '封号复检.state.json');
const LOG_FILE = path.join(__dirname, '封号复检.log');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
};
const has = (name) => argv.includes('--' + name);
const DRY = has('dry');
const STATUS_ONLY = has('status');
const PROBE_NOW = has('probe-now');
const BASE = flag('base', 'http://127.0.0.1:7863');
const MIN_INTERVAL = Number(flag('min-interval', 3600)); // 同一号最短复检间隔（秒）
const ADD_UID = flag('add', null);
const REMOVE_UID = flag('remove', null);

// 各域的探测模型（挑免费/便宜的）
const TEST_MODEL = {
  global: flag('model-global', 'global:hy3'),
  cn: flag('model-cn', 'cn:hy3'),
};

// 首轮种子（可选）：把你**已被封**的账号 uid 填在这里，脚本首次运行时会纳入跟踪名单。
// 不填也行 —— 每轮脚本都会扫 /status，凡 `reason` / `disabled_reason` 含 "banned by upstream"
// 的账号会自动加入名单；也可以运行时手工加：node banned-retry.mjs --add=<uid>
const SEED = [
  // { uid: '<你的账号 uid>', nick: '<昵称>', realm: 'global' },
];

// ---------- 工具 ----------
function readKey() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).api_key || 'test_key'; }
  catch { return 'test_key'; }
}
const KEY = readKey();

function log(s = '') {
  const line = '[' + new Date().toLocaleString('sv-SE').replace('T', ' ') + '] ' + s;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
}
function loadState() {
  let st;
  try { st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { st = { tracked: {} }; }
  st.tracked = st.tracked || {};
  // 首次运行：填种子
  if (!st.seeded) {
    for (const s of SEED) {
      if (!st.tracked[s.uid]) st.tracked[s.uid] = { ...s, addedAt: new Date().toISOString(), checks: 0 };
    }
    st.seeded = true;
  }
  return st;
}
function saveState(st) {
  st.savedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout || 60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

// ---------- 主流程 ----------
async function runOnce() {
  const st = loadState();

  if (STATUS_ONLY) {
    log('== --status：只读跟踪名单 ==');
    const arr = Object.values(st.tracked);
    if (!arr.length) log('  （名单为空）');
    for (const r of arr) {
      log(`  ${r.uid.slice(0, 8)}  ${String(r.nick || '').slice(0, 16).padEnd(16)} [${r.realm}]  复检${r.checks || 0}次  末次=${r.lastResult || '-'}  末次时间=${r.lastCheckAt || '-'}`);
    }
    return;
  }

  if (ADD_UID) {
    st.tracked[ADD_UID] = st.tracked[ADD_UID] || { uid: ADD_UID, nick: '(手工添加)', realm: 'global', addedAt: new Date().toISOString(), checks: 0 };
    saveState(st);
    log(`✚ 已加入名单: ${ADD_UID}`);
    return;
  }
  if (REMOVE_UID) {
    delete st.tracked[REMOVE_UID];
    saveState(st);
    log(`✖ 已移出名单: ${REMOVE_UID}`);
    return;
  }

  log('────────────────────────────────────────');
  const sres = await api('/status', { timeout: 30000 });
  if (sres.status !== 200 || !sres.json) {
    log(`✗ /status HTTP ${sres.status} —— 面板没起？本轮放弃`);
    return;
  }
  const status = sres.json;
  const byUid = new Map((status.accounts || []).map((a) => [a.uid, a]));

  // ① 自动识别新封号（reason 含 banned by upstream）
  let added = 0;
  for (const a of status.accounts || []) {
    const r = String(a.reason || '') + ' ' + String(a.disabled_reason || '');
    if (/banned by upstream/i.test(r) && !st.tracked[a.uid]) {
      st.tracked[a.uid] = { uid: a.uid, nick: a.nickname, realm: a.realm, addedAt: new Date().toISOString(), checks: 0, lastResult: '(自动识别)' };
      added++;
      log(`✚ 新识别到被封号: ${a.uid.slice(0, 8)} ${a.nickname} [${a.realm}]`);
    }
  }

  // ② 清理：已不在池子里的，从名单移除
  for (const uid of Object.keys(st.tracked)) {
    if (!byUid.has(uid)) {
      log(`✖ ${uid.slice(0, 8)} 已不在池子里 → 移出名单`);
      delete st.tracked[uid];
    }
  }

  const list = Object.values(st.tracked);
  log(`跟踪名单 ${list.length} 个（本轮新增 ${added} 个）`);
  if (!list.length) { log('没有要复检的号，收工'); saveState(st); return; }

  if (DRY) {
    for (const r of list) {
      const a = byUid.get(r.uid);
      log(`🧪 --dry：会复检 ${r.uid.slice(0, 8)} ${a ? a.nickname : '?'} [${r.realm}] disabled=${a ? a.disabled : '?'}  model=${TEST_MODEL[r.realm] || TEST_MODEL.global}`);
    }
    saveState(st);
    return;
  }

  let recovered = 0;
  for (const rec of list) {
    const a = byUid.get(rec.uid);
    if (!a) continue;
    rec.nick = a.nickname;
    rec.realm = a.realm || rec.realm;

    const lastMs = rec.lastCheckAt ? new Date(rec.lastCheckAt).getTime() : 0;
    if (!PROBE_NOW && Date.now() - lastMs < MIN_INTERVAL * 1000) {
      const left = Math.ceil((MIN_INTERVAL * 1000 - (Date.now() - lastMs)) / 60000);
      log(`⏭ ${String(a.nickname).slice(0, 18)} 距上次复检不足 ${MIN_INTERVAL}s（还差 ${left} 分），跳过`);
      continue;
    }

    log('');
    log(`── 复检 ${a.nickname} (${rec.uid.slice(0, 8)}) [${a.realm}] ──`);
    const model = TEST_MODEL[a.realm] || TEST_MODEL.global;
    const paused = [];
    let ok = false, detail = '';

    try {
      // 1) 解冻
      if (a.disabled) {
        const rv = await api(`/panel/api/accounts/${rec.uid}/revive`, { method: 'POST' });
        log(`   ① 解冻 → HTTP ${rv.status}`);
        await sleep(1500);
      } else {
        log('   ① 本来就是启用状态，跳过解冻');
      }

      // 2) 暂停同域其它启用号
      const fresh = await api('/status', { timeout: 30000 });
      const others = (fresh.json?.accounts || []).filter(
        (x) => x.realm === a.realm && x.uid !== rec.uid && !x.disabled && !x.paused
      );
      for (const o of others) {
        const r = await api(`/panel/api/accounts/${o.uid}/pause`, { method: 'POST' });
        if (r.status === 200) paused.push(o.uid);
      }
      log(`   ② 临时暂停同域其它号 ${paused.length} 个（保证请求落到被测号）`);

      // 3) 发最小请求
      const t0 = Date.now();
      try {
        const res = await api('/v1/chat/completions', {
          method: 'POST', timeout: 120000,
          body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false },
        });
        const ms = Date.now() - t0;
        if (res.status === 200) { ok = true; detail = `HTTP 200 (${ms}ms)`; }
        else {
          const m = String(res.text).match(/"msg":"([^"]*)"/);
          detail = `HTTP ${res.status} (${ms}ms) ${m ? m[1] : String(res.text).slice(0, 90)}`;
        }
      } catch (e) { detail = `异常 ${e.cause?.code || e.message}`; }
      log(`   ③ 探测 ${model} → ${detail}`);
    } finally {
      // 4) 恢复被暂停的号
      for (const uid2 of paused) await api(`/panel/api/accounts/${uid2}/resume`, { method: 'POST' });
      if (paused.length) log(`   ④ 已恢复临时暂停的 ${paused.length} 个号`);
    }

    rec.checks = (rec.checks || 0) + 1;
    rec.lastCheckAt = new Date().toISOString();

    if (ok) {
      rec.lastResult = '✅ 已解封（保持启用）';
      log(`   ✅✅ ${a.nickname} 已解封！—— 保持启用，移出跟踪名单`);
      delete st.tracked[rec.uid];
      recovered++;
    } else {
      // 再禁用（面板多半已自动禁用，这里兜底）
      const rd = await api(`/panel/api/accounts/${rec.uid}/disable`, { method: 'POST' });
      rec.lastResult = `⛔ 仍被封（${detail}）`;
      log(`   ⛔ ${a.nickname} 仍被封 → 重新禁用（HTTP ${rd.status}）`);
    }
  }

  saveState(st);
  log('');
  log(`完成：复检 ${list.length} 个 · 解封 ${recovered} 个 · 名单剩 ${Object.keys(st.tracked).length} 个`);
}

// ---------- 入口 ----------
await runOnce();
if (!STATUS_ONLY && !ADD_UID && !REMOVE_UID) {
  try {
    const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(10000) });
    log(`✅ 回验 /healthz = ${r.status}`);
  } catch (e) {
    log(`⚠️ /healthz 自检失败: ${e.message}`);
  }
}
