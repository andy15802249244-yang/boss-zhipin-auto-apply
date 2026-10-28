#!/usr/bin/env node
/**
 * zp_daily.js — Boss直聘(BOSS Zhipin) 自动投递守护进程
 *
 * 功能：
 *  - 时间窗控制（默认 10:00-11:30 / 14:00-16:30，窗口外休眠值守）
 *  - 每日预算控制（默认 145，低于平台 150 上限；110 时预警）
 *  - "活跃HR优先"过滤：只投 刚刚活跃/今日活跃/回复超快/新发岗
 *  - 标题黑名单（外语/驻外岗）与薪资下限过滤
 *  - 卡页自愈（readyState 检查 + 错误重连 + 停滞看门狗）
 *  - 进度预测与自动提速（预测达不到目标时缩短间隔、扩大关键词池）
 *  - 波次结束 Windows 弹窗报告；缺口/风控/掉登录/上限 均弹窗报警
 *  - 跨天永久去重（applied_registry.json，绝不重复投递）
 *
 * 依赖：Node.js >= 22（原生 fetch/WebSocket）+ Microsoft Edge（CDP 调试端口）
 * 用法：
 *   1) 启动 Edge：
 *      msedge --remote-debugging-port=9335 --user-data-dir=<专用profile> https://www.zhipin.com/web/geek/jobs
 *   2) 人工扫码登录一次（求职端）
 *   3) 复制 config.example.json 为 config.json 并按需修改
 *   4) node zp_daily.js
 *
 * ⚠️ 合规提示：本项目仅用于个人求职提效，请遵守平台用户协议；
 *    内置保守节奏与风控停车以保护账号，出现验证/异常提示请立即人工处理。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
function loadConfig() {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } };
  const cfg = read('config.json') || read('config.example.json');
  if (!cfg) { console.error('FATAL: no config.json (or config.example.json) found next to zp_daily.js'); process.exit(1); }
  return cfg;
}
const CFG = loadConfig();
const STATE = path.join(DIR, 'daily_state.json');
const REGISTRY = path.join(DIR, 'applied_registry.json');
const LOGF = path.join(DIR, 'daily.log');

const CDP = CFG.cdp || 'http://127.0.0.1:9335';
const DAILY_BUDGET = CFG.dailyBudget || 145;
const MIN_TARGET = CFG.minTarget || 120;
const WINDOWS = (CFG.windows || [['10:00', '11:30'], ['14:00', '16:30']]).map(w => w.map(t => {
  const [h, m] = t.split(':').map(Number); return h * 60 + m;
}));
const KEYWORDS = CFG.keywords || ['HRBP', '人力资源经理', '人事主管'];
const EXTRA_KEYWORDS = CFG.extraKeywords || ['人事专员', '招聘专员', 'HR'];
const CITY = CFG.city || '101280600';
let TITLE_BLOCK;
try { TITLE_BLOCK = new RegExp(CFG.titleBlock || '英语|English|日语|韩语|德语|法语|小语种|留学生|雅思|托福|外贸业务员|翻译|驻外|外派'); }
catch { console.error('FATAL: config.titleBlock is not a valid regex'); process.exit(1); }
const SAL_MIN_K = CFG.salaryMinK || 6;
const GAP_SEND = CFG.gapSend || [45, 95];
const GAP_SEND_FAST = CFG.gapSendFast || [32, 60];
const GAP_SKIP = CFG.gapSkip || [8, 20];
const STALL_MS = CFG.stallMs || 8 * 60 * 1000;

let GAP = GAP_SEND.slice();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const inWindow = () => WINDOWS.some(([a, b]) => nowMin() >= a && nowMin() < b);
const remainWindowMin = () => { const m = nowMin(); let t = 0; for (const [a, b] of WINDOWS) { if (m < a) t += b - a; else if (m < b) t += b - m; } return t; };
const LAST_WIN_END = Math.max(...WINDOWS.map(w => w[1]));
const LAST_WIN_START = Math.max(...WINDOWS.map(w => w[0]));
const FIRST_WIN_START = Math.min(...WINDOWS.map(w => w[0]));
const log = (s) => { const line = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${s}`; console.log(line); fs.appendFileSync(LOGF, line + '\n'); };

function alertPopup(title, text) {
  try {
    const dir = path.join(DIR, 'reports'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `alert-${Date.now()}.txt`);
    fs.writeFileSync(f, `${title}\r\n\r\n${text}`, 'utf8');
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, 'popup.ps1'), f],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('ALERT POPUP: ' + title);
  } catch (e) { log('alert fail: ' + e.message); }
}

// ---------- wave tracking ----------
let wave = null;
let loginWaitUntil = 0;
const newWave = () => ({ startMin: nowMin(), sent: 0, skipInactive: 0, skipSalary: 0, skipAlready: 0, noDlg: 0, verifyFail: 0, err: 0, stalls: 0, escalated: false, lastProgressAt: Date.now() });
function finishWave(reason) {
  if (!wave) return;
  const st = loadState(); const w = wave; wave = null;
  const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const dur = Math.max(1, nowMin() - w.startMin);
  const lines = [
    `投递波次报告  ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `窗口时段: ${hh(w.startMin)} - ${hh(nowMin())} (${dur} 分钟)`,
    `结束原因: ${reason}`, '—',
    `成功发送: ${w.sent}   今日累计 ${st.applied}/${DAILY_BUDGET}`,
    `跳过-无活跃 ${w.skipInactive} | 已聊过 ${w.skipAlready} | 薪资低 ${w.skipSalary} | 未确认 ${w.noDlg} | 验证失败 ${w.verifyFail}`,
    `异常轮 ${w.err} | 停滞恢复 ${w.stalls} | 提速升级: ${w.escalated ? '是' : '否'}`,
    `平均节奏: ${w.sent ? Math.round(dur * 60 / w.sent) : '-'} 秒/单`,
  ];
  if (st.applied < MIN_TARGET && reason.includes('结束')) lines.push(`⚠ 今日 ${st.applied} 份未达最低目标 ${MIN_TARGET}，请检查岗位池/登录态/风控`);
  const text = lines.join('\r\n');
  log('WAVE REPORT:\n' + text);
  try {
    const dir = path.join(DIR, 'reports'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `wave-${new Date().toISOString().slice(0, 10)}-${String(new Date().getHours()).padStart(2, '0')}${String(new Date().getMinutes()).padStart(2, '0')}.txt`);
    fs.writeFileSync(f, text, 'utf8');
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, 'popup.ps1'), f],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) { log('report write fail: ' + e.message); }
}

// ---------- state ----------
function loadState() {
  let st = { day: '', applied: 0, doneUrls: {}, kwIdx: 0, escalated: false };
  try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { }
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    for (const [u, v] of Object.entries(reg.urls || {})) if (!st.doneUrls[u]) st.doneUrls[u] = v;
  } catch { }
  const today = new Date().toISOString().slice(0, 10);
  if (st.day !== today) st = { day: today, applied: 0, doneUrls: st.doneUrls || {}, kwIdx: 0, escalated: false };
  return st;
}
const saveState = (st) => {
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    let dirty = false;
    for (const [u, v] of Object.entries(st.doneUrls)) {
      const s = String(v);
      if ((s.startsWith('applied') || s.startsWith('skipped')) && (!reg.urls[u] || s.startsWith('applied'))) {
        reg.urls[u] = /\d{4}/.test(s) ? s : `${s}-${st.day.slice(5, 10).replace('-', '')}`; dirty = true;
      }
    }
    if (dirty) fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
  } catch { }
};

// ---------- cdp ----------
async function getPage() {
  const r = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(8000) });
  const pages = (await r.json()).filter(p => p.type === 'page');
  return pages.find(p => p.url.includes('zhipin')) || pages[0] || null;
}
async function cdpSession() {
  const page = await getPage();
  if (!page) throw new Error('no page target — is Edge running with --remote-debugging-port?');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r, j) => {
    const i = ++id; const to = setTimeout(() => { pend.delete(i); j(new Error('cdp timeout ' + method)); }, 25000);
    pend.set(i, (m) => { clearTimeout(to); r(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  return { ws, send, ev };
}

// ---------- page ops ----------
async function ensureHealthy(s, kw) {
  await s.send('Runtime.enable'); await s.send('Page.enable');
  const ready = await s.ev(`document.readyState`);
  if (ready !== 'complete') {
    log('page stuck in ' + ready + ' — reloading');
    await s.send('Page.navigate', { url: `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(kw)}&city=${CITY}` });
    await sleep(jitter(8000, 11000));
  }
  return await s.ev(`({url: location.href,
    risk: /安全验证|滑动验证|访问异常|重新登录/.test(document.body.innerText.slice(0,3000)),
    logged: !location.href.includes('/web/user'),
    cap: /今日沟通.*(上限|已满)|沟通上限|已达.*上限/.test(document.body.innerText)})`);
}
async function loadCardList(s, kw) {
  await s.send('Page.navigate', { url: `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(kw)}&city=${CITY}` });
  await sleep(jitter(6000, 8500));
  for (let k = 0; k < 4; k++) { await s.ev(`window.scrollBy(0, innerHeight * 0.9)`); await sleep(jitter(1300, 2000)); }
  await s.ev(`window.scrollTo(0,0)`); await sleep(jitter(700, 1200));
  const list = await s.ev(`(()=>{
    return [...document.querySelectorAll('.job-card-wrap')].map(c=>{
      const a=c.querySelector('a.job-name'); if(!a) return null;
      const href=a.getAttribute('href')||''; if(!href.includes('/job_detail/')) return null;
      return { url:'https://www.zhipin.com'+href, path:href, title:(a.innerText||'').trim() };
    }).filter(Boolean);})()`);
  return list || [];
}
async function clickCard(s, path) {
  return await s.ev(`(async () => {
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const c=[...document.querySelectorAll('.job-card-wrap')].find(x=>{const a=x.querySelector('a.job-name');return a && a.getAttribute('href')===${JSON.stringify(path)}});
    if(!c) return false; c.scrollIntoView({block:'center'}); await sleep(700);
    const a=c.querySelector('a.job-name'); const r=a.getBoundingClientRect();
    if(r.y<0||r.y>innerHeight-40) return false;
    const o={bubbles:true,cancelable:true,view:window,clientX:r.x+r.width/2,clientY:r.y+r.height/2};
    a.dispatchEvent(new MouseEvent('mousedown',o)); await sleep(120);
    a.dispatchEvent(new MouseEvent('mouseup',o)); a.dispatchEvent(new MouseEvent('click',o));
    await sleep(3600); return true;})()`);
}
async function readPanel(s) {
  return await s.ev(`(() => {
    const box=document.querySelector('.job-detail-container, .job-detail-box'); if(!box) return null;
    const txt=box.innerText||'';
    const href=box.querySelector('a[href*="/job_detail/"]')?.getAttribute('href')||'';
    const active=(txt.match(/刚刚活跃|今日活跃|近日活跃|回复超快|今日回复\\d+次/)||[''])[0];
    const post=(txt.match(/发岗[期：:]*[\\d.]+\\s*(天|小时|分钟|个月|周)/)||[''])[0];
    const btn=[...box.querySelectorAll('a,button,span')].find(e=>/^(立即沟通|继续沟通)$/.test((e.innerText||'').trim())&&e.offsetParent);
    const sal=(txt.match(/\\d+-\\d+K(?:·\\d+薪)?/)||[''])[0];
    return {href, active, post, sal, btn:(btn?.innerText||'').trim(), head:txt.slice(0,60)};})()`);
}
async function measureBtn(s) {
  return await s.ev(`(() => {
    const box=document.querySelector('.job-detail-container, .job-detail-box'); if(!box) return null;
    const btn=[...box.querySelectorAll('a,button,span')].find(e=>/^(立即沟通|继续沟通)$/.test((e.innerText||'').trim())&&e.offsetParent);
    if(!btn) return null; const r=btn.getBoundingClientRect();
    return { text:(btn.innerText||'').trim(), x:r.x+r.width/2, y:r.y+r.height/2 };})()`);
}
async function confirmSent(s) {
  for (let k = 0; k < 3; k++) {
    await sleep(jitter(1800, 2600));
    const post = await s.ev(`(() => {
      const body = document.body.innerText;
      const dlg = body.includes('已向BOSS发送消息') || body.includes('沟通成功') || body.includes('已发送');
      const cont = [...document.querySelectorAll('a,button,span')].some(e => (e.innerText || '').trim() === '继续沟通' && e.offsetParent);
      const chat = location.href.includes('geek/chat') || !!document.querySelector('[class*=chat-box], [class*=chat-content]');
      return { dlg, cont, chat };})()`);
    if (post && (post.dlg || post.cont || post.chat)) return true;
  }
  return false;
}

// ---------- escalation ----------
function checkEscalation(st) {
  if (st.escalated || !wave) return;
  const remain = remainWindowMin(); const left = DAILY_BUDGET - st.applied;
  if (remain <= 0 || left <= 0) return;
  const elapsed = Math.max(1, nowMin() - wave.startMin);
  const projected = st.applied + (wave.sent / elapsed) * remain;
  if (projected < MIN_TARGET && nowMin() >= LAST_WIN_START) {
    st.escalated = true; saveState(st); wave.escalated = true;
    GAP = GAP_SEND_FAST;
    log(`ESCALATE: projected ${Math.round(projected)} < ${MIN_TARGET}. faster cadence + widened keywords.`);
    alertPopup('投递提速已自动启动', `预计今日 ${Math.round(projected)} 份低于目标 ${MIN_TARGET}。\n已自动缩短间隔并启用扩展关键词。`);
  }
}

// ---------- card ----------
async function processCard(s, cand, st) {
  if (st.doneUrls[cand.url]) return 'skip';
  if (!(await clickCard(s, cand.path))) { st.doneUrls[cand.url] = 'reopen-fail'; return 'fail'; }
  const info = await readPanel(s);
  if (!info || !info.href || !info.href.includes(cand.path.replace('.html', ''))) { st.doneUrls[cand.url] = 'verify-fail'; wave.verifyFail++; return 'fail'; }
  if (info.btn === '继续沟通') { st.doneUrls[cand.url] = 'applied-already'; wave.skipAlready++; return 'skip'; }
  if (TITLE_BLOCK.test(cand.title)) { st.doneUrls[cand.url] = 'skipped-blocktitle'; return 'skip'; }
  const hot = /刚刚活跃|今日活跃|回复超快/.test(info.active);
  const ok = hot || /天|小时|分钟/.test(info.post) || info.active === '近日活跃';
  const m = info.sal.match(/^(\d+)-(\d+)K/);
  if (m && parseInt(m[1]) < SAL_MIN_K) { st.doneUrls[cand.url] = 'skipped-salary'; wave.skipSalary++; return 'skip'; }
  if (!ok) { st.doneUrls[cand.url] = 'skipped-inactive'; wave.skipInactive++; return 'skip'; }

  await sleep(jitter(3500, 7000));
  const btnNow = await measureBtn(s);
  if (!btnNow) { st.doneUrls[cand.url] = 'btn-lost'; wave.verifyFail++; return 'fail'; }
  if (btnNow.text === '继续沟通') { st.doneUrls[cand.url] = 'applied-already'; wave.skipAlready++; return 'skip'; }
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await s.send('Input.dispatchMouseEvent', { type: t, x: btnNow.x + (t === 'mouseMoved' ? -11 : 0), y: btnNow.y + (t === 'mouseMoved' ? -7 : 0), button: t === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    await sleep(jitter(90, 230));
  }
  const sent = await confirmSent(s);
  await s.ev(`(()=>{const b=[...document.querySelectorAll('a,button,span')].find(e=>(e.innerText||'').trim()==='留在此页'&&e.offsetParent); if(b)b.click();})()`);
  if (sent) {
    st.applied++; wave.sent++; wave.lastProgressAt = Date.now();
    st.doneUrls[cand.url] = 'applied';
    log(`SENT ${st.applied}/${DAILY_BUDGET} [${info.active}] ${cand.title} | ${info.sal || '?'}`);
    if (st.applied === 110) alertPopup('接近平台上限预警', `今日已投 ${st.applied} 份，平台可能在 120 前后弹出上限提醒，脚本将自动停车。`);
    return 'sent';
  }
  st.doneUrls[cand.url] = 'click-no-dialog'; wave.noDlg++;
  log(`NODLG ${cand.url} [${info.active}] ${cand.title}`);
  return 'nodlg';
}

// ---------- batch ----------
async function runBatch() {
  let st = loadState();
  if (st.escalated) GAP = GAP_SEND_FAST;
  const kws = st.escalated ? KEYWORDS.concat(EXTRA_KEYWORDS) : KEYWORDS;
  const kw = kws[st.kwIdx % kws.length];
  let s = await cdpSession();
  try {
    const health = await ensureHealthy(s, kw);
    if (!health) throw new Error('health undefined');
    if (!health.logged) {
      // first-run / expired session: wait for the user to scan-login instead of dying
      if (!loginWaitUntil) loginWaitUntil = Date.now() + 10 * 60000;
      const left = Math.ceil((loginWaitUntil - Date.now()) / 60000);
      if (loginWaitUntil > Date.now()) {
        log(`not logged in — waiting ${left}min for you to scan the QR code in Edge…`);
        s.ws.close(); return 'wait-login';
      }
      finishWave('登录态失效'); alertPopup('需要重新扫码登录', 'Boss直聘登录态失效/未登录，等待 10 分钟无人扫码，投递已暂停。\n请在 Edge 窗口扫码登录后重新运行 node zp_daily.js。');
      s.ws.close(); process.exit(0);
    }
    loginWaitUntil = 0;
    if (health.risk) { finishWave('风控信号安全停车'); alertPopup('风控信号已停车', '检测到安全验证/异常页面，已停车保护账号。请人工查看 Edge。'); s.ws.close(); process.exit(0); }
    if (health.cap) { finishWave('平台沟通上限提醒'); alertPopup('平台沟通上限', `今日已投 ${st.applied} 份，达到平台提示上限，今日收工。`); s.ws.close(); process.exit(0); }

    const list = await loadCardList(s, kw);
    if (!list.length) {
      const sanity = await s.ev(`(() => ({
        hasJobLinks: document.querySelectorAll('a[href*="/job_detail/"]').length,
        hasCards: document.querySelectorAll('.job-card-wrap').length,
        needLogin: location.href.includes('/web/user'),
      }))()`);
      if (sanity && sanity.hasJobLinks > 0 && sanity.hasCards === 0) {
        log('DOM SELECTOR DRIFT: page has job links but .job-card-wrap is gone — BOSS likely updated its frontend.');
        alertPopup('页面结构已变更', 'Boss直聘前端改版，卡片选择器失效。\n请更新 zp_daily.js 中的 .job-card-wrap / a.job-name / .job-detail-container 选择器。');
        s.ws.close(); process.exit(4);
      }
    }
    const todo = list.filter(c => !st.doneUrls[c.url]);
    log(`kw[${kw}] cards=${list.length} todo=${todo.length}`);
    if (!todo.length) { st.kwIdx++; st.emptyRounds = (st.emptyRounds || 0) + 1; saveState(st); s.ws.close(); return 'rotate'; }
    st.emptyRounds = 0; saveState(st);

    let processed = 0;
    for (const cand of todo) {
      st = loadState();
      if (st.applied >= DAILY_BUDGET) { finishWave('今日预算用尽'); s.ws.close(); process.exit(0); }
      if (!inWindow()) { s.ws.close(); return 'window-end'; }
      checkEscalation(st);
      if (Date.now() - wave.lastProgressAt > STALL_MS) {
        wave.stalls++; wave.lastProgressAt = Date.now();
        log(`STALL (>8min no send) — rotate kw. stalls=${wave.stalls}`);
        if (wave.stalls >= 3) alertPopup('投递停滞报警', `连续 ${wave.stalls} 次 8 分钟无成功发送（applied=${st.applied}）。已自动换词重载，若持续请人工查看 Edge。`);
        st.kwIdx++; saveState(st); s.ws.close(); return 'rotate';
      }
      try {
        const r = await processCard(s, cand, st);
        saveState(st); processed++;
        await sleep(jitter(...(r === 'sent' ? GAP : GAP_SKIP)) * 1000);
        if (processed % 6 === 0) {
          const h2 = await s.ev(`({risk: /安全验证|滑动验证|访问异常/.test(document.body.innerText), cap: /沟通上限|今日沟通.*(上限|已满)/.test(document.body.innerText)})`);
          if (h2?.risk) throw new Error('RISK');
          if (h2?.cap) { finishWave('平台沟通上限提醒'); s.ws.close(); process.exit(0); }
        }
      } catch (e) {
        wave.err++; saveState(st);
        if (e.message === 'RISK') { finishWave('风控信号安全停车'); alertPopup('风控信号已停车', '投递中途检测到安全验证，已停车保护账号。'); try { s.ws.close(); } catch { } process.exit(0); }
        log('card error: ' + e.message + ' — reconnect next batch');
        s.ws.close(); return 'reconnect';
      }
    }
    s.ws.close(); st.kwIdx++; saveState(st);
    return 'rotate';
  } catch (e) { try { s.ws.close(); } catch { } throw e; }
}

// ---------- main ----------
async function main() {
  let st = loadState();
  log(`start. applied today=${st.applied}/${DAILY_BUDGET} inWindow=${inWindow()}`);
  if (inWindow()) wave = newWave();
  let poolWaitUntil = 0;
  while (true) {
    st = loadState();
    if (st.applied >= DAILY_BUDGET) { if (wave) finishWave('今日预算用尽'); log('BUDGET EXHAUSTED — exiting.'); break; }
    if (!inWindow()) {
      const m = nowMin();
      if (wave) finishWave(m >= LAST_WIN_END ? '最后窗口结束' : '窗口结束');
      if (m >= LAST_WIN_END) {
        if (st.applied < MIN_TARGET && !st.shortfallAlerted) {
          st.shortfallAlerted = true; saveState(st);
          alertPopup('今日未达投递目标', `今日发送 ${st.applied} 份 < 目标 ${MIN_TARGET}。请查看 reports/ 与 daily.log。`);
        }
        log('day windows done — overnight watch');
        await sleep(15 * 60000); continue;
      }
      log('outside window, sleeping 5min…'); await sleep(300000);
      if (inWindow() && !wave) { wave = newWave(); log('new window — wave started.'); }
      continue;
    }
    if (!wave) wave = newWave();
    if (Date.now() < poolWaitUntil) { await sleep(60000); continue; }
    try {
      const r = await runBatch();
      if (r === 'wait-login') { await sleep(30000); continue; }
      if (r === 'rotate') {
        st = loadState();
        const kws = st.escalated ? KEYWORDS.length + EXTRA_KEYWORDS.length : KEYWORDS.length;
        if ((st.emptyRounds || 0) >= kws * 2) {
          st.emptyRounds = 0; saveState(st);
          log('pool exhausted — 12min refresh wait');
          poolWaitUntil = Date.now() + 12 * 60000;
        }
      }
    } catch (e) { if (wave) wave.err++; log('batch error: ' + e.message + ' — 45s cooldown'); await sleep(45000); }
  }
  log('runner exit.');
}
main().catch(e => { log('FATAL ' + e.message); process.exit(1); });
