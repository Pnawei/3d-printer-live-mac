#!/usr/bin/env node
// 诊断工具：抓取直播间 WebSocket 原始帧，落盘供分析协议结构（为什么协议级解码没触发）。
// 用法：node probe-ws.mjs [房间号] [秒数]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pbDecode } from './douyin-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const room = (process.argv[2] || fs.readFileSync(path.join(__dirname, '.bridge-room'), 'utf8').match(/(\d{5,25})/)[1]);
const seconds = Number(process.argv[3]) || 60;
const outDir = path.join(__dirname, 'ws-samples');
fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const getJson = url => new Promise((res, rej) => { const q = http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }); }); q.on('error', rej); q.end(); });

async function navigateViaCdp(wsUrl, url) {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(wsUrl);
    let mid = 0; const pend = new Map();
    const rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pend.set(id, { res, rej }); w.send(JSON.stringify({ id, method, params })); });
    w.onopen = async () => {
      try { await rpc('Page.enable'); await rpc('Page.navigate', { url }); setTimeout(() => { w.close(); resolve() }, 3000); }
      catch (e) { reject(e) }
    };
    w.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return } if (m.id && pend.has(m.id)) { pend.get(m.id).res(m.result); pend.delete(m.id) } };
    w.onerror = () => reject(new Error('CDP 连接失败'));
  });
}

function describe(buf, label, file) {
  // 递归打印 protobuf 结构，字符串字段直接显示。
  const lines = [];
  const walk = (b, depth, prefix) => {
    if (depth > 6 || b.length > 200000) return;
    for (const f of pbDecode(b)) {
      const indent = '  '.repeat(depth);
      if (f.wire === 2) {
        const text = f.buf.toString('utf8');
        const printable = /^[\x20-\x7e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]+$|^https?:\/\//u.test(text) && !/\x00/.test(text);
        if (printable && f.buf.length < 220) lines.push(`${indent}#${f.n} len=${f.buf.length} str="${text.slice(0, 120)}"`);
        else lines.push(`${indent}#${f.n} len=${f.buf.length} bytes=${f.buf.toString('hex').slice(0, 40)}…`);
        if (f.buf.length > 4) try { walk(f.buf, depth + 1, prefix) } catch { }
      } else if (f.wire === 0) lines.push(`${indent}#${f.n} varint=${f.num}`);
    }
  };
  lines.push(`===== ${label} (${buf.length} bytes) =====`);
  try { walk(buf, 1, '') } catch (e) { lines.push('walk error: ' + e.message) }
  fs.appendFileSync(file, lines.join('\n') + '\n\n');
}

