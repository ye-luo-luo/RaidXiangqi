/* ============================================================================
 * 突袭匈汉象棋 1.0 — 界面与交互（依赖 js/logic.js 的全局 XG）
 * ========================================================================== */
(function () {
  'use strict';
  if (typeof XG === 'undefined') {
    document.getElementById('status').textContent = '加载失败：缺少规则引擎';
    return;
  }

  var state = null;
  var history = [];      // 每步之前的局面快照
  var stateSeq = [];     // 局面序列：stateSeq[0]=初始，stateSeq[i]=第 i 步后
  var moveSeq = [];      // 着法序列 [{fx,fy,tx,ty,side,strike,capture,text}]
  var plyList = [];      // 着法记录 [{text, side, strike}]
  var repCounts = new Map();
  var selected = null;   // {x, y}
  var legalMap = {};     // "tx,ty" -> move
  var aiOn = false;
  var aiSide = 'hun';    // AI 执黑（匈）
  var flipped = false;
  var busy = false;      // AI 思考中
  var aiTimer = null;
  var replaying = false; // 回放中
  var replayIdx = 0;     // 回放到的步数（stateSeq 下标）
  var replayPlaying = false;
  var replayTimer = null;
  var replaySpeed = 1;   // 秒/步，默认 1s
  var net = null;        // 联机：{mode, room, isHost, mySide, selMy, selOp, format, connected, code, match, undo, phase, guestReady, drawPending}
  var netBusy = false;   // 创建/加入房间进行中
  var undoReqPending = null; // 收到对方的悔棋申请 {by}（等待本机回复）
  var drawPending = false;   // 我提出的和棋认定是否待对方回复
  var offerReqPending = null; // 收到对方的和棋认定 {by}（弹窗待回复）
  var btnResignArmed = false; // 认输二次确认
  var pingTimer = null;       // 延时（ping）定时器
  var pingMs = null;          // 最近一次往返延时 ms

  var VERSION = (XG && XG.VERSION) || '1.00.001';

  function netLib() { return (typeof window !== 'undefined' && window.Net) || null; }

  function otherSide(s) { return s === 'han' ? 'hun' : 'han'; }
  function sendNet(msg) { if (net && net.room) { try { net.room.send(msg); } catch (e) {} } }

  /* 新建联机会话的匹配状态（赛制 + 比分[红:平:黑] + 悔棋计数） */
  function freshMatch(format) {
    return {
      format: format === 'bo3' ? 'bo3' : 'one',
      target: format === 'bo3' ? 2 : 1,
      score: { han: 0, draw: 0, hun: 0 },
      games: 0,
      over: false,
    };
  }

  // 比分文案：xx：xx：xx（中间为平局数）
  function scoreText() {
    if (!net || !net.match) return '';
    return '红' + net.match.score.han + ' : 平' + net.match.score.draw + ' : ' + net.match.score.hun + '黑';
  }

  /* 一局结束：设定胜负 + 累计比分（联机） + 结算弹窗。
   * 注意：doMove 走到这里时 state.winner 可能已被引擎设置，因此用 gameScored
   * 标记防重入，而不是检查 state.winner。 */
  var gameScored = false;
  function endGame(winner, resultText) {
    if (!state || gameScored) return;
    gameScored = true;
    state.winner = winner;
    state.result = resultText || (winner === 'draw' ? '和棋' : '对局结束');
    if (net && net.connected && net.match) {
      if (winner === 'draw') {
        net.match.score.draw = (net.match.score.draw || 0) + 1;
        net.match.games++;
      } else {
        net.match.score[winner] = (net.match.score[winner] || 0) + 1;
        net.match.games++;
        if (net.match.score[winner] >= net.match.target) net.match.over = true;
      }
    }
    updateNetMatchInfo();
    sEnd();
    showResult();
    render();
  }

  // 联机弹窗内的赛制+比分信息（比分变动时刷新）
  function updateNetMatchInfo() {
    var infoEl = $('net-match-info');
    if (!infoEl || !net || !net.match) return;
    infoEl.textContent = '赛制：' +
      (net.match.format === 'bo3' ? '事不过三（三局两胜，平局加赛）' : '一锤定音（平局加赛）') +
      ' · 比分 ' + scoreText();
  }

  function startOnlineGame() {
    if (!net || !net.mySide) return;
    net.phase = 'playing';
    if ($('net-lobby')) $('net-lobby').hidden = true;
    newGame();
  }

  /* 联机进行中（含等待对方）时禁止本地"新局/悔棋"控制 */
  function canLocalControl() { return !net; }

  /* 当前要显示的局面：回放时取回放位置，否则取实时对局 */
  function viewState() { return replaying ? stateSeq[replayIdx] : state; }

  var $ = function (id) { return document.getElementById(id); };
  var boardEl = $('board');
  var statusEl = $('status');
  var movebarEl = $('movebar');
  var riverLabel = $('river-label');
  var boardwrap = $('boardwrap');

  /* 静态线格背景（SVG）：11×12 交叉点，横线 12 条、竖线两段（河界断开）、九宫斜线。
   * 传入 flipped：翻转 180° 时把两个九宫（汉/匈）的位置镜像对调，保证与棋子镜像一致。 */
  function gridSVG(flipped) {
    function sy(y) { return 50 + (XG.H - 1 - y) * 100; }   // 内部 y → SVG y
    function mir(y) { return flipped ? XG.H - 1 - y : y; }  // 翻转：内部 y 镜像
    // 九宫内部 y 范围 [lo,hi] → 矩形上缘 svg y（翻转后整体对调）
    function topY(lo, hi) { return sy(flipped ? XG.H - 1 - lo : hi); }
    function botY(lo, hi) { return sy(flipped ? XG.H - 1 - hi : lo); }
    var pts = [];
    for (var yi = 0; yi < XG.H; yi++) {
      var y = sy(mir(yi));
      pts.push('M50 ' + y + ' L1050 ' + y);
    }
    for (var xi = 0; xi < XG.W; xi++) {
      var x = 50 + xi * 100;
      pts.push('M' + x + ' 50 L' + x + ' 550');   // 河界以上（y=11 → y=6）
      pts.push('M' + x + ' 650 L' + x + ' 1150'); // 河界以下（y=5 → y=0）
    }
    var hanT = topY(1, 3), hanB = botY(1, 3);     // 汉九宫（内部 y 1..3）
    var hunT = topY(8, 10), hunB = botY(8, 10);   // 匈九宫（内部 y 8..10）
    pts.push('M450 ' + hanB + ' L650 ' + hanT);   // 汉九宫 \
    pts.push('M650 ' + hanB + ' L450 ' + hanT);   // 汉九宫 /
    pts.push('M450 ' + hunB + ' L650 ' + hunT);   // 匈九宫 \
    pts.push('M650 ' + hunB + ' L450 ' + hunT);   // 匈九宫 /
    return '<svg class="grid" viewBox="0 0 1100 1200" preserveAspectRatio="none" aria-hidden="true">' +
      '<rect class="pb" x="450" y="' + hanT + '" width="200" height="200"/>' +
      '<rect class="pb" x="450" y="' + hunT + '" width="200" height="200"/>' +
      '<rect class="rb" x="50" y="550" width="1000" height="100"/>' +
      '<path class="gl" d="' + pts.join(' ') + '"/>' +
      '</svg>';
  }

  /* ------------------------------ 音效 ------------------------------ */
  var audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* 无声环境忽略 */ }
  }
  function tone(freq, dur, type, gain, when) {
    try {
      if (!audioCtx) return;
      var t = audioCtx.currentTime + (when || 0);
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(gain || 0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  }
  function sMove() { tone(260, 0.1); }
  function sCapture() { tone(340, 0.08); tone(180, 0.14, 'square', 0.05, 0.08); }
  function sStrike() { tone(540, 0.07, 'triangle'); tone(360, 0.16, 'square', 0.05, 0.06); }
  function sEnd() { tone(520, 0.12, 'triangle'); tone(660, 0.12, 'triangle', 0.05, 0.12); tone(780, 0.2, 'triangle', 0.05, 0.24); }

  /* ------------------------------ 尺寸 ------------------------------ */
  function fitBoard() {
    var header = document.querySelector('header').offsetHeight || 60;
    var footer = document.querySelector('footer').offsetHeight || 90;
    var availW = window.innerWidth - 30;
    var availH = window.innerHeight - header - footer - 14;
    var cell = Math.floor(Math.min(availW / 11, availH / 12));
    cell = Math.max(22, Math.min(cell, 58));
    document.documentElement.style.setProperty('--cell', cell + 'px');
  }
  window.addEventListener('resize', fitBoard);
  window.addEventListener('orientationchange', function () { setTimeout(fitBoard, 60); });
  document.addEventListener('pointerdown', ensureAudio, { once: true });

  /* ------------------------------ 坐标映射 ------------------------------ */
  // 显示行 r（0=最上）→ 内部 y；显示列 c（0=最左）→ 内部 x
  function rowToY(r) { return flipped ? r : XG.H - 1 - r; }
  function yToRow(y) { return flipped ? y : XG.H - 1 - y; }
  function colToX(c) { return flipped ? XG.W - 1 - c : c; }
  function xToCol(x) { return flipped ? XG.W - 1 - x : x; }

  /* ------------------------------ 新局 / 悔棋 ------------------------------ */
  function newGame() {
    history = [];
    stateSeq = [];
    moveSeq = [];
    plyList = [];
    repCounts = new Map();
    selected = null;
    legalMap = {};
    gameScored = false;
    exitReplayUi();
    $('result-modal').hidden = true;
    state = XG.newState();
    stateSeq.push(state);
    cancelAi();
    busy = false;
    render();
    if (aiOn && state.turn === aiSide) scheduleAi();
  }

  function humanSide() { return aiOn ? XG.other(aiSide) : null; }

  function undo() {
    exitReplayUi();
    cancelAi();
    if (!history.length) return;
    var before = history.length;
    var target = null;
    if (!aiOn) {
      // 双人：悔一步
      target = history.pop();
    } else {
      // 人机：悔到轮到"人"的那一步（含撤掉 AI 着法）
      var hs = humanSide();
      while (history.length) {
        target = history.pop();
        if (target.turn === hs) break;
      }
    }
    var popped = before - history.length;
    if (target) {
      state = target;
      gameScored = false;
      selected = null;
      legalMap = {};
      stateSeq.length = Math.max(1, stateSeq.length - popped);
      moveSeq.length = Math.max(0, moveSeq.length - popped);
      $('result-modal').hidden = true;
      rebuildRepCounts();
      render();
    }
  }

  function rebuildRepCounts() {
    repCounts = new Map();
    var all = history.concat([state]);
    for (var i = 0; i < all.length; i++) {
      var k = XG.positionKey(all[i]);
      repCounts.set(k, (repCounts.get(k) || 0) + 1);
    }
  }

  function gameOver() { return !!(state && state.winner); }

  // 当前是否轮到"人类"操作：本地（人机/双人）按 AI 设定，联机按我方执子方（仅对局中）
  function canHumanMove() {
    if (!state || replaying || busy || gameOver()) return false;
    if (net && net.connected) return net.phase === 'playing' && state.turn === net.mySide;
    return !aiOn || state.turn !== aiSide;
  }

  /* ------------------------------ 渲染 ------------------------------ */
  function render() {
    var cur = viewState();
    if (!cur) return;
    var humanCanAct = canHumanMove();

    // 棋盘：线格背景（随翻转镜像）+ 交叉点上的棋子/标记
    var html = gridSVG(flipped);
    for (var r = 0; r < XG.H; r++) {
      for (var c = 0; c < XG.W; c++) {
        var y = rowToY(r);   // 内部 y（翻转时 r=y，即 180° 镜像）
        var x = colToX(c);   // 内部 x（翻转时 c=W-1-x）
        var itClass = ['it'];
        if (cur.lastMove) {
          if (cur.lastMove.from[0] === x && cur.lastMove.from[1] === y) itClass.push('last-from');
          if (cur.lastMove.to[0] === x && cur.lastMove.to[1] === y) itClass.push('last-to');
        }
        if (!replaying && selected && selected.x === x && selected.y === y) itClass.push('selected');
        if (isClamped(x, y)) itClass.push('clamped');
        var p = cur.board[y][x];
        var mvTarget = !replaying ? legalMap[x + ',' + y] : null;
        if (mvTarget && p) itClass.push(mvTarget.strike ? 'strike-target' : 'cap-target');
        var left = (((c + 0.5) / XG.W) * 100).toFixed(3) + '%';   // 按显示列定位
        var top = (((r + 0.5) / XG.H) * 100).toFixed(3) + '%';    // 按显示行定位
        var it = '<div class="' + itClass.join(' ') + '" style="left:' + left + ';top:' + top + '" data-x="' + x + '" data-y="' + y + '">';
        if (p) {
          var extra = 'piece ' + p.side;
          if (p.type === 'king') extra += ' kingpiece';
          if (p.type === 'raider' || p.type === 'attacker' || p.type === 'ram') extra += ' special';
          it += '<div class="' + extra + '">' + XG.nameOf(p) + '</div>';
        } else if (mvTarget) {
          it += '<div class="marker"></div>';
        }
        it += '</div>';
        html += it;
      }
    }
    boardEl.innerHTML = html;

    // 河界文字
    riverLabel.textContent = flipped ? '界匈 · 界汉' : '汉界 · 匈界';

    // 状态栏
    var status = '';
    if (replaying) {
      status = '<span style="color:#6a4a10">▶ 回放中</span> ' +
        (replayIdx > 0 ? esc(moveSeq[replayIdx - 1].text) : '（初始局面）') +
        ' <span style="color:#999">' + replayIdx + ' / ' + moveSeq.length + '</span>';
    } else if (cur.winner) {
      status = '<span style="font-weight:800;color:#b3371b">🏁 ' + esc(cur.result || '对局结束') + '</span>';
    } else if (net) {
      var sideName = cur.turn === 'han' ? '汉军（红）' : '匈军（黑）';
      if (!net.connected) {
        status = '<span style="color:#1a7a3a">🌐 联机：' +
          (net.isHost ? '等待对方加入…' : '等待房主分配执子方…') + '</span>';
      } else if (net.phase === 'lobby') {
        status = '<span style="color:#1a7a3a">🌐 已连接 · 等待开始…</span>' +
          (net.isHost
            ? ' <span style="color:#999">（对方准备后点「开始对局」）</span>'
            : ' <span style="color:#999">（点击「准备」）</span>');
        if (net.match) {
          status += ' · <span style="color:#8a5a1a">' + scoreText() + '</span>';
        }
      } else {
        var myTurn = cur.turn === net.mySide;
        status = '<span class="side-dot ' + cur.turn + '"></span>' + sideName + ' 走棋';
        status += myTurn
          ? ' · <span style="color:#1a7a3a">轮到你</span>'
          : ' · <span style="color:#777">等待对方…</span>';
        if (XG.inCheck(cur, cur.turn)) status += ' · <span class="check">将军！</span>';
        if (net.match) {
          status += ' · <span style="color:#8a5a1a">' + scoreText() + '</span>';
        }
        var myU = net.undo[net.mySide];
        if (myU && myU.free > 0) {
          status += ' · <span style="color:#1a7a3a">免同意悔棋×' + myU.free + '</span>';
        }
        if (pingMs != null) status += ' · <span style="color:#666">延时 ' + pingMs + 'ms</span>';
      }
    } else {
      var sideName2 = cur.turn === 'han' ? '汉军（红）' : '匈军（黑）';
      status = '<span class="side-dot ' + cur.turn + '"></span>' + sideName2 + ' 走棋';
      if (busy) status += ' · <span style="color:#6a4a10">AI 思考中…</span>';
      if (XG.inCheck(cur, cur.turn)) status += ' · <span class="check">将军！</span>';
      if (!humanCanAct && !busy) status += ' · <span style="color:#777">轮到 AI</span>';
    }
    statusEl.innerHTML = status;

    // 着法记录
    var mvHtml = '';
    for (var i = 0; i < plyList.length; i++) {
      mvHtml += '<span class="mv ' + plyList[i].side + (plyList[i].strike ? ' strike' : '') + '">' +
        (i + 1) + '. ' + esc(plyList[i].text) + '</span>';
    }
    movebarEl.innerHTML = mvHtml;
    movebarEl.scrollTop = movebarEl.scrollHeight;
    syncLocalControls();   // 走子后刷新 认输/求和 等按钮状态（步数门槛随局实时变化）
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  // 该格上的棋子是否正被对方夹击（可被突/袭"突袭"吃掉，但可自由移动、无钳制）
  function isClamped(x, y) {
    var st = viewState();
    if (!st) return false;
    for (var s = 0; s < XG.SIDES.length; s++) {
      var list = st.clamps[XG.SIDES[s]];
      for (var i = 0; i < list.length; i++) {
        var cl = list[i];
        if (cl.strikers && cl.strikers.length && cl.enemyX === x && cl.enemyY === y) return true;
      }
    }
    return false;
  }

  /* ------------------------------ 交互 ------------------------------ */
  function onCellTap(x, y) {
    if (!state || replaying || gameOver() || busy) return;
    if (!canHumanMove()) return;
    var turn = state.turn;

    var p = state.board[y][x];
    if (selected) {
      var key = x + ',' + y;
      if (legalMap[key]) { doMove(legalMap[key]); return; }
      if (p && p.side === turn) { select(x, y); return; }
      selected = null; legalMap = {}; render(); return;
    }
    if (p && p.side === turn) { select(x, y); }
  }

  function select(x, y) {
    selected = { x: x, y: y };
    legalMap = {};
    var moves = XG.allLegalMoves(state, state.turn);
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      if (m.fromX === x && m.fromY === y) legalMap[m.toX + ',' + m.toY] = m;
    }
    render();
  }

  function doMove(move, opts) {
    opts = opts || {};
    if (!move) return;
    history.push(state);
    state = XG.applyMove(state, move.fromX, move.fromY, move.toX, move.toY);
    if (!state) { history.pop(); return; }
    selected = null;
    legalMap = {};

    if (move.capture) { if (move.strike) sStrike(); else sCapture(); } else sMove();

    // 记录着法
    var piece = state.lastMove.piece;
    var nm = XG.nameOf(piece);
    var txt = (piece.side === 'han' ? '红' : '黑') + nm +
      ' ' + move.fromX + ',' + move.fromY + '→' + move.toX + ',' + move.toY;
    if (move.capture) txt += (move.strike ? ' ⚡突袭' : ' 吃');
    plyList.push({ text: txt, side: piece.side, strike: move.strike });
    stateSeq.push(state);
    moveSeq.push({
      fx: move.fromX, fy: move.fromY, tx: move.toX, ty: move.toY,
      side: piece.side, strike: move.strike, capture: move.capture, text: txt
    });

    // 三次重复判和
    var key = XG.positionKey(state);
    repCounts.set(key, (repCounts.get(key) || 0) + 1);
    if (!state.winner && repCounts.get(key) >= 3) {
      state.winner = 'draw';
      state.result = '和棋（三次重复局面）';
    }

    render();
    // 本地走子：联机时把着法发给对方（对方收到的着法不会再回传）
    if (!opts.fromNet && net && net.connected) {
      try {
        net.room.send({ t: 'move', m: { fx: move.fromX, fy: move.fromY, tx: move.toX, ty: move.toY } });
      } catch (e) {}
    }
    if (state.winner) {
      endGame(state.winner, state.result);
      return;
    }
    if (!opts.fromNet && aiOn && state.turn === aiSide) scheduleAi();
  }

  /* 联机：应用对方发来的着法 */
  function applyNetMove(m) {
    if (!state || replaying || gameOver()) return;
    var moves = XG.allLegalMoves(state, state.turn);
    for (var i = 0; i < moves.length; i++) {
      var mm = moves[i];
      if (mm.fromX === m.fx && mm.fromY === m.fy && mm.toX === m.tx && mm.toY === m.ty) {
        doMove(mm, { fromNet: true });
        return;
      }
    }
    setNetStatus('⚠ 同步异常：对方的着法无法应用');
  }

  function onNetMessage(m) {
    if (!m || !m.t) return;
    if (m.t === 'move') applyNetMove(m.m);
    else if (m.t === 'restart') {
      if (net && net.connected) {
        if (m.reset) resetMatchScore();
        else if (net.match && net.match.games >= 1) swapNetSides();   // 下一局换边
      }
      newGame();
    }
    else if (m.t === 'hello') onNetHello(m);
    else if (m.t === 'assign') onNetAssign(m);
    else if (m.t === 'side-sel') onNetSideSel(m);
    else if (m.t === 'format-sel') onNetFormatSel(m);
    else if (m.t === 'ping') onNetPing(m);
    else if (m.t === 'pong') onNetPong(m);
    else if (m.t === 'undo-req') onUndoReq(m);
    else if (m.t === 'undo-resp') onUndoResp(m);
    else if (m.t === 'undo') onNetUndo(m);
    else if (m.t === 'ready') onNetReady(m);
    else if (m.t === 'start') onNetStart(m);
    else if (m.t === 'resign') onNetResign(m);
    else if (m.t === 'draw-offer') onDrawOffer(m);
    else if (m.t === 'draw-accept') onDrawAccept(m);
    else if (m.t === 'draw-refuse') onDrawRefuse(m);
  }

  function cancelAi() {
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    busy = false;
  }

  function scheduleAi() {
    cancelAi();
    busy = true;
    render();
    aiTimer = setTimeout(function () {
      aiTimer = null;
      if (!state || gameOver() || state.turn !== aiSide) { busy = false; render(); return; }
      var move = XG.aiChoose(state, aiSide);
      busy = false;
      if (!move) return; // 不应发生（无着法已在 applyMove 判和）
      doMove(move);
    }, 380);
  }

  /* ------------------------------ 结算弹窗 ------------------------------ */
  function showResult() {
    if (!state || !state.winner) return;
    var title = state.winner === 'draw' ? '🤝 和棋' : '🏁 对局结束';
    var text = state.result || '';
    if (net && net.connected && net.match) {
      var sc = net.match.score;
      var fmtName = net.match.format === 'bo3' ? '事不过三（三局两胜）' : '一锤定音';
      var scoreLine = scoreText();   // 红X : 平Y : 黑Z
      if (net.match.over) {
        var winSide = sc.han >= net.match.target ? 'han' : 'hun';
        var winName = winSide === 'han' ? '汉军（红）' : '匈军（黑）';
        title = net.mySide === winSide ? '🏆 你赢得了比赛！' : '🏁 对方赢得了比赛！';
        text = scoreLine + ' · ' + fmtName + ' · 获胜方：' + winName;
        $('result-restart').textContent = '🔄 重新开始比赛';
      } else {
        if (state.winner === 'draw') {
          title = '🤝 和棋 · 加赛一局';
          text = scoreLine + ' · ' + fmtName + '（先到 ' + net.match.target + ' 胜）\n' + (text || '');
        } else {
          title = state.winner === net.mySide ? '🎉 你赢了本局！' : '😔 你输了本局';
          text = scoreLine + ' · ' + fmtName + '（先到 ' + net.match.target + ' 胜）\n' + (text || '');
        }
        $('result-restart').textContent = net.match.format === 'bo3' ? '▶ 下一局' : '🔄 加赛一局';
      }
    } else {
      $('result-restart').textContent = '🔄 重新开始';
    }
    $('result-title').textContent = title;
    $('result-text').textContent = text;
    $('result-modal').hidden = false;
  }

  /* ------------------------------ 联机 ------------------------------ */
  function setNetStatus(msg) { $('net-status').textContent = msg || ''; }

  function netUiReset() {
    setNetStatus('');
    $('net-code-wrap').hidden = true;
    $('net-connected').hidden = true;
    var fmtEl = $('net-sel-format'); if (fmtEl) fmtEl.disabled = false;
  }

  function openNetModal() {
    $('net-modal').hidden = false;
    if (net && net.connected) {
      // 联机中：仅展示已连接面板（含「断开」），可随时打开并断开
      if ($('net-tabs')) $('net-tabs').hidden = true;
      if ($('net-body')) $('net-body').hidden = true;
      if ($('net-code-wrap')) $('net-code-wrap').hidden = true;
      if ($('net-connected')) $('net-connected').hidden = false;
      return;
    }
    // 未连接 / 已断开：恢复创建·加入界面
    if ($('net-tabs')) $('net-tabs').hidden = false;
    if ($('net-body')) $('net-body').hidden = false;
    if ($('net-connected')) $('net-connected').hidden = true;
    if (net && !net.connected) {
      showNetCode(net.code, net.mode);
      setNetStatus('等待对方加入… 联机码：' + net.code);
    } else if ($('net-relay-url').value === '' && netLib() && netLib().detectRelayBase) {
      // 页面若由 server.js 托管，自动填入中继地址
      netLib().detectRelayBase().then(function (base) {
        if (base && $('net-relay-url').value === '') $('net-relay-url').value = base;
      });
    }
  }

  function closeNetModal() { $('net-modal').hidden = true; }

  function showNetCode(code, mode) {
    $('net-code').textContent = code;
    $('net-code-wrap').hidden = false;
    $('net-wait').textContent = mode === 'peer'
      ? '已连上信令服务器 ✓ 把联机码发给对方；对方在「互联网联机」里输入此码即可直连'
      : '把联机码发给对方；对方打开同一地址后输入此码加入';
  }

  function setNetTab(mode) {
    $('panel-peer').hidden = mode !== 'peer';
    $('panel-relay').hidden = mode !== 'relay';
    $('tab-peer').className = 'tab' + (mode === 'peer' ? ' active' : '');
    $('tab-relay').className = 'tab' + (mode === 'relay' ? ' active' : '');
  }

  function relayUrlValue() {
    var v = ($('net-relay-url').value || '').trim();
    return v ? v.replace(/\/+$/, '') : '';
  }

  // 互联网联机：自定义信令服务器（留空 → PeerJS 公共云）
  function peerServerValue() {
    var el = $('net-peer-server');
    return (el && el.value) ? String(el.value).trim() : '';
  }

  function netSidePref() {
    var el = document.querySelector('input[name="net-sel-side"]:checked');
    return (el && el.value === 'hun') ? 'hun' : 'han';
  }

  /* ---------- 大厅：执子 / 赛制 实时选择（连接建立后） ---------- */

  // 我的执子选择：本地记录 + 同步给对方（另一方立即刷新）
  function netSel(side) {
    if (!net) return;
    net.selMy = side === 'hun' ? 'hun' : 'han';
    syncSelUI();
    sendNet({ t: 'side-sel', side: net.selMy });
    if (net.isHost) hostResolve();
  }
  // 对方选择同步
  function onNetSideSel(m) {
    if (!net) return;
    net.selOp = (m && m.side === 'hun') ? 'hun' : 'han';
    syncSelUI();
    if (net.isHost) hostResolve();
  }
  // 房主裁决：双方都选了才分配；选择一致则随机。
  // 同色（双方选同一执子）仅在第一次出现时随机一次，之后复用上次该配置的结果，
  // 避免一方来回改选导致反复洗牌。
  function hostResolve() {
    if (!net || !net.isHost) return;
    var a = net.selMy, b = net.selOp;
    if (!a || !b) {
      if (net.mySide) { net.mySide = null; syncSelUI(); }
      return;
    }
    var h;
    if (a !== b) {
      h = a;
    } else {
      if (!net.sameSide) net.sameSide = { han: null, hun: null };
      if (net.sameSide[a] == null) { h = Math.random() < 0.5 ? 'han' : 'hun'; net.sameSide[a] = h; }
      else { h = net.sameSide[a]; }
    }
    if (h !== net.mySide) {
      net.mySide = h;
      sendNet({ t: 'assign', hostSide: h, format: net.format });
    }
    syncSelUI();
  }
  // 房主改赛制：实时同步给加入方（加入方只读显示）
  function netFormatSel(fmt) {
    if (!net) return;
    net.format = fmt === 'bo3' ? 'bo3' : 'one';
    if (net.match) { net.match.format = net.format; net.match.target = net.format === 'bo3' ? 2 : 1; }
    updateNetMatchInfo();
    if (net.isHost) sendNet({ t: 'format-sel', format: net.format });
    syncSelUI();
  }
  function onNetFormatSel(m) {
    if (!net || net.isHost) return;
    var f = (m && m.format === 'bo3') ? 'bo3' : 'one';
    if (f !== net.format) {
      net.format = f;
      if (net.match) { net.match.format = f; net.match.target = f === 'bo3' ? 2 : 1; }
      updateNetMatchInfo();
    }
    var el = $('net-sel-format'); if (el) el.value = f;
    syncSelUI();
  }

  /* 刷新大厅选择区：对方选择、执子分配、准备/开始、延时 */
  function syncSelUI() {
    if (!net) return;
    var op = $('net-sel-op');
    if (op) op.textContent = net.selOp
      ? ('对方执子：' + (net.selOp === 'han' ? '汉（红）' : '匈（黑）'))
      : '对方尚未选择执子';
    var myEl = $('net-my-side');
    if (myEl) myEl.textContent = net.mySide
      ? ('你执' + (net.mySide === 'han' ? '汉军（红），先行' : '匈军（黑），后手'))
      : '执子分配中…';
    updateNetMatchInfo();
    var readyBtn = $('net-ready'), startBtn = $('net-start'), ls = $('net-lobby-status');
    if (net.isHost) {
      if (readyBtn) readyBtn.hidden = true;   // 房主：只显示「开始对局」
      if (startBtn) { startBtn.hidden = false; startBtn.disabled = !(net.guestReady && net.mySide); }
      if (ls) ls.textContent = net.guestReady ? '对方已准备 ✓，可开始对局' : '等待对方选择执子并准备…';
    } else {
      if (readyBtn) { readyBtn.hidden = false; readyBtn.disabled = !net.mySide; }   // 加入方：显示「准备」
      if (startBtn) startBtn.hidden = true;
      if (ls) ls.textContent = net.mySide
        ? ('已分配执子：' + (net.mySide === 'han' ? '汉（红）' : '匈（黑）') + '，点击「准备」')
        : '等待房主分配执子…';
    }
    renderPing();
  }

  /* ---------- 延时计算 + 脱机检测（ping / pong / 看门狗） ---------- */
  var pingTimer = null;       // 定时发 ping
  var watchdogTimer = null;   // 看门狗：验证对方是否脱机
  var lastPong = 0;           // 最近一次收到 pong 的时间
  var PING_INTERVAL = 2000;   // 每 2 秒 ping 一次
  var OFFLINE_MS = 8000;      // 连续 8 秒无回应视为脱机
  function startPing() {
    stopPing();
    if (!net || !net.room) { renderPing(); return; }
    lastPong = Date.now();
    try { sendNet({ t: 'ping', ts: Date.now() }); } catch (e) {}
    pingTimer = setInterval(function () {
      if (!net || !net.room) { stopPing(); return; }
      try { sendNet({ t: 'ping', ts: Date.now() }); } catch (e) {}
    }, PING_INTERVAL);
    // 时刻验证对方是否脱机：长时间无 pong → 判离线并断开
    watchdogTimer = setInterval(function () { pingWatchdog(); }, PING_INTERVAL);
  }
  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  }
  function pingWatchdog(now) {
    if (!net || !net.room || !net.connected) return false;
    var t = (typeof now === 'number') ? now : Date.now();
    if (t - lastPong > OFFLINE_MS) {
      netDisconnect('对方已脱机（长时间无响应）');
      return true;
    }
    return false;
  }
  function onNetPing(m) {
    if (net && net.room && m && typeof m.ts === 'number') {
      try { net.room.send({ t: 'pong', ts: m.ts }); } catch (e) {}
    }
  }
  function onNetPong(m) {
    if (net && m && typeof m.ts === 'number') {
      pingMs = Math.max(0, Date.now() - m.ts);
      lastPong = Date.now();
      renderPing();
    }
  }
  function renderPing() {
    var el = $('net-ping');
    if (el) el.textContent = pingMs == null ? '延时：--' : '延时：' + pingMs + ' ms';
  }

  function netMarkConnected() {
    if (!net) return;
    net.connected = true;
    net.phase = 'lobby';       // 大厅：选择执子/赛制，加入者准备、房主开始
    net.guestReady = false;
    net.undoPending = false;
    net.drawPending = false;
    offerReqPending = null;
    btnResignArmed = false;
    aiOn = false;
    aiSide = 'hun';
    $('ai-toggle').checked = false;
    $('ai-side-wrap').style.display = 'none';
    $('net-status').textContent = '已连接 ✓';
    $('net-connected').hidden = false;
    var lobby = $('net-lobby');
    if (lobby) lobby.hidden = false;
    var fmtEl = $('net-sel-format');
    if (fmtEl) { fmtEl.value = net.format === 'bo3' ? 'bo3' : 'one'; fmtEl.disabled = !net.isHost; }
    // 尚未选执子 → 默认选汉并同步给对方（另一方立即看到）
    if (net.selMy == null) netSel('han');
    else syncSelUI();
    startPing();
    syncLocalControls();
    render();   // 大厅不自动开局，等待房主「开始对局」
  }

  // 加入者准备
  function guestReady() {
    if (!net || !net.connected || net.isHost || net.phase !== 'lobby') return;
    if (net.guestReady) return;
    if (!net.mySide) { setNetStatus('请等待执子分配完成'); return; }
    net.guestReady = true;
    var b = $('net-ready'); if (b) b.disabled = true;
    var ls = $('net-lobby-status'); if (ls) ls.textContent = '已准备 ✓，等待房主开始…';
    sendNet({ t: 'ready' });
  }
  // 房主收到加入者准备 → 解锁「开始对局」
  function onNetReady(m) {
    if (!net || !net.isHost || !net.connected) return;
    net.guestReady = true;
    syncSelUI();
  }
  // 房主开始对局
  function hostStart() {
    if (!net || !net.connected || !net.isHost || net.phase !== 'lobby') return;
    if (!net.guestReady) { setNetStatus('请等待对方先准备'); return; }
    if (!net.mySide) { setNetStatus('请等待执子分配完成'); return; }
    sendNet({ t: 'start' });
    startOnlineGame();
  }
  // 加入者收到房主开始
  function onNetStart(m) {
    if (!net || net.isHost || !net.connected) return;
    startOnlineGame();
  }

  // 认输核心：联机=本方认输；本地=当前走棋方认输（人机=人认输）
  function doResign() {
    if (!state || state.winner) return;
    if ((state.moveNo || 0) <= 10) { setNetStatus('开局前 10 步内不能认输'); return; }
    if (net && net.connected) {
      if (net.phase !== 'playing') return;
      endGame(otherSide(net.mySide), (net.mySide === 'han' ? '红方认输' : '黑方认输'));
      sendNet({ t: 'resign', by: net.mySide });
      return;
    }
    if (replaying || busy) return;
    var loser = aiOn ? otherSide(aiSide) : state.turn;   // 人机=人；双人=当前走棋方
    endGame(otherSide(loser), (loser === 'han' ? '红方认输' : '黑方认输'));
  }
  function resignClick() {
    if (!btnResignArmed) {
      btnResignArmed = true;
      var b = $('btn-resign'); if (b) b.textContent = '再点一次确认认输';
      setTimeout(function () { btnResignArmed = false; if (b) b.textContent = '认输'; }, 3000);
      return;
    }
    btnResignArmed = false;
    var b2 = $('btn-resign'); if (b2) b2.textContent = '认输';
    doResign();
  }
  function onNetResign(m) {
    if (!net || !net.connected) return;
    var by = m && m.by;
    if (!by || by === net.mySide) return;
    endGame(net.mySide, (net.mySide === 'han' ? '红方认输' : '黑方认输'));
  }

  // 和棋认定（议和）：一方提出，对方同意即和棋（开局 20 步之后解锁）
  function drawOfferClick() {
    if (!net || !net.connected || net.phase !== 'playing') return;
    if (!state || state.winner) return;
    if ((state.moveNo || 0) <= 20) { setNetStatus('开局前 20 步内不能求和'); return; }
    if (net.drawPending) { setNetStatus('已有议和申请待对方回复'); return; }
    net.drawPending = true;
    sendNet({ t: 'draw-offer', by: net.mySide });
    setNetStatus('已提出和棋认定，等待对方回复…');
  }
  function onDrawOffer(m) {
    if (!net || !net.connected) return;
    var by = m && m.by;
    if (!by || by === net.mySide) return;
    if (!state || state.winner) return;
    offerReqPending = { type: 'draw', by: by };
    if (!$('offer-modal')) return;
    $('offer-modal').hidden = false;
  }
  // 弹窗通用回复：悔棋 / 和棋认定
  function replyOffer(agree) {
    if (!net || !net.connected) return;
    if (offerReqPending && offerReqPending.type === 'undo') {
      var req = offerReqPending;
      offerReqPending = null;
      if ($('undo-modal')) $('undo-modal').hidden = true;
      sendNet({ t: 'undo-resp', agree: !!agree, by: net.mySide });
      if (agree) setNetStatus('你已同意对方悔棋，并获得一次免同意悔棋机会');
      else setNetStatus('你已拒绝对方悔棋');
      return;
    }
    if (offerReqPending && offerReqPending.type === 'draw') {
      offerReqPending = null;
      if ($('offer-modal')) $('offer-modal').hidden = true;
      if (agree) {
        sendNet({ t: 'draw-accept', by: net.mySide });
        endGame('draw', '和棋（议和认定）');
      } else {
        sendNet({ t: 'draw-refuse', by: net.mySide });
        setNetStatus('你已拒绝和棋认定');
      }
      return;
    }
  }
  function onDrawAccept(m) {
    if (!net || !net.connected) return;
    if (net.drawPending) net.drawPending = false;
    offerReqPending = null;
    if ($('offer-modal')) $('offer-modal').hidden = true;
    endGame('draw', '和棋（议和认定）');
  }
  function onDrawRefuse(m) {
    if (!net || !net.connected) return;
    if (net.drawPending) net.drawPending = false;
    setNetStatus('对方拒绝了和棋认定');
  }

  // 悔棋申请弹窗（并入通用弹窗回复流程）
  function onUndoReq(m) {
    if (!net || !net.connected) return;
    var by = m && m.by;
    if (!by || by === net.mySide) return;
    if (!$('undo-modal')) return;
    offerReqPending = { type: 'undo', by: by };
    $('undo-modal').hidden = false;
  }
  function replyUndo(agree) { replyOffer(agree); }
  // 我提交的申请收到回复
  function onUndoResp(m) {
    if (!net || !net.connected) return;
    if (m && m.by === net.mySide) return; // 不处理自己的回复
    if (net.undoPending) net.undoPending = false;
    if (m && m.agree) {
      doNetUndo(net.mySide, 'agreed');
      setNetStatus('对方同意了悔棋，已悔一步；对方获得免同意悔棋机会');
    } else {
      setNetStatus('对方拒绝了悔棋申请');
    }
  }
  function onUndoClick() {
    if (net && net.connected) requestUndo();
    else undo();
  }

  /* 房主：对方加入 → 进入大厅（执子/赛制在大厅里实时选择，连接后不再预选） */
  function onNetHello(m) {
    if (!net || !net.isHost || net.connected) return;
    netMarkConnected();
  }

  /* 加入者：收到房主的执子分配与赛制（实时刷新） */
  function onNetAssign(m) {
    if (!net || net.isHost) return;
    var hostSide = (m && m.hostSide === 'hun') ? 'hun' : 'han';
    net.mySide = hostSide === 'han' ? 'hun' : 'han';
    if (m && m.format) {
      net.format = m.format === 'bo3' ? 'bo3' : 'one';
      if (net.match) { net.match.format = net.format; net.match.target = net.format === 'bo3' ? 2 : 1; }
    }
    netMarkConnected();
  }

  function resetMatchScore() {
    if (!net) return;
    var fmt = (net.match && net.match.format) ? net.match.format : (net.format || 'one');
    net.match = freshMatch(fmt);
    updateNetMatchInfo();
  }

  function netCreate(mode) {
    if (netBusy || net) return;
    var Lib = netLib();
    if (!Lib) { setNetStatus('联机库未加载，请检查网络或刷新页面'); return; }
    var format = 'bo3';   // 赛制默认；连接建立后在大厅由房主选择
    netBusy = true;
    netUiReset();
    setNetStatus(mode === 'peer'
      ? '正在连接信令服务器…（若长时间无响应，多为公共中继不可达，请改用「局域网联机」）'
      : '正在创建中继房间…');
    var promise = mode === 'peer'
      ? Lib.createRoom({ mode: 'peer', server: peerServerValue() })
      : Lib.createRoom({ mode: 'relay', relayUrl: relayUrlValue() || undefined });
    promise.then(function (room) {
      netBusy = false;
      net = {
        mode: mode, room: room, isHost: !!room.isHost, code: room.code,
        mySide: null, selMy: null, selOp: null, sameSide: { han: null, hun: null },
        format: format, connected: false,
        match: freshMatch(format),
        undo: { han: { count: 0, free: 0 }, hun: { count: 0, free: 0 } },
      };
      room.on('message', onNetMessage);
      room.on('error', function (e) { if (net && net.room === room) setNetStatus('联机错误：' + ((e && e.message) || e)); });
      room.on('close', function () { if (net && net.room === room) netDisconnect('对方已断开连接'); });
      // 房主：等对方加入（hello）后进入大厅，执子/赛制在大厅里实时选择
      showNetCode(room.code, mode);
      setNetStatus('等待对方加入… 联机码：' + room.code);
      syncLocalControls();
    }).catch(function (e) {
      netBusy = false;
      setNetStatus('创建失败：' + ((e && e.message) || e));
    });
  }

  function netJoin(mode) {
    if (netBusy || net) return;
    var Lib = netLib();
    if (!Lib) { setNetStatus('联机库未加载，请检查网络或刷新页面'); return; }
    var inp = $(mode === 'peer' ? 'net-code-input-peer' : 'net-code-input-relay');
    var code = (inp.value || '').trim().toUpperCase();
    if (!code) { setNetStatus('请输入联机码'); return; }
    netBusy = true;
    netUiReset();
    setNetStatus(mode === 'peer' ? '正在连接对方…（最多等待 20 秒）' : '正在加入房间…');
    var promise = mode === 'peer'
      ? Lib.joinRoom({ mode: 'peer', code: code, server: peerServerValue() })
      : Lib.joinRoom({ mode: 'relay', relayUrl: relayUrlValue() || undefined, code: code });
    promise.then(function (room) {
      netBusy = false;
      net = {
        mode: mode, room: room, isHost: false, code: room.code,
        mySide: null, selMy: null, selOp: null, sameSide: { han: null, hun: null },
        format: 'bo3', connected: false,
        match: freshMatch('bo3'),
        undo: { han: { count: 0, free: 0 }, hun: { count: 0, free: 0 } },
      };
      room.on('message', onNetMessage);
      room.on('error', function (e) { if (net && net.room === room) setNetStatus('联机错误：' + ((e && e.message) || e)); });
      room.on('close', function () { if (net && net.room === room) netDisconnect('对方已断开连接'); });
      // 加入者：进入大厅（选择执子/赛制），通知房主已加入
      netMarkConnected();
      sendNet({ t: 'hello' });
      setNetStatus('已连接，在大厅选择执子与赛制');
      syncLocalControls();
    }).catch(function (e) {
      netBusy = false;
      setNetStatus('加入失败：' + ((e && e.message) || e));
    });
  }

  function netDisconnect(reason) {
    var r = net && net.room;
    net = null;
    netBusy = false;
    undoReqPending = null;
    offerReqPending = null;
    drawPending = false;
    btnResignArmed = false;
    stopPing();
    pingMs = null;
    lastPong = 0;
    if ($('undo-modal')) $('undo-modal').hidden = true;
    if ($('offer-modal')) $('offer-modal').hidden = true;
    if (r) { try { r.close(); } catch (e) {} }
    aiOn = false; aiSide = 'hun';
    $('net-modal').hidden = true;
    $('net-connected').hidden = true;
    $('net-code-wrap').hidden = true;
    if ($('net-lobby')) $('net-lobby').hidden = true;
    syncLocalControls();
    setNetStatus(reason || '已断开联机');
    render();
  }

  function syncLocalControls() {
    var on = canLocalControl();
    $('btn-new').disabled = !on;
    // 联机中可提交悔棋申请（免同意则直接悔，需同意则弹申请）
    $('btn-undo').disabled = false;
    $('btn-undo').textContent = (net && net.connected) ? '悔棋申请' : '悔棋';
    $('btn-net').disabled = false;   // 联机中也可打开联机界面（可随时断开）
    $('ai-toggle').disabled = !on;
    $('ai-side').disabled = !on;
    $('ai-side-wrap').style.display = aiOn ? '' : 'none';
    // 认输：开局 10 步之后解锁（本地/联机均可）；议和：联机对局中且开局 20 步之后
    var playing = !!state && !state.winner && !replaying && !busy && !(net && net.connected && net.phase !== 'playing');
    var moves = (state && state.moveNo) || 0;
    var bRes = $('btn-resign');
    if (bRes) {
      bRes.disabled = !(playing && moves > 10);
      bRes.textContent = (playing && moves > 10) ? '认输' : (playing ? '认输(10步后)' : '认输');
    }
    var canDraw = !!(net && net.connected && net.phase === 'playing' && playing);
    var bDr = $('btn-draw');
    if (bDr) {
      bDr.disabled = !(canDraw && moves > 20);
      bDr.textContent = (canDraw && moves > 20) ? '求和' : (canDraw ? '求和(20步后)' : '求和');
    }
  }

  // 多局赛制：同一把比赛相邻两局的执棋相反（先手互换）。
  // 仅在本局结束、比赛未结束时换边；整场比赛结束（重开新赛）不换。
  function swapNetSides() {
    if (!net || !net.mySide) return;
    net.mySide = otherSide(net.mySide);
    syncSelUI();
    syncLocalControls();
    render();
  }

  function restartGame() {
    if (net && net.connected) {
      var reset = !!net.match.over;
      if (reset) resetMatchScore();
      else if (net.match && net.match.games >= 1) swapNetSides();   // 下一局换边
      sendNet({ t: 'restart', reset: reset });
    }
    newGame();
  }

  /* ------------------------------ 联机悔棋 ------------------------------ */
  // 回退一步（与本地"双人悔一步"同款：pop 一个快照）
  function rollbackOneMove() {
    exitReplayUi();
    cancelAi();
    if (!history.length) return;
    var target = history.pop();
    if (target) {
      state = target;
      gameScored = false;
      selected = null;
      legalMap = {};
      stateSeq.length = Math.max(1, stateSeq.length - 1);
      moveSeq.length = Math.max(0, moveSeq.length - 1);
      if (plyList.length) plyList.pop();
      if ($('result-modal')) $('result-modal').hidden = true;
      rebuildRepCounts();
      render();
    }
  }

  // 悔棋判定（一步=一个着法，与对方是否落子无关）：
  //   - 有免同意机会 → 消耗机会直接悔（优先，避免与下方规则叠加出多次免同意）
  //   - 对方悔棋次数 > 自己 → 免同意
  //   - 否则 → 需对方同意
  function requestUndo() {
    if (!net || !net.connected) return;
    if (net.undoPending) { setNetStatus('已有悔棋申请待处理，请等待对方回复'); return; }
    if (!state || gameOver()) { setNetStatus('本局已结束，不能悔棋'); return; }
    if (!history.length) { setNetStatus('还没有可悔的棋'); return; }
    var me = net.mySide;
    var myU = net.undo[me], opU = net.undo[otherSide(me)];
    var mode;
    if (myU.free > 0) mode = 'token';                       // 有免同意机会：优先消耗
    else if (opU.count > myU.count) mode = 'count';         // 对方悔得比我多：免同意
    else mode = 'ask';                                      // 需要对方同意
    if (mode === 'ask') {
      net.undoPending = true;
      sendNet({ t: 'undo-req', by: me });
      setNetStatus('已向对方提交悔棋申请，等待回复…');
    } else {
      doNetUndo(me, mode);
      setNetStatus('已悔棋一步（免同意）');
    }
  }

  // 应用一次悔棋：更新计数 + 回退（本地发起与收到广播用同一逻辑，保证双方一致）
  function applyNetUndo(by, mode) {
    if (!net) return;
    net.undo[by].count++;
    if (mode === 'token' && net.undo[by].free > 0) net.undo[by].free--;
    if (mode === 'agreed') net.undo[otherSide(by)].free++;
    rollbackOneMove();
  }
  function doNetUndo(by, mode) {   // 发起方：本地应用 + 广播给双方一致
    applyNetUndo(by, mode);
    sendNet({ t: 'undo', by: by, mode: mode });
  }
  function onNetUndo(m) {          // 接收方：应用同样的悔棋
    if (!net || !net.connected || !m || !m.by) return;
    applyNetUndo(m.by, m.mode === 'agreed' ? 'agreed' : (m.mode === 'token' ? 'token' : 'count'));
  }

  function copyCode() {
    var text = $('net-code').textContent;
    function done() { setNetStatus('联机码已复制'); }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
        return;
      }
    } catch (e) {}
    fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) return done();
    } catch (e) {}
    setNetStatus('请手动复制联机码：' + text);
  }

  /* ------------------------------ 回放 ------------------------------ */
  function clearReplayTimer() {
    if (replayTimer) { clearTimeout(replayTimer); replayTimer = null; }
  }
  function showReplayBar() {
    var total = moveSeq.length;
    var bar = $('replay-bar');
    bar.hidden = false;
    $('rp-progress').max = total;
    $('rp-progress').value = replayIdx;
    $('rp-step').textContent = replayIdx + ' / ' + total;
    var r = Math.round(replaySpeed * 100) / 100;
    $('rp-speed').textContent = String(r) + ' 秒/步';
    $('rp-play').textContent = replayPlaying ? '⏸' : '▶';
  }
  function scheduleReplayStep() {
    clearReplayTimer();
    if (!replaying || !replayPlaying) return;
    if (replayIdx >= moveSeq.length) {
      replayPlaying = false;
      showReplayBar();
      render();
      return;
    }
    replayTimer = setTimeout(function () {
      replayTimer = null;
      if (!replaying) return;
      if (replayIdx < moveSeq.length) replayIdx++;
      showReplayBar();
      render();
      if (replayIdx >= moveSeq.length) {
        replayPlaying = false;
        showReplayBar();
      } else {
        scheduleReplayStep();
      }
    }, replaySpeed * 1000);
  }
  function startReplay() {
    if (!moveSeq.length) return;
    exitReplayUi();
    clearReplayTimer();
    replaying = true;
    replayIdx = 0;
    replayPlaying = true;
    $('result-modal').hidden = true;
    $('replay-bar').hidden = false;
    showReplayBar();
    render();
    scheduleReplayStep();
  }
  function exitReplayUi() {
    replaying = false;
    replayPlaying = false;
    clearReplayTimer();
    if ($('replay-bar')) $('replay-bar').hidden = true;
  }
  function exitReplay() {
    exitReplayUi();
    // 本局已结束（如和棋）时，退出回放后恢复结算弹窗，便于继续「下一局」
    if (state && state.winner && $('result-modal')) $('result-modal').hidden = false;
    render();
  }
  function toggleReplayPlay() {
    if (!replaying) return;
    if (replayPlaying) {
      replayPlaying = false;
      clearReplayTimer();
    } else {
      replayPlaying = true;
      if (replayIdx >= moveSeq.length) replayIdx = 0;
      scheduleReplayStep();
    }
    showReplayBar();
  }
  function setReplayIndex(i) {
    if (!replaying) return;
    replayIdx = Math.max(0, Math.min(moveSeq.length, i | 0));
    showReplayBar();
    render();
  }

  /* ------------------------------ 控制按钮 ------------------------------ */
  function bindControls() {
    $('btn-new').addEventListener('click', newGame);
    $('btn-undo').addEventListener('click', onUndoClick);
    $('btn-flip').addEventListener('click', function () {
      flipped = !flipped;
      render();
    });
    $('btn-replay').addEventListener('click', startReplay);
    $('btn-rules').addEventListener('click', function () { $('rules-modal').hidden = false; });
    $('rules-close').addEventListener('click', function () { $('rules-modal').hidden = true; });
    $('rules-modal').addEventListener('click', function (e) {
      if (e.target === $('rules-modal')) $('rules-modal').hidden = true;
    });
    $('ai-toggle').addEventListener('change', function () {
      aiOn = this.checked;
      $('ai-side-wrap').style.display = aiOn ? '' : 'none';
      newGame();
    });
    $('ai-side').addEventListener('change', function () {
      aiSide = this.checked ? 'han' : 'hun';
      newGame();
    });
    // 认输 / 议和（和棋认定）
    $('btn-resign').addEventListener('click', resignClick);
    $('btn-draw').addEventListener('click', drawOfferClick);
    // 大厅：加入者准备 / 房主开始
    $('net-ready').addEventListener('click', guestReady);
    $('net-start').addEventListener('click', hostStart);
    // 大厅：执子选择（改变即实时同步给对方）
    var selRadios = (typeof document.querySelectorAll === 'function')
      ? document.querySelectorAll('input[name="net-sel-side"]') : [];
    for (var si = 0; si < selRadios.length; si++) {
      (function (r) {
        r.addEventListener('change', function () { if (net) netSel(netSidePref()); });
      })(selRadios[si]);
    }
    var fmtSel = $('net-sel-format');
    if (fmtSel) fmtSel.addEventListener('change', function () { netFormatSel(this.value); });
    // 悔棋申请弹窗 + 和棋认定弹窗（通用回复）
    $('undo-yes').addEventListener('click', function () { replyUndo(true); });
    $('undo-no').addEventListener('click', function () { replyUndo(false); });
    $('undo-modal').addEventListener('click', function (e) {
      if (e.target === $('undo-modal')) replyUndo(false);
    });
    $('offer-yes').addEventListener('click', function () { replyOffer(true); });
    $('offer-no').addEventListener('click', function () { replyOffer(false); });
    $('offer-modal').addEventListener('click', function (e) {
      if (e.target === $('offer-modal')) replyOffer(false);
    });
    // 结算弹窗
    $('result-close').addEventListener('click', function () { $('result-modal').hidden = true; });
    $('result-restart').addEventListener('click', restartGame);
    $('result-replay').addEventListener('click', startReplay);
    $('result-modal').addEventListener('click', function (e) {
      if (e.target === $('result-modal')) $('result-modal').hidden = true;
    });
    // 联机
    $('btn-net').addEventListener('click', openNetModal);
    $('net-close').addEventListener('click', closeNetModal);
    $('net-modal').addEventListener('click', function (e) {
      if (e.target === $('net-modal')) closeNetModal();
    });
    $('tab-peer').addEventListener('click', function () { setNetTab('peer'); });
    $('tab-relay').addEventListener('click', function () { setNetTab('relay'); });
    $('net-create-peer').addEventListener('click', function () { netCreate('peer'); });
    $('net-join-peer').addEventListener('click', function () { netJoin('peer'); });
    $('net-create-relay').addEventListener('click', function () { netCreate('relay'); });
    $('net-join-relay').addEventListener('click', function () { netJoin('relay'); });
    $('net-copy').addEventListener('click', copyCode);
    $('net-disconnect').addEventListener('click', function () { netDisconnect('已断开联机'); });
    $('net-code-input-peer').addEventListener('keydown', function (e) { if (e.key === 'Enter') netJoin('peer'); });
    $('net-code-input-relay').addEventListener('keydown', function (e) { if (e.key === 'Enter') netJoin('relay'); });
    // 回放控制
    $('rp-play').addEventListener('click', toggleReplayPlay);
    $('rp-slower').addEventListener('click', function () {
      replaySpeed = Math.min(8, replaySpeed * 2);
      showReplayBar();
      if (replayPlaying) scheduleReplayStep();
    });
    $('rp-faster').addEventListener('click', function () {
      replaySpeed = Math.max(0.25, replaySpeed / 2);
      showReplayBar();
      if (replayPlaying) scheduleReplayStep();
    });
    $('rp-exit').addEventListener('click', exitReplay);
    $('rp-progress').addEventListener('input', function () {
      if (replaying) setReplayIndex(parseInt(this.value, 10) || 0);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'u' || e.key === 'U') { if (!net || !net.connected) { if (canLocalControl()) undo(); } else onUndoClick(); }
      if (e.key === 'n' || e.key === 'N') { if (canLocalControl()) newGame(); }
      if (e.key === 'f' || e.key === 'F') { flipped = !flipped; render(); }
    });
  }

  function init() {
    $('ai-side-wrap').style.display = 'none';
    var vEl = $('ver-label');
    if (vEl) vEl.textContent = 'v' + VERSION;
    bindControls();
    boardEl.addEventListener('click', function (e) {
      var cell = e.target.closest('.it');
      if (!cell) return;
      onCellTap(parseInt(cell.dataset.x, 10), parseInt(cell.dataset.y, 10));
    });
    fitBoard();
    newGame();
    syncLocalControls();
    setTimeout(fitBoard, 30);
    setTimeout(fitBoard, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 调试 / 冒烟测试钩子 */
  window.__xqDebug = {
    getState: function () { return state; },
    doMove: function (fx, fy, tx, ty) {
      if (busy || replaying || gameOver() || !state) return false;
      var moves = XG.allLegalMoves(state, state.turn);
      for (var i = 0; i < moves.length; i++) {
        var m = moves[i];
        if (m.fromX === fx && m.fromY === fy && m.toX === tx && m.toY === ty) {
          selected = null;
          legalMap = {};
          doMove(m);
          return true;
        }
      }
      return false;
    },
    newGame: newGame,
    undo: undo,
    flip: function () { flipped = !flipped; render(); },
    isAiOn: function () { return aiOn; },
    setAi: function (on, side) { aiOn = !!on; aiSide = side || (aiOn ? 'hun' : 'hun'); newGame(); },
    // 测试/调试：直接注入一个局面（不校验合法性）
    setState: function (st) {
      if (!st || !st.board) return false;
      exitReplayUi();
      cancelAi();
      history = []; plyList = []; stateSeq = []; moveSeq = [];
      repCounts = new Map();
      gameScored = false;
      selected = null; legalMap = {};
      $('result-modal').hidden = true;
      state = st;
      stateSeq.push(st);
      render();
      return true;
    },
    replayInfo: function () {
      return { len: moveSeq.length, idx: replayIdx, playing: replayPlaying, replaying: replaying, speed: replaySpeed };
    },
    isOnline: function () { return !!net; },
    netInfo: function () {
      if (!net) return null;
      return {
        mode: net.mode, isHost: net.isHost, mySide: net.mySide,
        selMy: net.selMy, selOp: net.selOp, format: net.format,
        connected: net.connected, code: net.code,
        phase: net.phase, guestReady: net.guestReady, drawPending: net.drawPending,
        match: net.match, undo: net.undo, undoPending: net.undoPending,
        pingMs: pingMs, lastPong: lastPong,
      };
    },
    // 测试/调试：模拟进入联机状态（不连接真实网络）
    netConnect: function (opts) {
      opts = opts || {};
      var mySide = opts.mySide || (opts.isHost !== false ? 'han' : 'hun');
      net = {
        mode: 'sim', room: opts.room || null, isHost: opts.isHost !== false,
        mySide: mySide, selMy: mySide, selOp: otherSide(mySide),
        sameSide: { han: null, hun: null },
        format: opts.format || 'one', connected: true, code: 'TEST01',
        match: freshMatch(opts.format || 'one'),
        undo: { han: { count: 0, free: 0 }, hun: { count: 0, free: 0 } },
      };
      netMarkConnected();
      startOnlineGame();   // 测试用：直接开局
      return true;
    },
    // 测试/调试：大厅里选择执子（立即同步给对方）
    netSel: function (side) { netSel(side); return true; },
    // 测试/调试：房主选择赛制（立即同步给加入方）
    netFormat: function (fmt) { netFormatSel(fmt); return true; },
    // 测试/调试：立即发一次 ping
    pingNow: function () {
      if (net && net.room) { try { net.room.send({ t: 'ping', ts: Date.now() }); } catch (e) {} }
      return true;
    },
    // 测试/调试：立即执行脱机检测（now 可传未来时间模拟超时）
    watchdogCheck: function (now) { return pingWatchdog(now); },
    // 测试/调试：直接设置某方的悔棋计数/免同意次数
    netSetUndo: function (side, count, free) {
      if (!net || !net.undo) return false;
      net.undo[side] = { count: count || 0, free: free || 0 };
      render();
      return true;
    },
    requestUndo: function () { requestUndo(); return true; },
    replyUndo: function (agree) { replyUndo(!!agree); return true; },
    resign: function () { doResign(); return true; },
    drawOffer: function () { drawOfferClick(); return true; },
    replyOffer: function (agree) { replyOffer(!!agree); return true; },
    netOff: function () { netDisconnect('测试断开'); },
    netFeed: function (m) { onNetMessage(m); },
    tap: function (x, y) { onCellTap(x | 0, y | 0); }
  };
})();
