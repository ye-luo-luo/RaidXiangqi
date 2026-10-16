#!/usr/bin/env node
/* ============================================================================
 * 突袭匈汉象棋 1.0 — 联机中继服务器（零依赖）
 *
 * 作用：
 *   1. 静态托管本目录的游戏页面（node server.js 后访问 http://<本机IP>:8644）
 *   2. 提供 /__relay/* 房间中继：两个玩家通过同一个「联机码」配对并互传 JSON 消息
 *
 * 用法：
 *   node server.js            # 默认端口 8644
 *   node server.js 9000       # 指定端口
 *   set PORT=9000 && node server.js
 *
 * 说明：
 *   - 同一 Wi-Fi 下，两台设备打开 http://<电脑IP>:8644 即可联机（电脑需运行本文件）。
 *   - 若部署到有公网 IP 的机器，则互联网也能联机。
 *   - 长轮询实现（非 WebSocket），无需任何第三方依赖。
 * ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || process.argv[2] || '8644', 10);
const POLL_TIMEOUT = parseInt(process.env.POLL_MS || '15000', 10); // 长轮询最长等待（可调）
const ROOT = __dirname;
const MAX_LOG = 1000;            // 每个房间保留的最大消息数
const ROOM_TTL = 10 * 60 * 1000; // 房间无人使用超过该时间后清理

/* ------------------------------ 房间状态 ------------------------------
 * rooms: code -> {
 *   a: {since}, b: {since},   // 两个玩家位（a=先到=房主，b=后到=加入者）
 *   log: [{i, to, msg}],      // 消息日志（to: 'a'|'b'|'*'）
 *   nextI,                    // 下一条消息序号
 *   waiters: [{deliver, res, t}],
 *   lastSeen
 * }
 * -------------------------------------------------------------------- */
const rooms = new Map();

function pushMsg(r, to, msg) {
  r.log.push({ i: r.nextI++, to: to, msg: msg });
  if (r.log.length > MAX_LOG) r.log.splice(0, r.log.length - MAX_LOG);
  r.lastSeen = Date.now();
  r.waiters.forEach((w) => { clearTimeout(w.t); try { w.deliver(); } catch (e) {} });
  r.waiters = [];
}

/* ------------------------------ HTTP 工具 ------------------------------ */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 65536) data = data.slice(-65536); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};
const JS_SRC = 'text/javascript; charset=utf-8';