let chrome;
async function main() {
  // 优先挂已有调试端口，否则自建。
  let port = null;
  for (const p of [9223, 9110, 9222]) { try { await getJson(`http://127.0.0.1:${p}/json/version`); port = p; break } catch { } }
  if (!port) {
    const exe = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(p => fs.existsSync(p));
    if (!exe) throw new Error('没有可用浏览器');
    port = 9224;
    spawn(exe, ['--remote-debugging-port=9224', '--user-data-dir=' + path.join(__dirname, '.bridge-profile'), '--no-first-run', '--lang=zh-CN', '--window-size=1100,760', 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 40; i++) { await sleep(500); try { await getJson(`http://127.0.0.1:${port}/json/version`); break } catch { } }
  }
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  let page = (Array.isArray(list) ? list : []).find(t => t.type === 'page' && /live\.douyin\.com/.test(t.url));
  if (!page) {
    // 用 CDP 导航第一个普通页面标签（/json/new 在部分 Chrome 版本会静默失败）。
    page = (Array.isArray(list) ? list : []).find(t => t.type === 'page');
    if (!page) throw new Error('没有可用页面标签');
    await navigateViaCdp(page.webSocketDebuggerUrl, 'https://live.douyin.com/' + room);
    for (let i = 0; i < 20; i++) { await sleep(1000); const l2 = await getJson(`http://127.0.0.1:${port}/json/list`); const hit = l2.find(t => t.type === 'page' && t.url.includes('live.douyin.com/' + room)); if (hit) { page = hit; break } }
  }
  if (!page || !page.url.includes('live.douyin.com')) throw new Error('打不开直播间页面');
  if (!page.url.includes(room)) {
    await navigateViaCdp(page.webSocketDebuggerUrl, 'https://live.douyin.com/' + room);
    for (let i = 0; i < 15; i++) { await sleep(1000); const ln = await getJson(`http://127.0.0.1:${port}/json/list`); const hit = ln.find(t => t.type === 'page' && t.url.includes('live.douyin.com/' + room)); if (hit) { page = hit; break } }
  }
  console.log(`[${stamp()}] 探测页面：${page.url}`);
  await sleep(4000);
  const l3 = await getJson(`http://127.0.0.1:${port}/json/list`);
  page = l3.find(t => t.type === 'page' && t.url.includes('live.douyin.com/' + room)) || page;

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let mid = 0; const pend = new Map();
  const rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  let frames = 0, gzipOk = 0, textFrames = 0, methods = {};
  const structFile = path.join(outDir, 'structure.txt');
  const sampleFile = path.join(outDir, 'samples.txt');
  fs.writeFileSync(structFile, ''); fs.writeFileSync(sampleFile, '');
  ws.onopen = async () => {
    await rpc('Network.enable');
    await rpc('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => { });
    console.log(`[${stamp()}] 开始抓帧 ${seconds}s …`);
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.id && pend.has(m.id)) { pend.get(m.id).res(m.result); pend.delete(m.id); return }
    if (m.method === 'Target.attachedToTarget' && m.params?.sessionId) rpc('Network.enable', {}, m.params.sessionId).catch(() => { }).then(() => rpc('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, m.params.sessionId)).catch(() => { });
    if (m.method !== 'Network.webSocketFrameReceived' || !m.params?.response?.payloadData) return;
    const p = m.params.response;
    frames++;
    if (p.opcode === 1) { textFrames++; if (textFrames <= 3) fs.appendFileSync(path.join(outDir, 'text-frames.txt'), (p.payloadData || '').slice(0, 2000) + '\n\n'); return }
    if (p.opcode !== 2) return;
    let raw; try { raw = Buffer.from(p.payloadData, 'base64') } catch { return }
    const idx = raw.indexOf(Buffer.from([0x1f, 0x8b]));
    let payload = null;
    if (idx >= 0) { try { payload = zlib.gunzipSync(raw.subarray(idx)); gzipOk++ } catch { } }
    if (!payload) {
      if (frames <= 5) fs.appendFileSync(sampleFile, `=== 未识别帧 #${frames} opcode=2 rawLen=${raw.length} head(hex)=${raw.toString('hex').slice(0, 60)} ===\n`);
      return;
    }
    if (frames <= 6 || frames % 40 === 0) {
      const top = pbDecode(payload);
      // 打印顶层结构 + 每个嵌套子消息的头 32 字节文本。
      let desc = `=== 帧 #${frames} gunzip=${payload.length}B 顶层字段: ${top.map(f => `n${f.n}/w${f.wire}(${f.buf ? f.buf.length : f.num ?? ''}B)`).join(' ')} ===\n`;
      for (const f of top.slice(0, 12)) {
        if (f.wire === 2 && f.buf) {
          desc += ` n${f.n}: head="${f.buf.toString('utf8', 0, Math.min(48, f.buf.length)).replace(/[^\x20-\x7e\u4e00-\u9fff]/gu, '·')}"\n`;
          for (const s of pbDecode(f.buf).slice(0, 8)) {
            if (s.wire === 2 && s.buf) desc += `   n${f.n}.n${s.n}: head="${s.buf.toString('utf8', 0, Math.min(48, s.buf.length)).replace(/[^\x20-\x7e\u4e00-\u9fff]/gu, '·')}" len=${s.buf.length}\n`;
          }
        }
      }
      fs.appendFileSync(structFile, desc);
    }
    // 找到含 Webcast 消息头的完整结构时，dump 一条完整解码树。
    const flat = payload.toString('utf8', 0, Math.min(2000, payload.length));
    if (flat.includes('WebcastChatMessage') && !fs.existsSync(path.join(outDir, 'chat-tree.txt'))) {
      describe(payload, 'ChatMessage 帧完整结构', path.join(outDir, 'chat-tree.txt'));
    }
    if (flat.includes('WebcastRoomUserSeqMessage') && !fs.existsSync(path.join(outDir, 'roomuserseq-tree.txt'))) {
      describe(payload, 'RoomUserSeq 帧完整结构', path.join(outDir, 'roomuserseq-tree.txt'));
    }
    const head = payload.toString('utf8', 0, 400);
    for (const mm of head.matchAll(/Webcast(\w+)Message/g)) { const k = mm[1]; methods[k] = (methods[k] || 0) + 1 }
  };
  ws.onerror = () => { };
  await sleep(seconds * 1000);
  console.log(`[${stamp()}] 抓帧结束：总帧 ${frames}，gzip 解压成功 ${gzipOk}，文本帧 ${textFrames}`);
  console.log('消息类型统计：', JSON.stringify(methods, null, 0));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ frames, gzipOk, textFrames, methods }, null, 2));
  process.exit(0);
}
main().catch(e => { console.error('❌', e.message); process.exit(1) });
