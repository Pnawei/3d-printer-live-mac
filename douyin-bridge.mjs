#!/usr/bin/env node
// 抖音直播数据桥：从本机浏览器的直播间页面读取弹幕/点赞/礼物，转发给头像打印机。
// 用法：node douyin-bridge.mjs [房间号] [WS端口]（房间号也可写入 .bridge-room 文件），端口默认 8765
// 浏览器优先级：BrowserOS neo(:9110) → 已开调试端口的 Chromium(:9222) → 自建无头 Chrome(:9223)
// 页面(http://127.0.0.1:8080)会自动连接 ws://127.0.0.1:8765，无需手动操作。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startWSServer } from './bridge-ws.mjs';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOM_RE = /live\.douyin\.com\/(\d+)/;
// macOS 上可用的 Chromium 内核浏览器（用于自建直播间抓取窗口）。
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
].filter(p => p);

// —— 纯解析函数（供测试） ——

export function parseChatLine(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/欢迎来到直播间|严禁|未成年人|网络诈骗|理性消费|新功能|三屏|点击体验/.test(text) || /^(新功能|提示|公告|系统)\s*[：:]/.test(text)) return { kind: 'system', text };
  let m = text.match(/^(.{1,24}?)\s*[：:]\s*(.*)$/);
  if (m) {
    const name = m[1].trim(), body = m[2].trim();
    if (!name || isJunkName(name)) return null;
    const g = body.match(/^(?:送出|送了|送给主播)了?\s*(.+?)(?:\s*[xX×]\s*(\d{1,3}))?$/);
    if (g && g[1].trim()) return { kind: 'gift', name, gift: g[1].trim(), count: g[2] ? +g[2] : 1 };
    if (/^(关注了主播|关注了直播间|成为新粉丝)/.test(body)) return { kind: 'follow', name };
    if (!body) return null;
    return { kind: 'comment', name, text: body };
  }
  m = text.match(/^(.{1,24}?)\s*(?:送出|送了|送给主播)了?\s*(.+?)(?:\s*[xX×]\s*(\d{1,3}))?$/);
  if (m && m[2].trim() && !isJunkName(m[1].trim())) return { kind: 'gift', name: m[1].trim(), gift: m[2].trim(), count: m[3] ? +m[3] : 1 };
  m = text.match(/^(.{1,20}?)\s*来了$/);
  if (m) return { kind: 'join', name: m[1].trim() };
  m = text.match(/^(.{1,24}?)\s*(?:关注了主播|关注了直播间|成为新粉丝|推荐了直播)/);
  if (m) return { kind: 'follow', name: m[1].trim() };
  return null;
}

export function mapGift(name) {
  if (/啤酒/.test(name)) return 'beer';
  if (/棒棒糖/.test(name)) return 'lollipop';
  if (/爱心|红心|心心/.test(name)) return 'heart';
  return 'other';
}

// 垃圾名判定：feed卡标签、动作短语等不是观众昵称。
export function isJunkName(n) {
  if (!n) return true;
  const s = String(n);
  if (/充钻石|客户端|壁纸通知|消息投稿|互相关注|粉丝团|账号已在其他地方|进入直播间|扫码登录/.test(s)) return true;
  if (s.length < 1 || s.length > 24) return true;
  if (/^(送出了?|送了|来了|关注|粉丝|评论|分享|关注了.*)$/.test(s)) return true;
  if (/分享\[视频\]|前天分享|小时榜|人气榜|本场点赞|在线观众|贡献/.test(s)) return true;
  if (!/[\u{4e00}-\u{9fff}a-zA-Z]/u.test(s)) return true;
  return false;
}

// 昵称归一化：去掉空格与装饰 emoji，用于弹幕昵称 ↔ 观众面板头像的模糊匹配。
export function normKey(name) {
  return String(name || '').replace(/[\s\u3000]+/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '');
}

// —— 协议级解码：通用 protobuf 遍历 + 直播间 WebSocket 帧 → 用户(昵称,头像) ——
export function pbDecode(buf) {
  const fields = [];
  let i = 0;
  try {
    while (i < buf.length) {
      let key = 0, shift = 0, byte;
      do { if (i >= buf.length) return fields; byte = buf[i++]; key |= (byte & 0x7f) << shift; shift += 7; if (shift > 35) return fields; } while (byte & 0x80);
      const fieldNum = key >>> 3, wire = key & 7;
      if (fieldNum === 0) return fields;
      if (wire === 0) { let v = 0n, s = 0n; do { if (i >= buf.length) return fields; byte = buf[i++]; v |= BigInt(byte & 0x7f) << s; s += 7n; } while (byte & 0x80); fields.push({ n: fieldNum, wire, num: v }); }
      else if (wire === 1) { if (i + 8 > buf.length) return fields; i += 8; fields.push({ n: fieldNum, wire, buf: buf.subarray(i - 8, i) }); }
      else if (wire === 2) { let len = 0, sh = 0; do { if (i >= buf.length) return fields; byte = buf[i++]; len |= (byte & 0x7f) << sh; sh += 7; } while (byte & 0x80); if (i + len > buf.length) return fields; fields.push({ n: fieldNum, wire, buf: buf.subarray(i, i + len) }); i += len; }
      else if (wire === 5) { if (i + 4 > buf.length) return fields; i += 4; fields.push({ n: fieldNum, wire, buf: buf.subarray(i - 4, i) }); }
      else return fields;
    }
  } catch { }
  return fields;
}

function imageUrl(buf, depth = 0) {
  if (depth > 5) return '';
  const text = buf.toString('utf8');
  if (/^https?:\/\/[^\s]+$/.test(text) && /douyinpic|byteimg|douyinstatic/.test(text)) return text;
  for (const field of pbDecode(buf)) {
    if (field.wire !== 2 || !field.buf) continue;
    const url = imageUrl(field.buf, depth + 1);
    if (url) return url;
  }
  return '';
}

// 头像 URL 特征：aweme 用户头像或 webcast 用户头像；勋章/等级/标签/礼物图一律不算。
export function isExplicitAvatarUrl(u) { return /(aweme-avatar|tos-cn-avt|\/aweme\/100x100\/|sc=avatar)/i.test(String(u || '')); }