/* ------------------------------ 中继接口 ------------------------------ */
function handleRelay(req, res, url) {
  const m = url.pathname.match(/^\/__relay\/room\/([^/]+)\/(join|msg|poll|leave)$/);
  const health = url.pathname === '/__relay/health';
  if (health) return json(res, 200, { ok: true, now: Date.now() });

  if (!m) return json(res, 404, { ok: false, error: '未知接口' });
  const code = m[1];
  const action = m[2];
  if (!/^[A-Za-z0-9]{3,12}$/.test(code)) return json(res, 400, { ok: false, error: '联机码格式无效' });

  if (action === 'join') {
    return readBody(req).then((body) => {
      const wantCreate = !body || body.create !== false; // 默认允许创建（房主）
      let r = rooms.get(code);
      if (!r && !wantCreate) return json(res, 404, { ok: false, error: '房间不存在，请检查联机码' });
      const created = !r;
      if (!r) r = { a: null, b: null, log: [], nextI: 0, waiters: [], lastSeen: Date.now() };
      let player = null;
      if (!r.a) player = 'a';
      else if (!r.b) player = 'b';
      else return json(res, 409, { ok: false, error: '房间已满' });
      r[player] = { since: Math.max(0, r.nextI - 1) };
      rooms.set(code, r);
      r.lastSeen = Date.now();
      // 通知另一方“有人加入了”
      if (player === 'b' && r.a) pushMsg(r, 'a', { t: 'sys', ev: 'peer-joined' });
      if (player === 'a' && r.b) pushMsg(r, 'b', { t: 'sys', ev: 'peer-joined' });
      return json(res, 200, { ok: true, code: code, player: player, created: created });
    });
  }

  if (action === 'msg') {
    return readBody(req).then((body) => {
      const r = rooms.get(code);
      if (!r) return json(res, 404, { ok: false, error: '房间不存在' });
      const to = body.to === 'a' || body.to === 'b' ? body.to : '*';
      if (typeof body.msg !== 'object' || body.msg === null)
        return json(res, 400, { ok: false, error: '消息格式错误' });
      pushMsg(r, to, body.msg);
      return json(res, 200, { ok: true });
    });
  }

  if (action === 'poll') {
    const r = rooms.get(code);
    if (!r) return json(res, 404, { ok: false, error: '房间不存在' });
    const player = url.searchParams.get('player') === 'a' ? 'a'
      : url.searchParams.get('player') === 'b' ? 'b' : null;
    if (!player || !r[player]) return json(res, 404, { ok: false, error: '玩家不存在' });
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    r.lastSeen = Date.now();

    const deliver = () => {
      const msgs = [];
      for (let i = r.log.length - 1; i >= 0; i--) {
        const e = r.log[i];
        if (e.i > since && (e.to === player || e.to === '*')) msgs.unshift(e.msg);
        if (e.i <= since) break;
      }
      json(res, 200, { ok: true, since: Math.max(since, r.nextI - 1), serverTime: Date.now(), messages: msgs });
    };
    // 立即有货则直接返回
    if (r.log.length && r.log[r.log.length - 1].i > since) return deliver();

    // 否则挂起，等消息或超时
    const waiter = { deliver, res };
    r.waiters.push(waiter);
    waiter.t = setTimeout(() => {
      const i = r.waiters.indexOf(waiter);
      if (i >= 0) r.waiters.splice(i, 1);
      if (!res.writableEnded) deliver();
    }, POLL_TIMEOUT);
    res.on('close', () => {
      clearTimeout(waiter.t);
      const i = r.waiters.indexOf(waiter);
      if (i >= 0) r.waiters.splice(i, 1);
    });
    return undefined;
  }

  if (action === 'leave') {
    const r = rooms.get(code);
    if (r) {
      const player = url.searchParams.get('player') === 'a' ? 'a'
        : url.searchParams.get('player') === 'b' ? 'b' : null;
      if (player && r[player]) {
        r[player] = null;
        pushMsg(r, player === 'a' ? 'b' : 'a', { t: 'sys', ev: 'peer-left' });
        r.lastSeen = Date.now();
      }
      if (!r.a && !r.b) rooms.delete(code);
    }
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { ok: false, error: '未知操作' });
}

/* ------------------------------ 静态文件 ------------------------------ */
function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) return json(res, 403, { ok: false, error: '禁止访问' });
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + p);
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------ 主循环 ------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (url.pathname.startsWith('/__relay/')) return handleRelay(req, res, url);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
  return json(res, 405, { ok: false, error: '方法不允许' });
});

// 定时清理过期房间
setInterval(() => {
  const now = Date.now();
  rooms.forEach((r, code) => {
    if ((!r.a && !r.b) || now - r.lastSeen > ROOM_TTL) rooms.delete(code);
  });
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('突袭匈汉象棋 联机中继已启动');
    console.log('  局域网/本机：  http://localhost:' + PORT);
    const os = require('os');
    const ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach((name) => {
      (ifaces[name] || []).forEach((i) => {
        if (i.family === 'IPv4' && !i.internal) console.log('  局域网地址：    http://' + i.address + ':' + PORT);
      });
    });
    console.log('  两台设备打开同一地址后，一方“创建联机码”，另一方输入该码即可对战。');
    console.log('  退出：Ctrl+C');
  });
}

module.exports = server; // 供测试直接引入
