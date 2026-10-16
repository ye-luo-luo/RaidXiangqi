/* ============================================================================
 * 突袭匈汉象棋 1.0 — 联机客户端（浏览器 + Node 双端可用，UMD）
 *
 * 提供两种联机传输，对外统一接口：
 *   mode 'peer'  — 互联网直连（PeerJS 公共信令云 + WebRTC），无服务器，需联网加载库
 *   mode 'relay' — 自带中继（server.js，同一 Wi-Fi / 本机 / 公网均可），零外部依赖
 *
 * 用法（浏览器，ui.js 使用）：
 *   Net.createRoom({ mode:'peer' })                        // 房主（先手·红）
 *   Net.createRoom({ mode:'relay', relayUrl })             // 房主
 *   Net.joinRoom({ mode:'peer', code })                    // 加入（后手·黑）
 *   Net.joinRoom({ mode:'relay', relayUrl, code })
 *   -> Promise<Room>
 *   Room: { mode, isHost, code, on(ev,fn), send(obj), close() }
 *         ev: 'open' | 'message' | 'error' | 'close'
 *
 * 消息协议（两种传输相同）：
 *   { t:'sys', ev:'peer-joined'|'peer-left' }  系统事件（库内部处理，触发 open/close）
 *   { t:'move', m:{fx,fy,tx,ty} }              一步着法
 *   { t:'restart' }                            重新开始
 * ========================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else if (root) root.Net = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符 O/0/I/1
  var PEER_CDNS = [
    'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  ];

  function genCode(len) {
    len = len || 6;
    var out = '';
    for (var i = 0; i < len; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return out;
  }

  /* 统一 Room：事件可先注册也可后注册（缓冲），避免竞态丢消息；
   * send/close 由各传输在创建后覆盖。 */
  function makeRoom(info) {
    var handlers = {};
    var buffered = [];
    function fire(ev, arg) {
      if (handlers[ev]) { try { handlers[ev](arg); } catch (e) {} }
      else buffered.push([ev, arg]);
    }
    return {
      mode: info.mode,
      isHost: !!info.isHost,
      code: info.code,
      on: function (ev, fn) {
        handlers[ev] = fn;
        buffered = buffered.filter(function (b) {
          if (handlers[b[0]]) { try { handlers[b[0]](b[1]); } catch (e) {} return false; }
          return true;
        });
        return this;
      },
      send: function () {},   // 传输覆盖
      close: function () {},  // 传输覆盖
      _fire: fire,
    };
  }

  /* ------------------------------ PeerJS ------------------------------ */
  function loadPeerJS() {
    if (typeof window === 'undefined') {
      // Node：仅当注入了测试桩时可用
      return new Promise(function (resolve, reject) {
        if (typeof module !== 'undefined' && module.exports && module.exports._peerShim) resolve();
        else reject(new Error('Node 环境需要注入 Peer 测试桩'));
      });
    }
    if (window.Peer) return Promise.resolve();
    if (window.__netLoadingPeer) return window.__netLoadingPeer;
    window.__netLoadingPeer = new Promise(function (resolve, reject) {
      var tried = 0;
      function tryNext() {
        if (tried >= PEER_CDNS.length) { delete window.__netLoadingPeer; reject(new Error('无法加载 PeerJS（网络受限）')); return; }
        var s = document.createElement('script');
        s.src = PEER_CDNS[tried++];
        s.onload = function () { if (window.Peer) { delete window.__netLoadingPeer; resolve(); } else tryNext(); };
        s.onerror = function () { if (s.remove) s.remove(); tryNext(); };
        document.head.appendChild(s);
      }
      tryNext();
    });
    return window.__netLoadingPeer;
  }

  function getPeerCtor() {
    if (typeof window !== 'undefined' && window.Peer) return window.Peer;
    if (typeof module !== 'undefined' && module.exports && module.exports._peerShim) return module.exports._peerShim;
    return null;
  }

  /* 自定义信令服务器地址 → PeerJS options。
   * 留空返回 null（用 PeerJS 默认公共云 0.peerjs.com）；
   * 支持 "host:port" 与 "https://host:port/path" 两种写法。 */
  function peerOptsFromServer(str) {
    str = String(str || '').trim();
    if (!str) return null;
    var secure = false, path = '/', host = str, port = 443;
    var m = str.match(/^(https?):\/\/([^\/]+)(\/.*)?$/i);
    if (m) {
      secure = m[1].toLowerCase() === 'https';
      path = m[3] || '/';
      var hp = m[2], c = hp.lastIndexOf(':');
      if (c >= 0) { host = hp.slice(0, c); port = parseInt(hp.slice(c + 1), 10) || (secure ? 443 : 80); }
      else { port = secure ? 443 : 80; }
    } else {
      var j = str.lastIndexOf(':');
      if (j >= 0) { host = str.slice(0, j); port = parseInt(str.slice(j + 1), 10) || 9000; }
      else { port = 9000; }
    }
    return { host: host, port: port, path: path || '/', secure: secure };
  }

  /* PeerJS 错误类型 → 中文提示（区分“信令服务器不可达”与“对方不可达”） */
  function peerErrText(type, cfg) {
    var t = type || 'unknown';
    var where = cfg ? ('自建信令 ' + cfg.host + ':' + cfg.port) : '公共信令服务器 0.peerjs.com';
    switch (t) {
      case 'browser-incompatible': return '当前浏览器不支持 WebRTC，无法使用互联网联机';
      case 'network': return '网络错误：无法连接' + where;
      case 'server-error': return where + ' 返回错误（服务不可用）';
      case 'socket-error': return '无法连接' + where + '（连接被拒绝或中断）';
      case 'socket-closed': return where + ' 连接已关闭';
      case 'ssl-unavailable': return where + ' 的 SSL 不可用（https 页面需 wss 服务器）';
      case 'invalid-id': return '联机码格式无效';
      case 'invalid-key': return where + ' 的 key 无效';
      case 'unavailable-id': return '联机码被占用，请重试';
      default: return '联机失败：' + t;
    }
  }

  function peerCreateRoom(opts) {
    var cfg = peerOptsFromServer(opts && opts.server);
    return loadPeerJS().then(function () {
      return new Promise(function (resolve, reject) {
        var Ctor = getPeerCtor();
        if (!Ctor) { reject(new Error('PeerJS 不可用')); return; }
        var attempt = 0;
        (function tryCreate() {
          var code = genCode(6);
          var peer = cfg ? new Ctor(code, cfg) : new Ctor(code);
          var room = makeRoom({ mode: 'peer', isHost: true, code: code });
          var registered = false;
          room.send = function (msg) {
            try { if (room._info && room._info.conn && room._info.conn.open) room._info.conn.send(msg); } catch (e) {}
          };
          room.close = function () {
            try { if (room._info && room._info.conn) room._info.conn.close(); } catch (e) {}
            try { peer.destroy(); } catch (e) {}
          };
          // 关键：只有真正注册到信令服务器（open）之后，才把联机码交给界面显示，
          // 避免“拿到码但对方永远连不上”的假象。
          peer.on('open', function () {
            registered = true;
            peer.on('connection', function (conn) {
              if (room._info) return;
              conn.on('open', function () {
                if (room._info) return;
                room._info = { conn: conn };
                conn.on('data', function (d) { room._fire('message', d); });
                conn.on('close', function () { room._fire('close'); });
                conn.on('error', function (e) { room._fire('error', e); });
                room._fire('open');
              });
            });
            resolve(room);
          });
          peer.on('error', function (err) {
            var type = err && err.type;
            if (!registered) {
              if (type === 'unavailable-id' && attempt < 6) {
                attempt++;
                try { peer.destroy(); } catch (e) {}
                setTimeout(tryCreate, 30);
                return;
              }
              reject(new Error(peerErrText(type, cfg)));   // 注册失败：明确报错，不再静默假成功
            } else {
              room._fire('error', err);                     // 注册后再出错 → 交给界面提示
            }
          });
        })();
      });
    });
  }

  function peerJoinRoom(code, opts) {
    var cfg = peerOptsFromServer(opts && opts.server);
    return loadPeerJS().then(function () {
      return new Promise(function (resolve, reject) {
        var Ctor = getPeerCtor();
        if (!Ctor) { reject(new Error('PeerJS 不可用')); return; }
        var peer = cfg ? new Ctor(undefined, cfg) : new Ctor(); // 随机 id
        var room = makeRoom({ mode: 'peer', isHost: false, code: code });
        var settled = false;
        var conn = null;
        var timer = null;
        room.send = function (msg) { try { if (conn && conn.open) conn.send(msg); } catch (e) {} };
        room.close = function () { try { if (conn) conn.close(); } catch (e) {} try { peer.destroy(); } catch (e) {} };
        function fail(e) { if (settled) return; settled = true; if (timer) clearTimeout(timer); reject(e); }
        function bind(c) {
          conn = c;
          c.on('data', function (d) { room._fire('message', d); });
          c.on('close', function () { room._fire('close'); });
          c.on('error', function (e) { room._fire('error', e); });
          room._fire('open');
        }
        timer = setTimeout(function () {
          fail(new Error('连接对方超时（双方网络无法直连，建议改用「局域网联机」）'));
        }, 20000);
        peer.on('open', function () {
          conn = peer.connect(code, { reliable: true });
          conn.on('open', function () {
            if (settled) return;
            settled = true; clearTimeout(timer);
            bind(conn);
            resolve(room);
          });
          conn.on('error', function (e) {
            var t = e && (e.type || e.message);
            if (t === 'peer-unavailable') fail(new Error('联机码无效或对方不在线（房主可能未连上信令服务器）'));
            else fail(new Error('连接失败：' + (t || e)));
          });
        });
        peer.on('error', function (err) {
          var type = err && err.type;
          if (type === 'peer-unavailable') {
            fail(new Error('联机码无效或对方不在线（房主可能未连上信令服务器）'));
          } else if (type === 'network' || type === 'server-error' || type === 'socket-error'
            || type === 'socket-closed' || type === 'ssl-unavailable' || type === 'browser-incompatible') {
            fail(new Error(peerErrText(type, cfg)));
          }
        });
      });
    });
  }

  /* ------------------------------ 中继传输 ------------------------------ */
  function detectRelayBase() {
    if (typeof location === 'undefined' || typeof fetch === 'undefined') return Promise.resolve(null);
    var origin = location.origin;
    if (!origin) return Promise.resolve(null);
    return fetch(origin + '/__relay/health').then(function (r) {
      if (!r.ok) return null;
      return r.json().then(function (j) { return j && j.ok ? origin : null; });
    }).catch(function () { return null; });
  }
  function resolveRelayBase(opts) {
    if (opts.relayUrl) return Promise.resolve(String(opts.relayUrl).trim().replace(/\/+$/, ''));
    return detectRelayBase();
  }
  function relayFetch(base, path, opts) {
    return fetch(base.replace(/\/$/, '') + path, opts).then(function (r) { return r.json(); });
  }

  function relayCreateRoom(opts) {
    return resolveRelayBase(opts).then(function (base) {
      if (!base) throw new Error('未找到中继服务器，请填写服务器地址');
      var code = genCode(6);
      return relayFetch(base, '/__relay/room/' + encodeURIComponent(code) + '/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ create: true }),
      }).then(function (j) {
        if (!j.ok) throw new Error(j.error || '创建房间失败');
        return relayRoom(base, code, j.player, true);
      });
    });
  }

  function relayJoinRoom(opts) {
    return resolveRelayBase(opts).then(function (base) {
      if (!base) throw new Error('未找到中继服务器，请填写服务器地址');
      var code = String(opts.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{3,12}$/.test(code)) throw new Error('联机码格式无效');
      return relayFetch(base, '/__relay/room/' + encodeURIComponent(code) + '/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ create: false }),
      }).then(function (j) {
        if (!j.ok) throw new Error(j.error || '加入失败');
        return relayRoom(base, code, j.player, false);
      });
    });
  }

  function relayRoom(base, code, player, isHost) {
    var room = makeRoom({ mode: 'relay', isHost: isHost, code: code });
    var closed = false;
    var since = -1; // 从 -1 开始，确保能收到第 1 条消息（peer-joined，序号从 0 起）
    var consecErr = 0;

    room.send = function (msg) {
      return relayFetch(base, '/__relay/room/' + encodeURIComponent(code) + '/msg', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: player === 'a' ? 'b' : 'a', msg: msg }),
      }).catch(function () {});
    };
    room.close = function () {
      if (closed) return;
      closed = true;
      relayFetch(base, '/__relay/room/' + encodeURIComponent(code) + '/leave?player=' + player).catch(function () {});
      room._fire('close');
    };

    function poll() {
      if (closed) return;
      var ctl = new AbortController();
      var t = setTimeout(function () { ctl.abort(); }, 22000);
      fetch(base.replace(/\/$/, '') + '/__relay/room/' + encodeURIComponent(code) + '/poll?player=' + player + '&since=' + since, { signal: ctl.signal })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          clearTimeout(t);
          if (closed) return;
          if (!j || !j.ok) {
            consecErr++;
            if (consecErr >= 3) { if (!closed) { closed = true; room._fire('close'); } return; }
            room._fire('error', new Error((j && j.error) || '中继响应异常'));
            return poll();
          }
          consecErr = 0;
          if (typeof j.since === 'number') since = j.since;
          (j.messages || []).forEach(function (m) {
            if (closed) return;
            if (m && m.t === 'sys') {
              if (m.ev === 'peer-joined') room._fire('open');
              else if (m.ev === 'peer-left') { closed = true; room._fire('close'); }
            } else {
              room._fire('message', m);
            }
          });
          if (!closed) poll();
        })
        .catch(function (e) {
          clearTimeout(t);
          if (closed) return;
          if (e && e.name === 'AbortError') { poll(); return; } // 长轮询超时重试
          consecErr++;
          if (consecErr >= 3) { if (!closed) { closed = true; room._fire('close'); } return; }
          room._fire('error', e);
          poll();
        });
    }
    poll();
    return room;
  }

  /* ------------------------------ 对外接口 ------------------------------ */
  return {
    genCode: genCode,
    loadPeerJS: loadPeerJS,
    createRoom: function (opts) {
      opts = opts || {};
      return opts.mode === 'relay' ? relayCreateRoom(opts) : peerCreateRoom(opts);
    },
    joinRoom: function (opts) {
      opts = opts || {};
      return opts.mode === 'relay' ? relayJoinRoom(opts)
        : peerJoinRoom(String(opts.code || '').trim().toUpperCase(), opts);
    },
    _setPeerShim: function (ctor) { module.exports._peerShim = ctor; },
  };
});