export function isAvatarUrl(u) {
  const s = String(u || '');
  if (!s) return false;
  if (/(aweme-avatar|\/aweme\/100x100\/|sc=avatar)/i.test(s)) return true;
  return /img\/webcast\/[a-f0-9]{16,}\./i.test(s) && !/(grade|badge|medal|icon|label|gift|effect|frame|banner)/i.test(s);
}

// 递归收集缓冲里所有"User 形状"的结构：#3 是昵称，#9/10/11/6 内嵌头像 URL。
// 注意不能在消息体顶层找 #3——ChatMessage 的 #3 是弹幕文本，会张冠李戴。
export function collectUsers(buf, depth = 0) {
  const out = [];
  if (depth > 8) return out;
  const fields = pbDecode(buf);
  const nickname = fields.find(f => f.n === 3 && f.wire === 2)?.buf?.toString('utf8');
  if (nickname && nickname.length <= 40 && !/[\x00-\x1f\ufffd]/.test(nickname) && !/^https?:/.test(nickname)) {
    for (const n of [9, 10, 11, 6]) {
      const field = fields.find(f => f.n === n && f.wire === 2);
      const avatar = field?.buf && imageUrl(field.buf);
      if (avatar && isAvatarUrl(avatar)) { out.push({ name: nickname, avatar }); break; }
    }
  }
  for (const f of fields) {
    if (f.wire !== 2 || !f.buf?.length || f.buf.length < 16) continue;
    out.push(...collectUsers(f.buf, depth + 1));
  }
  return out;
}

export function extractUser(buf, depth = 0) {
  return collectUsers(buf, depth)[0] || null;
}

// 从 gzip 解包后的 protobuf 里找出所有 {方法名, 消息体} 信封再回调。
// 信封特征：#1 恰好是 "WebcastXxxMessage" 字符串、#2 是消息体。
// 绝不能用"头部含 Webcast 字样"来匹配——每条消息体内部的 Common 结构也嵌着同名方法串，
// 旧代码因此把真正的消息体也当方法串跳过，协议级解码从未命中过一条消息。
function eachEnvelope(buf, cb, depth = 0) {
  if (depth > 4) return;
  for (const f of pbDecode(buf)) {
    if (f.wire !== 2 || !f.buf || f.buf.length < 24) continue;
    const sub = pbDecode(f.buf);
    const method = sub.find(s => s.n === 1 && s.wire === 2)?.buf?.toString('utf8');
    if (method && /^Webcast\w{1,30}Message$/.test(method)) {
      const pl = sub.find(s => s.n === 2 && s.wire === 2 && s.buf && s.buf.length >= 12);
      if (pl) { cb(method, pl.buf); continue; }
    }
    if (f.buf.length > 40) eachEnvelope(f.buf, cb, depth + 1);
  }
}

function handleWSFrame(buf) {
  try {
    let payload = buf;
    const idx = buf.indexOf(Buffer.from([0x1f, 0x8b]));
    if (idx >= 0) { try { payload = zlib.gunzipSync(buf.subarray(idx)); } catch { return } }
    eachEnvelope(payload, (method, pl) => {
      const mt = method.match(/^Webcast(Chat|Like|Member|Social|Gift|RoomUserSeq)Message$/);
      if (!mt) return;
      // 消息体里每个 User 结构都自带头像，全部喂进花名册（RoomUserSeq 一次带多名活跃观众）。
      const users = collectUsers(pl);
      for (const u of users) feedAvatar(u.name, u.avatar, '协议帧');
      const type = mt[1] === 'Like' ? 'like' : mt[1] === 'Social' ? 'follow' : mt[1] === 'Member' ? 'join' : null;
      const actor = users[0];
      if (!actor || !type) return;
      if (type === 'like') emitLike(actor);
      else if (type === 'follow') emitFollow(actor);
      else if (type === 'join') emitJoinWS(actor);
    });
  } catch { }
}

const normMap = new Map();
// 头像持久缓存：跨重启、跨房间复用已抓到的头像，回访观众零延迟命中。
const AVATAR_CACHE_FILE = path.join(__dirname, 'avatar-cache.json');
const AVATAR_CACHE_MAX = 3000;
const avatarCache = new Map(), avatarCacheNorm = new Map();
let cacheDirty = false;
function loadAvatarCache() {
  try {
    const data = JSON.parse(fs.readFileSync(AVATAR_CACHE_FILE, 'utf8'));
    for (const [n, a] of Object.entries(data.items || {})) {
      if (typeof a !== 'string' || !isExplicitAvatarUrl(a) || isJunkName(n)) continue;
      avatarCache.set(n, a);
      const k = normKey(n);
      if (k && !avatarCacheNorm.has(k)) avatarCacheNorm.set(k, a);
    }
    if (avatarCache.size) console.log('[' + stamp() + '] 📦 已载入历史头像缓存 %d 人（回访观众秒出头像）', avatarCache.size);
  } catch { }
}
function saveAvatarCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  try {
    const items = {};
    let i = 0;
    for (const [n, a] of avatarCache) { items[n] = a; if (++i >= AVATAR_CACHE_MAX) break; }
    const tmp = AVATAR_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), items }));
    fs.renameSync(tmp, AVATAR_CACHE_FILE);
  } catch { }
}
function feedAvatarCache(name, avatar) {
  if (avatarCache.get(name) !== avatar) {
    avatarCache.delete(name);
    avatarCache.set(name, avatar);
    cacheDirty = true;
  }
  const k = normKey(name);
  if (k) { avatarCacheNorm.delete(k); avatarCacheNorm.set(k, avatar); }
}
// 事件现场按昵称查历史缓存；命中就顺势灌进本房间的 avatars，后续直接走内存。
function lookupAvatar(name) {
  const k = normKey(name);
  const hit = avatarCache.get(name) || (k && avatarCacheNorm.get(k)) || '';
  if (hit && !avatars[name]) avatars[name] = hit;
  return hit || '';
}
function feedAvatar(name, avatar, via = '页面') {
  if (!name || !avatar || isJunkName(name)) return;
  const k = normKey(name);
  if (avatars[name] !== avatar) avatars[name] = avatar;
  if (k) normMap.set(k, avatar);
  feedAvatarCache(name, avatar);
  if (roster.get(name) !== avatar) {
    if (!roster.has(name)) {
      likeState.used.clear();
      console.log('[' + stamp() + '] 🧑 首次入库 %s 的头像（%s）', name, via);
    }
    roster.set(name, avatar);
    lastSeen.set(name, Date.now());
  }
}

function emitLike(user) {
  const nowMs = Date.now();
  likeTokens = Math.min(20, likeTokens + (nowMs - likeTokensAt) / 400);
  likeTokensAt = nowMs;
  const allowed = Math.min(3, Math.floor(likeTokens));
  likeTokens -= allowed;
  lastWsLikeAt = nowMs;
  if (allowed <= 0) {
    if (nowMs - lastThrottleLog > 10000) { lastThrottleLog = nowMs; console.log('[' + stamp() + '] ❤️ 点赞高峰限速中'); }
    return;
  }
  total.like += allowed;
  lastEventAt = nowMs;
  hubRef.broadcast({ type: 'like', name: user.name, avatar: user.avatar || '', count: allowed });
  console.log('[' + stamp() + '] ❤️ %s 点赞 +%d（协议级）', user.name, allowed);
}

function emitFollow(user) {
  if (!user || !user.name) return;
  total.join++;
  lastEventAt = Date.now();
  hubRef.broadcast({ type: 'follow', name: user.name, avatar: user.avatar || '' });
  console.log('[' + stamp() + '] ⭐ %s 关注了直播间 → 打印头像', user.name);
}

function emitJoinWS(user) {
  if (!user || !user.name) return;
  lastWsJoinAt = Date.now();
  total.join++;
  lastEventAt = Date.now();
  hubRef.broadcast({ type: 'join', name: user.name, avatar: user.avatar || '' });
  console.log('[' + stamp() + '] 👋 %s 进入直播间（协议级）', user.name);
}

export function parseLike(text) {
  const m = String(text || '').match(/([\d.]+)(万)?\s*本场点赞/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  return Math.round(v * (m[2] ? 10000 : 1));
}

// 从弹幕行列表里找出新行：从末尾向前扫到已见签名即停；签名缓冲防重复。
export function diffNew(lines, seen, cap = 80) {
  const fresh = [];
  for (let i = lines.length - 1; i >= 0 && fresh.length < cap; i--) {
    if (seen.has(lines[i])) break;
    fresh.unshift(lines[i]);
  }
  for (const sig of fresh) seen.add(sig);
  while (seen.size > 600) seen.delete(seen.values().next().value);
  return fresh;
}

// 点赞无法从页面获知点赞人：在累积观众花名册上公平轮换，同一人最多连续 cap 次，
// 所有人用满后开新一轮；一轮内打不完的点赞直接丢弃（避免同一人刷屏）。
export function allocateLikes(delta, roster, state, cap = 3) {
  const events = [];
  let assigned = 0, passes = 0;
  const capFor = e => (e[1] ? cap : 1);
  const maxScan = roster.reduce((s, e) => s + capFor(e), 0);
  while (assigned < delta && passes < 2 && roster.length) {
    let scanned = 0;
    while (assigned < delta && scanned < maxScan) {
      if (state.idx >= roster.length) state.idx = 0;
      const entry = roster[state.idx];
      state.idx = (state.idx + 1) % roster.length;
      scanned++;
      const used = state.used.get(entry[0]) || 0;
      if (used >= capFor(entry)) continue;
      state.used.set(entry[0], used + 1);
      const last = events[events.length - 1];
      if (last && last.name === entry[0]) last.count++;
      else events.push({ name: entry[0], avatar: entry[1], count: 1 });
      assigned++;
    }
    if (assigned < delta) {
      state.used.clear();
      passes++;
    } else break;
  }
  return events;
}

// —— 页面内采集脚本（不依赖混淆类名，按文本特征定位） ——

const COLLECT = String.raw`(() => {
  const out = { likes: null, lines: [], avatars: {}, owner: '', href: location.href };
  const om = document.title.match(/^(.+?)的抖音直播间/);
  if (om) out.owner = om[1];
  for (const e of document.querySelectorAll('span,div,b,p')) {
    if (e.children.length) continue;
    const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length < 20 && t.indexOf('本场点赞') >= 0) { const m = t.match(/([\d.]+)(万)?\s*本场点赞/); if (m) out.likes = Math.round(parseFloat(m[1]) * (m[2] ? 10000 : 1)); break; }
  }
  const single = t => /^.{1,24}[：:][^：:]{0,80}$/.test(t) || /^.{1,24}(送出|送了)\s*[^：:]{1,20}(\s*[xX×]\s*\d{1,3})?$/.test(t) || /^.{1,20}来了$/.test(t);
  const tick = (window.__scanTick = (window.__scanTick || 0) + 1);
  if (tick % 4 === 1 || !window.__chatRoot || !window.__chatRoot.isConnected) {
    let best = null, bestN = 0;
    for (const c of document.querySelectorAll('div')) {
      let n = 0;
      for (const k of c.children) { const t = (k.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length <= 90 && single(t)) n++; }
      if (n > bestN) { bestN = n; best = c; }
    }
    window.__chatRoot = best;
  }
  const chatRoot = window.__chatRoot;
  const scope = chatRoot || document;
  const leaves = [...scope.querySelectorAll('span,div')].filter(e => !e.children.length);
  const seeds = leaves.filter(e => { const t = (e.textContent || '').replace(/\s+/g, ' ').trim(); return t && t.length <= 90 && (/[：:]/.test(t) || /(送出|送了)/.test(t) || /来了$/.test(t)); });
  const bestSet = new Set();
  for (const e of seeds) {
    let best = e;
    let n = e.parentElement;
    while (n && n !== document.body && (!chatRoot || chatRoot.contains(n))) {
      const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 90 && single(t)) { best = n; n = n.parentElement; } else break;
    }
    bestSet.add(best);
  }
  const chosen = [...bestSet].filter(a => ![...bestSet].some(b => b !== a && b.contains(a)));
  out.lines = chosen.map(n => (n.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (tick % 2 === 0 || !window.__avMap) {
    const av = {};
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (src.indexOf('douyinpic.com') < 0) continue;
      if (!/(aweme-avatar|tos-cn-avt|sc=avatar)/i.test(src)) continue;
      if (/grade_level|badge|medal|icon|\.svg|ranklist/i.test(src)) continue;
      let n = img.parentElement, name = '';
      for (let i = 0; i < 5 && n && !name; i++) {
        const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
        if (/\d+\s*钻|充值|礼物周榜|小时榜|人气榜/.test(t) || t.length > 40) { n = n.parentElement; continue; }
        const m = t.match(/^([^：:\s]{1,24})/);
        if (m && m[1]) {
        const c = m[1].replace(/关注\d*粉丝\d*.*$/, '').replace(/\d{1,2}\/\d{1,2}.*$/, '').replace(/暂不支持.*$/, '').replace(/来了$/, '').replace(/\d+天前.*/, '').replace(/分享\[视频\]/, '').replace(/在线$/, '').trim();
        if (c.length >= 1 && c.length <= 20 && /[\u4e00-\u9fa5A-Za-z]/.test(c) && !/^用户\d{6,}$/.test(c) && !/^(送出了?|送了|来了|关注|粉丝|评论|分享)$/.test(c) && !/分享\[|前天|小时榜|人气榜|本场点赞|在线观众|贡献/.test(c)) name = c;
        }
        n = n.parentElement;
      }
      if (name && !av[name]) av[name] = src;
    }
    window.__avMap = av;
  }
  Object.assign(out.avatars, window.__avMap || {});
  if (tick % 40 === 7) {
    const hdr = [...document.querySelectorAll('div,span')].find(e => /在线观众/.test(e.textContent || '') && (e.textContent || '').length < 30);
    if (hdr) { for (const ty of ['mousedown', 'mouseup', 'click']) { try { hdr.dispatchEvent(new MouseEvent(ty, { bubbles: true, cancelable: true })) } catch (e) { } } }
  }
  if (tick % 8 === 0) {
    for (const d of document.querySelectorAll('div')) {
      if (chatRoot && (chatRoot.contains(d) || d.contains(chatRoot))) continue;
      if (d.scrollHeight > d.clientHeight + 60 && d.clientHeight > 80 && d.querySelectorAll('img').length >= 2) {
        if (!d.__scanDir) d.__scanDir = 1;
        d.scrollTop += d.__scanDir * 300;
        if (d.scrollTop + d.clientHeight >= d.scrollHeight - 4) d.__scanDir = -1;
        else if (d.scrollTop <= 0) d.__scanDir = 1;
      }
    }
  }
  return out;
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);

function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function listPages(port) {
  const list = await getJson('http://127.0.0.1:' + port + '/json/list');
  return (Array.isArray(list) ? list : []).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function openTab(port, url) {
  try {
    await getJson('http://127.0.0.1:' + port + '/json/new?url=' + encodeURIComponent(url), 'PUT');
  } catch {
    await getJson('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url)).catch(() => { });
  }
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const hit = (await listPages(port)).find(t => (t.url || '').indexOf(url.replace(/^https?:\/\//, '').split('?')[0]) >= 0);
      if (hit) return hit;
    } catch { return null }
  }
  return null;
}

async function findTarget(room) {
  const roomUrl = 'https://live.douyin.com/' + room;
  for (const port of (process.env.PRINTER_CDP_PORT ? [Number(process.env.PRINTER_CDP_PORT)] : [9223, 9110, 9222])) {
    let pages;
    try { pages = await listPages(port) } catch { continue }
    let hit = pages.find(t => { const m = (t.url || '').match(ROOM_RE); return m && m[1] === room });
    if (!hit && process.env.PRINTER_CDP_PORT) continue;
    if (!hit) {
      console.log('[' + stamp() + '] 在 :' + port + ' 没找到房间标签页，新开一个（不动你已开的页面）…');
      hit = await openTab(port, roomUrl);
      if (!hit) continue;
    }
    return { port, target: hit };
  }
  return null;
}

async function launchStandaloneChrome(room) {
  const exe = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) throw new Error('没有可用的 CDP 浏览器，也未找到 Chrome/Edge 可执行文件');
  const dir = path.join(__dirname, '.bridge-profile');
  fs.mkdirSync(dir, { recursive: true });
  console.log('[' + stamp() + '] 弹出直播间窗口(:9223)…可在里面登录抖音，登录后头像抓取更全');
  spawn(exe, [
    '--remote-debugging-port=9223', '--user-data-dir=' + dir,
    '--no-first-run', '--no-default-browser-check', '--lang=zh-CN',
    '--window-position=120,90', '--window-size=1180,800',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
    'https://live.douyin.com/' + room
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    try { await getJson('http://127.0.0.1:9223/json/version'); return } catch { }
  }
  throw new Error('自建浏览器启动超时');
}

function attachCDP(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let mid = 0;
    const pend = new Map();
    const rpc = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++mid;
      pend.set(id, { res, rej });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
    ws.onopen = async () => {
      try {
        await rpc('Runtime.enable');
        await rpc('Network.enable');
        resolve({ ws, rpc });
      } catch (e) { reject(e) }
    };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id);
        pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message || 'cdp error')) : p.res(m.result);
        return;
      }
      if (m.method && cdpEventSink) { try { cdpEventSink(m) } catch { } }
    };
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
  });
}

let currentRoom = '';
let hubRef = null; // 模块级 hub 引用：emitLike/pollFollowers 等在 run() 外也要能广播（原先引用未定义的 hub 会抛错被吞）。
let cdpRef = null;
export function _injectCdpForTest(ref) { cdpRef = ref; }
export function _handleWSFrameForTest(buf) { handleWSFrame(buf) }
export function _injectHubForTest(h) { hubRef = h }
export function _avatarStateForTest() { return { avatars: { ...avatars }, roster: [...roster.entries()], cache: [...avatarCache.entries()], normMap: [...normMap.entries()] } }
let lastLikes = null, clientCount = 0, chatSeen = false, historySkipped = false, owner = '';
const roster = new Map(), likeState = { idx: 0, used: new Map() }, lastSeen = new Map();
const seen = new Set(), avatars = {};
const total = { comment: 0, gift: 0, like: 0, join: 0 };
let likeTokens = 20, likeTokensAt = Date.now(), lastThrottleLog = 0, lastEventAt = 0, lastNavFix = 0, lastWsLikeAt = 0, lastWsJoinAt = 0, cdpEventSink = null, lastFollowerCount = null, lastFollowerPoll = 0;

function resetRoomState() {
  lastLikes = null; chatSeen = false; historySkipped = false; owner = '';
  roster.clear(); lastSeen.clear(); seen.clear();
  for (const k of Object.keys(avatars)) delete avatars[k];
  likeState.used.clear(); likeState.idx = 0;
  hoverTried.clear();
  total.comment = total.gift = total.like = total.join = 0;
}

// 关注检测：轮询登录账号菜单里的粉丝数，涨粉即打印头像（归属最近活跃观众）。
async function pollFollowers() {
  if (!cdpRef || !owner) return;
  if (Date.now() - lastFollowerPoll < 30000) return;
  lastFollowerPoll = Date.now();
  try {
    const posRaw = (await cdpRef.rpc('Runtime.evaluate', {
      expression: `(() => {
        const imgs = [...document.querySelectorAll('img')].filter(i => { const r = i.getBoundingClientRect(); return r.top < 130 && r.left > innerWidth * 0.55 && r.width >= 22 && r.width <= 90 && r.height >= 22 && /douyinpic/.test(i.currentSrc || i.src || ''); });
        const el = imgs[0];
        if (!el) return 'null';
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      })()`,
      returnByValue: true
    })).result.value;
    if (!posRaw || posRaw === 'null') return;
    const { x, y } = JSON.parse(posRaw);
    await cdpRef.rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(500);
    await cdpRef.rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 2, y: y + 2 });
    await sleep(700);
    const fansRaw = (await cdpRef.rpc('Runtime.evaluate', {
      expression: `(() => { const m = (document.body.innerText || '').match(/粉丝(\\d{3,9})/); return m ? m[1] : ''; })()`,
      returnByValue: true
    })).result.value;
    await cdpRef.rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }).catch(() => { });
    const fans = fansRaw ? parseInt(fansRaw, 10) : null;
    if (fans == null) return;
    if (lastFollowerCount != null && fans > lastFollowerCount) {
      const n = Math.min(fans - lastFollowerCount, 10);
      const pool = [...roster.entries()].filter(([nm]) => nm !== owner).sort((a, b) => (lastSeen.get(b[0]) || 0) - (lastSeen.get(a[0]) || 0));
      for (let i = 0; i < n && pool.length; i++) {
        const [name, avatar] = pool[i % pool.length];
        total.join++;
        lastEventAt = Date.now();
        hubRef.broadcast({ type: 'follow', name, avatar: avatar || '' });
        console.log('[' + stamp() + '] ⭐ 新关注（粉丝 ' + lastFollowerCount + '→' + fans + '）→ 打印 ' + name);
      }
    }
    lastFollowerCount = fans;
  } catch { }
}

// 串行悬停，避免多条评论同时移动鼠标导致资料卡串人。
// hoverTried 记每个昵称的批次次数与上次时间：冷却 4 秒，最多 4 批（12 次点击轮），之后交给首字兜底。
const hoverTried = new Map();
const HOVER_COOLDOWN_MS = 4000, HOVER_MAX_BATCHES = 4;
let hoverQueue = Promise.resolve();
function hoverResolveAvatars(names) {
  const room = currentRoom;
  const work = hoverQueue.then(() => room === currentRoom ? resolveHoverBatch(names) : undefined);
  hoverQueue = work.catch(() => {});
  return work;
}
export async function clickNickname(rpc, x, y) {
  await rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y });
}

const CARD_OPEN = `!![...document.querySelectorAll('[role="dialog"],dialog')].find(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; })`;
export async function dismissProfileCard(rpc, force = false) {
  const read = async expression => (await rpc('Runtime.evaluate', {expression,returnByValue:true})).result.value;
  const open = await read(CARD_OPEN);
  if (!open && !force) return true;
  const point = await read(`(() => {
    const editors = [...document.querySelectorAll('[contenteditable="true"],textarea')];
    for (const editor of editors) {
      if (editor.closest('[role="dialog"],dialog')) continue;
      const r=editor.getBoundingClientRect();
      if(r.width<10 || r.height<5 || r.bottom>innerHeight || r.top<0) continue;
      const x=r.left+Math.min(20,r.width/2), y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      if(hit && (hit===editor || editor.contains(hit))) return {x,y};
    }
    return null;
  })()`);
  if (!point) return false;
  // Only focus the comment editor; never type, press Enter, or click Send.
  await clickNickname(rpc, point.x, point.y);
  for (let i=0;i<5;i++) {
    await sleep(100);
    if (!await read(CARD_OPEN)) return true;
  }
  return false;
}

export async function resolveHoverBatch(names) {
  if (!cdpRef) return;
  for (const name of names) {
    const rec = hoverTried.get(name);
    if (rec && (rec.n >= HOVER_MAX_BATCHES || Date.now() - rec.t < HOVER_COOLDOWN_MS)) continue;
    hoverTried.set(name, { t: Date.now(), n: (rec?.n || 0) + 1 });
    let avRaw = '';
    try {
      // 同一昵称最多点3轮，每轮换一个点击位置（靠左 / 靠左起点 / 居中 / 靠右），提高资料卡命中率。
      for (let round = 0; round < 3 && !avRaw; round++) {
      if (!await dismissProfileCard(cdpRef.rpc)) { console.warn('资料卡未关闭，暂停本轮点击，避免误入主页'); return; }
      const posRaw = (await cdpRef.rpc('Runtime.evaluate', {
        expression: `(() => {
          const name = ${JSON.stringify(name)};
          // 先在弹幕区找昵称；弹幕滚得快找不到时，退而全页找（观众列表/粉丝面板里的同款昵称也能开资料卡）。
          const scopes = window.__chatRoot && window.__chatRoot.isConnected ? [window.__chatRoot, document] : [document];
          let els = [];
          for (const scope of scopes) {
            els = [...scope.querySelectorAll('span,a,div')].filter(e => {
              if (e.closest?.('[role="dialog"],dialog')) return false;
              const text = (e.textContent || '').trim();
              const r = e.getBoundingClientRect();
              const matches = text === name || text === name + '：' || text === name + ':' || (!e.children.length && (text.startsWith(name + '：') || text.startsWith(name + ':')));
              return matches && r.width > 2 && r.height > 2 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.left < innerWidth;
            });
            if (els.length) break;
          }
          const el = els[els.length - 1];
          if (!el) return '[]';
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.top < 40) return '[]';
          const y = Math.round(r.top + r.height / 2);
          const ends = [['左', Math.min(30, r.width / 2)], ['靠左', Math.min(12, r.width / 2)], ['中', r.width / 2], ['右', r.width - Math.min(14, r.width / 3)]];
          const out = [];
          for (const [label, off] of ends) {
            const x = Math.round(r.left + off);
            const hit = document.elementFromPoint(x, y);
            if (!hit || !(hit === el || el.contains(hit))) continue;
            if (out.some(p => p.x === x && p.y === y)) continue;
            out.push({ x, y, label });
          }
          return JSON.stringify(out);
        })()`,
        returnByValue: true
      })).result.value;
      const points = JSON.parse(posRaw || '[]');
      if (!points.length) { console.log('头像补取：未定位到可见昵称 ' + name); break; }
      const spot = points[Math.min(round, points.length - 1)];
      await clickNickname(cdpRef.rpc, spot.x, spot.y);
      // 点击后等待资料卡出现，并持续轮询等头像图片读取完成（卡片开着最多等约4秒）。
      let cardSeen = false;
      for (let attempt = 0; attempt < 16 && !avRaw; attempt++) {
      await sleep(250);
      const rawCard = (await cdpRef.rpc('Runtime.evaluate', {
        expression: `(() => {
          const name = ${JSON.stringify(name)};
          let card = false;
          for (const dialog of document.querySelectorAll('[role="dialog"],dialog')) {
            const heading = [...dialog.querySelectorAll('h1,h2,h3,h4,[role="heading"]')].find(e => (e.textContent || '').trim() === name);
            if (!heading || !dialog.getBoundingClientRect().width) continue;
            card = true;
            const images = [...dialog.querySelectorAll('img')].filter(img => {
              const src = img.currentSrc || img.src || '', r = img.getBoundingClientRect();
              return img.complete && img.naturalWidth > 0 && r.width >= 40 && r.height >= 40 && r.width / r.height > .8 && r.width / r.height < 1.2 && /douyinpic|byteimg/.test(src) && !/badge|medal|grade_level|icon/.test(src);
            }).sort((a,b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            if (images.length) return JSON.stringify({ card: true, avatar: images[0].currentSrc || images[0].src });
          }
          // Require an exact nickname inside a compact card; never scan a broad page ancestor.
          const labels = [...document.querySelectorAll('span,a,div,h1,h2,h3,h4')].filter(e => (e.textContent || '').trim() === name && ![...e.children].some(c => (c.textContent || '').trim() === name));
          const pops = [];
          for (const label of labels) {
            let e = label.parentElement;
            for (let i = 0; i < 5 && e; i++, e = e.parentElement) {
              const t = e.innerText || '', r = e.getBoundingClientRect();
              if (t.length > 300) break;
              if (/粉丝|关注/.test(t) && r.width > 0 && r.height > 0 && e.querySelector('img')) {
                const imgs = [...e.querySelectorAll('img')].filter(img => /aweme-avatar|tos-cn-avt|sc=avatar/.test(img.currentSrc || img.src || ''));
                if (imgs.length === 1) pops.push(e);
                break;
              }
            }
          }
          for (const e of pops) {
            card = true;
            for (const img of e.querySelectorAll('img')) {
              const s = img.currentSrc || img.src || '';
              if (/(aweme-avatar|tos-cn-avt|sc=avatar)/i.test(s)) {
                if (img.complete && img.naturalWidth > 0 && !/grade_level|badge|medal|icon|\\.svg/i.test(s)) return JSON.stringify({ card: true, avatar: s });
              }
            }
          }
          return JSON.stringify({ card, avatar: '' });
        })()`,
        returnByValue: true
      })).result.value;
        let read = {}; try { read = JSON.parse(rawCard || '{}') } catch { }
        if (read.avatar) { avRaw = read.avatar; break }
        if (read.card) cardSeen = true;
        else if (!cardSeen && attempt >= 2) break;
      }
      await cdpRef.rpc('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }).catch(() => { });
      if (avRaw) {
        feedAvatar(name, avRaw, '资料卡');
        console.log('[' + stamp() + '] 🪪 点击资料卡获取到头像：' + name + '（第' + (round + 1) + '次点击·' + spot.label + '）');
      } else {
        console.log('头像补取：第' + (round + 1) + '次点击（' + spot.label + '）' + (cardSeen ? '头像未读取完成' : '资料卡未出现') + ' ' + name);
        // 到评论区点一下，关闭资料卡或清掉残留弹层，再换位置重试。
        await dismissProfileCard(cdpRef.rpc, true).catch(() => false);
        await sleep(350);
      }
      }
    } catch (err) { console.warn('点击头像补取失败：' + err.message); }
    finally {
      if (!await dismissProfileCard(cdpRef.rpc).catch(() => false)) console.warn('资料卡仍显示，下次获取前将先关闭资料卡');
    }
  }
}

async function run(hub) {
  hubRef = hub;
  const room = currentRoom;
  let found = await findTarget(room);
  if (!found) {
    if (process.env.PRINTER_CDP_PORT) throw new Error('独立直播窗口未就绪，请完成登录后重新开始抓取');
    await launchStandaloneChrome(room);
    found = await findTarget(room);
  }
  if (!found) throw new Error('无法获得直播间页面（尝试过 :9110 :9222 :9223）');
  const { port, target } = found;
  console.log('[' + stamp() + '] 已挂接浏览器 :%d → %s', port, target.url);
  const { ws, rpc } = await attachCDP(target);
  cdpRef = { ws, rpc };
  if (((target.url || '').match(ROOM_RE) || [])[1] !== currentRoom) {
    await rpc('Page.navigate', { url: 'https://live.douyin.com/' + currentRoom }).catch(() => { });
    await sleep(4000);
  }
  console.log('[' + stamp() + '] 📺 直播间 https://live.douyin.com/' + currentRoom + ' 采集中，每 0.3 秒刷新 + 协议流解码');
  cdpEventSink = m => {
    if (m.method === 'Target.attachedToTarget' && m.params && m.params.sessionId) {
      const sid = m.params.sessionId;
      cdpRef.rpc('Network.enable', {}, sid).catch(() => { });
      cdpRef.rpc('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid).catch(() => { });
    } else if (m.method === 'Network.webSocketFrameReceived' && m.params && m.params.response && m.params.response.payloadData) {
      const p = m.params.response;
      try {
        if (p.opcode === 2) handleWSFrame(Buffer.from(p.payloadData, 'base64'));
        else if (typeof p.payloadData === 'string' && p.payloadData.length > 40) handleWSFrame(Buffer.from(p.payloadData, 'utf8'));
      } catch { }
    }
  };
  await cdpRef.rpc('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => { });

  // 断线重连：永久重试但每次都带 catch，绝不让 unhandled rejection 杀掉进程。
  const reconnect = () => setTimeout(() => {
    run(hub).catch(e => {
      console.error('[' + stamp() + '] ❌ ' + (e.message || e) + '，3 秒后重试');
      reconnect();
    });
  }, 3000);
  const fail = err => {
    clearInterval(timer);
    cdpRef = null;
    console.log('[' + stamp() + '] 连接断开（%s），3 秒后重连…', err.message || err);
    try { ws.close() } catch { }
    reconnect();
  };
  ws.onerror = () => { };
  ws.onclose = () => fail(new Error('CDP closed'));

  function emit(ev) {
    lastEventAt = Date.now();
    hub.broadcast(ev);
    if (ev.type === 'comment') { total.comment++; console.log('[' + stamp() + '] 💬 %s：%s%s', ev.name, ev.text || '', ev.avatar ? ' 🪪' : ' △无头像') }
    else if (ev.type === 'gift') { total.gift++; console.log('[' + stamp() + '] 🎁 %s 送出 %s x%d → %s', ev.name, ev.raw, ev.count, ev.gift) }
    else if (ev.type === 'like') { total.like += ev.count; console.log('[' + stamp() + '] ❤️ %s 点赞 +%d%s', ev.name, ev.count, ev.avatar ? '（带头像）' : '') }
    else if (ev.type === 'join') { total.join++; console.log('[' + stamp() + '] 👋 %s 进入直播间', ev.name) }
  }

  let commentResolution = Promise.resolve();
  function handle(s) {
    if (s.owner) owner = s.owner;
    for (const [n, a] of Object.entries(s.avatars || {})) {
      if (!a || !n || n === owner || isJunkName(n)) continue;
      if (!roster.has(n) && !(s.lines || []).some(line => parseChatLine(line)?.name === n)) continue;
      if (!roster.has(n)) likeState.used.clear();
      feedAvatar(n, a, '页面头像');
    }
    const normAvatars = {};
    for (const [n, a] of Object.entries(s.avatars || {})) { const k = normKey(n); if (k && a && !normAvatars[k]) normAvatars[k] = a; }
    if (s.likes != null) {
      if (lastLikes == null) lastLikes = s.likes;
      else if (s.likes > lastLikes && Date.now() - lastWsLikeAt > 30000) {
        const delta = Math.min(s.likes - lastLikes, 100);
        const pool = [...roster.entries()].sort((x, y) => (Number(!!y[1]) - Number(!!x[1])) || ((lastSeen.get(y[0]) || 0) - (lastSeen.get(x[0]) || 0)));
        const events = allocateLikes(delta, pool, likeState);
        const nowMs = Date.now();
        likeTokens = Math.min(20, likeTokens + (nowMs - likeTokensAt) / 400);
        likeTokensAt = nowMs;
        const budget = Math.floor(likeTokens);
        const allowed = Math.min(events.length, budget);
        likeTokens -= allowed;
        if (events.length > allowed && nowMs - lastThrottleLog > 10000) {
          lastThrottleLog = nowMs;
          console.log('[' + stamp() + '] ❤️ 点赞风暴限速中（高峰期限流，平时秒放行）');
        }
        for (const ev of events.slice(0, allowed)) emit({ type: 'like', ...ev });
        if (delta > 0 && !events.length && !roster.size) console.log('[' + stamp() + '] ❤️ 点赞 +%d（观众名单还没就绪，先不打印）', delta);
      }
      lastLikes = s.likes;
    }
    const parsedNames = [];
    // 挂接前已滚过的历史弹幕只做头像同步，不打印——开局不该吐一堆旧评论，且它们的协议帧早已消失、头像注定补不齐。
    if (!historySkipped && (s.lines || []).length) {
      historySkipped = true;
      let skipped = 0;
      for (const line of s.lines) if (!seen.has(line)) { seen.add(line); skipped++; }
      if (skipped) console.log('[' + stamp() + '] ⏭ 跳过挂接前已存在的 %d 条历史弹幕（不打印旧评论）', skipped);
    }
    for (const line of diffNew(s.lines || [], seen)) {
      const ev = parseChatLine(line);
      if (!ev) continue;
      const key = normKey(ev.name);
      const avatar = avatars[ev.name] || (key && (normMap.get(key) || normAvatars[key])) || lookupAvatar(ev.name) || roster.get(ev.name) || '';
      if (!roster.has(ev.name)) likeState.used.clear();
      roster.set(ev.name, avatar);
      lastSeen.set(ev.name, Date.now());
      if (ev.kind !== 'comment') parsedNames.push(ev.name);
      if (ev.kind === 'comment' || ev.kind === 'gift') {
        // Preserve every comment, including repeated text; resolve its avatar before dispatch.
        commentResolution = commentResolution.then(async () => {
          if (room !== currentRoom) return;
          // 协议帧与弹幕几乎同时到达且必带头像：先短暂等待，命中就免去一次资料卡点击。
          if (!avatars[ev.name] && !(key && normMap.get(key)) && !avatar) {
            for (let i = 0; i < 12 && room === currentRoom; i++) {
              await sleep(200);
              if (avatars[ev.name] || (key && normMap.get(key))) break;
            }
          }
          if (room !== currentRoom) return;
          if (!avatars[ev.name] && !(key && normMap.get(key)) && !avatar) await hoverResolveAvatars([ev.name]);
          if (room !== currentRoom) return;
          const resolved = avatars[ev.name] || (key && normMap.get(key)) || avatar;
          if (ev.kind === 'gift') emit({ type: 'gift', name: ev.name, gift: mapGift(ev.gift), raw: ev.gift, count: ev.count, avatar: resolved || '' });
          else emit({ type: 'comment', name: ev.name, text: ev.text, avatar: resolved || '' });
        }).catch(err => console.error('评论头像补取失败：', err.message));
      }
      else if (ev.kind === 'follow') emit({ type: 'follow', name: ev.name, avatar });
      else if (ev.kind === 'join' && Date.now() - lastWsJoinAt > 30000) emit({ type: 'join', name: ev.name, avatar });
    }
    if (parsedNames.length) {
      const need = [...new Set(parsedNames.filter(n => !roster.get(n)))];
      if (need.length) hoverResolveAvatars(need.slice(0, 2));
    }
    pollFollowers();
  }

  const timer = setInterval(async () => {
    if (ws.readyState !== 1) return;
    try {
      const r = await rpc('Runtime.evaluate', { expression: COLLECT, returnByValue: true });
      if (r && r.result && r.result.value) {
        const s = r.result.value;
        // Leave login / verification pages alone; only an explicit room switch navigates.
        if (s.href && !s.href.includes('live.douyin.com/' + currentRoom)) return;
        if (!chatSeen && (s.lines.length || s.likes != null)) {
          chatSeen = true;
          console.log('[' + stamp() + '] ✅ 已读到直播数据：弹幕 %d 条，点赞计数 %s', s.lines.length, s.likes);
        }
        handle(s);
      }
    } catch (e) { fail(e) }
  }, 300);

  const watch = setInterval(() => {
    const n = hub.clientCount();
    if (n !== clientCount) {
      if (n > clientCount) {
        hub.broadcast({ type: 'hello', room: currentRoom, people: [...roster.entries()].sort((a, b) => Number(!!b[1]) - Number(!!a[1])).slice(0, 8).map(([name, avatar]) => ({ name, avatar })) });
        console.log('[' + stamp() + '] 🖨 打印页面已连接（共 %d 个）', n);
      } else console.log('[' + stamp() + '] 打印页面断开（剩 %d 个）', n);
      clientCount = n;
    }
    if (hub.clientCount()) hub.broadcast({ type: 'ping', room: currentRoom, ts: Date.now(), people: [...roster.entries()].sort((a, b) => Number(!!b[1]) - Number(!!a[1])).slice(0, 8).map(([name, avatar]) => ({ name, avatar })), stats: { comment: total.comment, like: total.like, gift: total.gift, join: total.join, lastAgo: lastEventAt ? Date.now() - lastEventAt : null, roster: roster.size } });
  }, 2000);
  watch.unref?.();

  // 空闲补取：即使没人发言，也定期给最近活跃、还没有头像的观众再点几次资料卡。
  const sweep = setInterval(() => {
    if (!cdpRef || !hub.clientCount()) return;
    const need = [...roster.keys()].filter(n => !avatars[n])
      .sort((a, b) => (lastSeen.get(b) || 0) - (lastSeen.get(a) || 0)).slice(0, 2);
    if (need.length) hoverResolveAvatars(need);
  }, 45000);
  sweep.unref?.();
}

// 切换房间（set-room 消息与 .bridge-room 文件变更共用）：重置状态、广播、导航新房间。
function applyRoom(room, persist) {
  if (room === currentRoom) {
    hubRef?.broadcast({ type: 'hello', room, people: [...roster.entries()].slice(0, 6).map(([name, avatar]) => ({ name, avatar })) });
    return;
  }
  currentRoom = room;
  if (persist) { try { fs.writeFileSync(path.join(__dirname, '.bridge-room'), room) } catch { } }
  console.log('[' + stamp() + '] 📺 切换直播间 → ' + room);
  resetRoomState();
  hubRef?.broadcast({ type: 'hello', room, people: [] });
  if (cdpRef) cdpRef.rpc('Page.navigate', { url: 'https://live.douyin.com/' + room }).catch(() => { });
}

async function main() {
  const argRoom = (process.argv[2] || '').replace(/\D/g, '');
  let fileRoom = '';
  try { fileRoom = ((fs.readFileSync(path.join(__dirname, '.bridge-room'), 'utf8').match(/(\d{5,25})/)) || [])[1] || '' } catch { }
  currentRoom = argRoom || fileRoom || currentRoom;
  if (!currentRoom) { console.error('请提供直播间号：node douyin-bridge.mjs 房间号（也可写入 .bridge-room 文件，或在打印程序里切换房间）'); process.exit(1); }
  loadAvatarCache();
  setInterval(saveAvatarCache, 30000).unref?.();
  process.on('exit', saveAvatarCache);
  // 自动跟随 .bridge-room：应用重开别的直播窗口或手改文件，无需重启数据桥。
  setInterval(() => {
    let fileRoom = '';
    try { fileRoom = ((fs.readFileSync(path.join(__dirname, '.bridge-room'), 'utf8').match(/(\d{5,25})/)) || [])[1] || '' } catch { }
    if (fileRoom && fileRoom !== currentRoom) applyRoom(fileRoom, false);
  }, 2000).unref?.();
  const wsPort = Number(process.argv[3]) || 8765;
  const hub = startWSServer(wsPort, {
    identity: __dirname, fallbackPorts: process.argv[3] ? 0 : 9,
    onStatus: p => console.log('[' + stamp() + '] ✅ 数据桥服务 ws://127.0.0.1:' + p + '（等待打印页面接入）'),
    onError: err => {
      console.error('[' + stamp() + '] ❌ 端口 ' + wsPort + ' 启动失败（' + err.code + '），可能有另一个数据桥在运行，本实例退出');
      process.exit(1);
    },
    onMessage: raw => {
      let m; try { m = JSON.parse(raw) } catch { return }
      if (m.type !== 'set-room') return;
      const id = String(m.room || '').match(/(\d{5,25})/);
      if (!id) return;
      applyRoom(id[1], true);
    }
  });
  console.log('房间号 ' + currentRoom + '。正在弹出直播间窗口（可在里面登录抖音）；来源优先级：自建窗口(:9223) → BrowserOS(:9110) → 调试Chromium(:9222)');
  try { await run(hub) } catch (e) {
    console.error('[' + stamp() + '] ❌ ' + e.message);
    console.error('提示：先打开 BrowserOS neo（会自动用 :9110），或重试本命令。');
    // 启动失败必须退进程，否则 WS 服务把事件循环吊住，变成占着 8765 端口的僵尸。
    saveAvatarCache();
    process.exit(1);
  }
  process.on('SIGINT', () => { saveAvatarCache(); process.exit() });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
