/* ============================================================================
 * 突袭匈汉象棋 1.0 — 纯规则引擎（无 DOM 依赖）
 * 数据来源：结构.json
 *
 * 坐标：原点左下角，x 从左到右 0..10，y 从下到上 0..11。
 * 汉（红）居下先行，匈（黑）居上。河界位于 y=5 与 y=6 之间。
 *
 * 本引擎按以下"演示版"规则解释实现（详见 README 的"规则与约定"）：
 *  1. 传统棋子走法同中国象棋（車馬相士皇炮兵，含九宫/飞将/蹩马腿/塞象眼/炮架）。
 *  2. 檑/礌：八方向走任意空格（似皇后），但只能吃紧邻八格内"落单"的敌子：
 *     以檑为中心的 3×3 邻域内，该敌子的正邻（共享边，斜角不算）没有任何棋子。
 *  3. 突（走斜线）/ 袭（走直线）：可越过己方棋子、不可越过敌方棋子，不落点吃子。
 *  4. 夹击（突袭）机制：己-敌-己 成直线(直夹，供突)/斜线(斜夹，供袭)，敌子两侧
 *     紧邻一格（中间无空格）即形成夹击。完成夹击的当回合不能吃，下一回合起可"突袭"
 *     吃子：该棋子移动到被吃子的位置。被夹击的敌子仍可自由移动（无钳制机制）。
 *  5. 采用中国象棋式"将"：走出后己方王不得被攻击；被将军必须应将；将死获胜，
 *     困毙/无子可动为和棋；吃掉对方王同样立即获胜。三次重复局面由 UI 判和。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else if (root) { root.XG = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 11, H = 12;
  var SIDES = ['han', 'hun'];

  var TYPE_NAMES = { rook: '車', horse: '馬', elephant: '相', advisor: '士', king: '皇', cannon: '炮', pawn: '兵', ram: '檑', raider: '突', attacker: '袭' };
  var HUN_NAMES  = { rook: '車', horse: '馬', elephant: '都', advisor: '氏', king: '单', cannon: '砲', pawn: '卒', ram: '礌', raider: '突', attacker: '袭' };
  var VALUES = { king: 1000, rook: 9, cannon: 5, horse: 4, ram: 6, raider: 5, attacker: 5, elephant: 2, advisor: 2, pawn: 1 };

  var ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  var DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  var ALL8 = ORTH.concat(DIAG);

  function other(side) { return side === 'han' ? 'hun' : 'han'; }
  function inB(x, y) { return x >= 0 && x < W && y >= 0 && y < H; }
  function ownSide(side, y) { return side === 'han' ? y <= 5 : y >= 6; }
  function crossedRiver(side, y) { return !ownSide(side, y); }
  // 九宫（米字格）：汉（下）为 (4,1)-(6,3)，匈（上）对称为 (4,8)-(6,10)
  function palaceOf(side, x, y) {
    if (side === 'han') return x >= 4 && x <= 6 && y >= 1 && y <= 3;
    return x >= 4 && x <= 6 && y >= 8 && y <= 10;
  }
  function nameOf(piece) { return piece ? (piece.side === 'hun' ? HUN_NAMES : TYPE_NAMES)[piece.type] : ''; }

  /* ------------------------------ 初始布局 ------------------------------ */
  function initialPieces() {
    var list = [];
    function add(type, side, x, y) { list.push({ type: type, side: side, x: x, y: y }); }
    // 汉（下）—— 依结构.json：底行 突 車 _ 檔 袭 _ 袭 檔 _ 車 突，第二行 馬相士皇士相馬
    add('raider', 'han', 0, 0); add('rook', 'han', 1, 0); add('ram', 'han', 3, 0); add('attacker', 'han', 4, 0);
    add('attacker', 'han', 6, 0); add('ram', 'han', 7, 0); add('rook', 'han', 9, 0); add('raider', 'han', 10, 0);
    add('horse', 'han', 2, 1); add('elephant', 'han', 3, 1); add('advisor', 'han', 4, 1); add('king', 'han', 5, 1);
    add('advisor', 'han', 6, 1); add('elephant', 'han', 7, 1); add('horse', 'han', 8, 1);
    add('cannon', 'han', 0, 3); add('cannon', 'han', 10, 3);
    add('pawn', 'han', 1, 4); add('pawn', 'han', 3, 4); add('pawn', 'han', 5, 4); add('pawn', 'han', 7, 4); add('pawn', 'han', 9, 4);
    // 匈（上，镜像）
    add('raider', 'hun', 0, 11); add('rook', 'hun', 1, 11); add('ram', 'hun', 3, 11); add('attacker', 'hun', 4, 11);
    add('attacker', 'hun', 6, 11); add('ram', 'hun', 7, 11); add('rook', 'hun', 9, 11); add('raider', 'hun', 10, 11);
    add('horse', 'hun', 2, 10); add('elephant', 'hun', 3, 10); add('advisor', 'hun', 4, 10); add('king', 'hun', 5, 10);
    add('advisor', 'hun', 6, 10); add('elephant', 'hun', 7, 10); add('horse', 'hun', 8, 10);
    add('cannon', 'hun', 0, 8); add('cannon', 'hun', 10, 8);
    add('pawn', 'hun', 1, 7); add('pawn', 'hun', 3, 7); add('pawn', 'hun', 5, 7); add('pawn', 'hun', 7, 7); add('pawn', 'hun', 9, 7);
    return list;
  }

  function newState() {
    var board = [];
    for (var y = 0; y < H; y++) board.push(new Array(W).fill(null));
    var id = 0;
    var init = initialPieces();
    for (var i = 0; i < init.length; i++) {
      var p = init[i];
      board[p.y][p.x] = { type: p.type, side: p.side, id: ++id };
    }
    return {
      board: board,
      turn: 'han',
      moveNo: 1,
      clamps: { han: [], hun: [] },
      lastMove: null,
      captured: null,
      winner: null,
      result: null
    };
  }

  function cloneBoard(board) {
    return board.map(function (r) {
      return r.map(function (c) { return c ? { type: c.type, side: c.side, id: c.id } : null; });
    });
  }

  /* ---------------------------- 单子走法生成 ---------------------------- */
  function pieceMoves(board, piece, x, y) {
    var moves = [];
    var t = piece.type;
    var own = piece.side;
    var nx, ny, dx, dy, c, i;

    function addDest(tx, ty, opts) {
      c = board[ty][tx];
      if (c && c.side === own) return false;
      moves.push(Object.assign({ x: tx, y: ty, capture: c !== null, strike: false }, opts || {}));
      return true;
    }

    if (t === 'rook') {
      for (i = 0; i < ORTH.length; i++) {
        dx = ORTH[i][0]; dy = ORTH[i][1];
        nx = x + dx; ny = y + dy;
        while (inB(nx, ny)) {
          c = board[ny][nx];
          if (c === null) { moves.push({ x: nx, y: ny, capture: false, strike: false }); }
          else { if (c.side !== own) moves.push({ x: nx, y: ny, capture: true, strike: false }); break; }
          nx += dx; ny += dy;
        }
      }
    } else if (t === 'cannon') {
      for (i = 0; i < ORTH.length; i++) {
        dx = ORTH[i][0]; dy = ORTH[i][1];
        nx = x + dx; ny = y + dy;
        var screened = false;
        while (inB(nx, ny)) {
          c = board[ny][nx];
          if (c === null) {
            if (!screened) moves.push({ x: nx, y: ny, capture: false, strike: false });
          } else {
            if (!screened) { screened = true; }
            else { if (c.side !== own) moves.push({ x: nx, y: ny, capture: true, strike: false }); break; }
          }
          nx += dx; ny += dy;
        }
      }
    } else if (t === 'horse') {
      var steps = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
      for (i = 0; i < steps.length; i++) {
        var sx = steps[i][0], sy = steps[i][1];
        var lx = Math.abs(sx) === 2 ? x + Math.sign(sx) : x;
        var ly = Math.abs(sy) === 2 ? y + Math.sign(sy) : y;
        if (!inB(lx, ly) || board[ly][lx] !== null) continue;
        nx = x + sx; ny = y + sy;
        if (!inB(nx, ny)) continue;
        addDest(nx, ny);
      }
    } else if (t === 'elephant') {
      for (i = 0; i < DIAG.length; i++) {
        dx = DIAG[i][0]; dy = DIAG[i][1];
        var mx = x + dx, my = y + dy;
        if (!inB(mx, my) || board[my][mx] !== null) continue;
        nx = x + 2 * dx; ny = y + 2 * dy;
        if (!inB(nx, ny)) continue;
        if (!ownSide(own, ny)) continue; // 相不过河
        addDest(nx, ny);
      }
    } else if (t === 'advisor') {
      for (i = 0; i < DIAG.length; i++) {
        nx = x + DIAG[i][0]; ny = y + DIAG[i][1];
        if (!inB(nx, ny) || !palaceOf(own, nx, ny)) continue;
        addDest(nx, ny);
      }
    } else if (t === 'king') {
      for (i = 0; i < ORTH.length; i++) {
        nx = x + ORTH[i][0]; ny = y + ORTH[i][1];
        if (!inB(nx, ny) || !palaceOf(own, nx, ny)) continue;
        addDest(nx, ny);
      }
    } else if (t === 'pawn') {
      var fy = own === 'han' ? y + 1 : y - 1;
      if (inB(x, fy)) addDest(x, fy);
      if (crossedRiver(own, y)) {
        if (inB(x + 1, y)) addDest(x + 1, y);
        if (inB(x - 1, y)) addDest(x - 1, y);
      }
    } else if (t === 'ram') {
      // 走：八方向任意空格（不可越子）
      for (i = 0; i < ALL8.length; i++) {
        dx = ALL8[i][0]; dy = ALL8[i][1];
        nx = x + dx; ny = y + dy;
        while (inB(nx, ny) && board[ny][nx] === null) {
          moves.push({ x: nx, y: ny, capture: false, strike: false });
          nx += dx; ny += dy;
        }
      }
      // 吃：紧邻八格内"落单"的敌子
      for (i = 0; i < ALL8.length; i++) {
        nx = x + ALL8[i][0]; ny = y + ALL8[i][1];
        if (!inB(nx, ny)) continue;
        c = board[ny][nx];
        if (c && c.side !== own && isIsolated(board, nx, ny, x, y)) {
          moves.push({ x: nx, y: ny, capture: true, strike: false });
        }
      }
    } else if (t === 'raider' || t === 'attacker') {
      // 突走斜线 / 袭走直线；可越己方、不可越敌方；不落点吃子
      var dirs = t === 'raider' ? DIAG : ORTH;
      for (i = 0; i < dirs.length; i++) {
        dx = dirs[i][0]; dy = dirs[i][1];
        nx = x + dx; ny = y + dy;
        while (inB(nx, ny)) {
          c = board[ny][nx];
          if (c === null) { moves.push({ x: nx, y: ny, capture: false, strike: false }); }
          else if (c.side === own) { /* 越过己方，继续 */ }
          else { break; } // 敌方阻挡
          nx += dx; ny += dy;
        }
      }
    }
    return moves;
  }

  /* "落单"（结构.json·判落单）：以判定的檑 (rx,ry) 为中心，在其周围 8 格（3×3 邻域）内，
   * 被吃敌子 (ex,ey) 没有"正邻"（共享边/正交相邻，斜角相邻不算）棋子
   * （任意己/敌棋子，判定的檑本身除外）；8 格之外的棋子不影响判定。
   * 仅统计正邻：贴边/角落时窗口相应收缩（边缘5格、角落3格），斜角旁的棋子不构成阻碍。 */
  function isIsolated(board, ex, ey, rx, ry) {
    for (var i = 0; i < ORTH.length; i++) {
      var nx = ex + ORTH[i][0], ny = ey + ORTH[i][1];
      if (!inB(nx, ny)) continue;
      if (nx === rx && ny === ry) continue;
      // 只统计以檑为中心的 3×3 邻域内的正邻棋子；之外的棋子与判定无关
      if (Math.abs(nx - rx) > 1 || Math.abs(ny - ry) > 1) continue;
      if (board[ny][nx] !== null) return false;
    }
    return true;
  }

  /* ------------------------------ 夹击检测 ------------------------------ */
  // 从 (x,y) 沿 (dx,dy) 方向找己方"翼子"（maxDist 格内、紧邻优先；遇到空格不跨过即限制中间无空格）
  function findFlank(board, side, x, y, dx, dy, maxDist) {
    var nx = x + dx, ny = y + dy, dist = 1;
    while (inB(nx, ny) && dist <= maxDist) {
      var c = board[ny][nx];
      if (c !== null) {
        if (c.side === side) return { x: nx, y: ny, type: c.type, id: c.id };
        return null;
      }
      nx += dx; ny += dy; dist++;
    }
    return null;
  }

  // 计算某方围绕敌方棋子形成的所有夹击（含可"突袭"的翼子 strikers）
  function computeClamps(board, side) {
    var opp = other(side);
    var clamps = [];
    var x, y, i, sgn;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        var c = board[y][x];
        if (!c || c.side !== opp) continue;
        var axes = [[1, 0], [0, 1]];       // 直夹：同行/同列
        for (i = 0; i < axes.length; i++) {
          var flanks = [];
          for (sgn = 0; sgn < 2; sgn++) {
            var dir = sgn === 0 ? 1 : -1;
            flanks.push(findFlank(board, side, x, y, axes[i][0] * dir, axes[i][1] * dir, 1));
          }
          if (flanks[0] && flanks[1]) clamps.push({
            line: 'straight', enemyX: x, enemyY: y, flanks: flanks,
            strikers: flanks.filter(function (f) { return f.type === 'raider'; })
          });
        }
        var daxes = [[1, 1], [1, -1]];     // 斜夹：同对角线
        for (i = 0; i < daxes.length; i++) {
          var dfl = [];
          for (sgn = 0; sgn < 2; sgn++) {
            var d = sgn === 0 ? 1 : -1;
            dfl.push(findFlank(board, side, x, y, daxes[i][0] * d, daxes[i][1] * d, 1));
          }
          if (dfl[0] && dfl[1]) clamps.push({
            line: 'diag', enemyX: x, enemyY: y, flanks: dfl,
            strikers: dfl.filter(function (f) { return f.type === 'attacker'; })
          });
        }
      }
    }
    return clamps;
  }

  function clampKey(cl) {
    var fs = cl.flanks.slice().sort(function (a, b) { return (a.x - b.x) || (a.y - b.y); });
    return cl.line + ':' + cl.enemyX + ',' + cl.enemyY + ':' + fs[0].x + ',' + fs[0].y + ':' + fs[1].x + ',' + fs[1].y;
  }

  // 移动一步，重算双方夹击并保持夹击的完成回合（completionMove）
  function rawMove(state, fromX, fromY, toX, toY) {
    var board = cloneBoard(state.board);
    var p = board[fromY][fromX];
    var cap = board[toY][toX];
    board[toY][toX] = p;
    board[fromY][fromX] = null;
    var next = {
      board: board,
      turn: other(state.turn),
      moveNo: state.moveNo + 1,
      clamps: { han: [], hun: [] },
      lastMove: { from: [fromX, fromY], to: [toX, toY], piece: p, captured: cap, strike: false },
      captured: cap,
      winner: (cap && cap.type === 'king') ? p.side : null,
      result: null
    };
    if (p.type === 'raider' || p.type === 'attacker') {
      // 仅当此着确为"突袭"吃子时才标记 strike（普通走位不是突袭）
      var prevClamps = (state.clamps && state.clamps[p.side]) || [];
      var stk = strikeMoves(prevClamps, p, fromX, fromY, state.moveNo);
      next.lastMove.strike = stk.some(function (s) { return s.x === toX && s.y === toY; });
    }
    for (var s = 0; s < SIDES.length; s++) {
      var side = SIDES[s];
      var fresh = computeClamps(board, side);
      var prevList = (state.clamps && state.clamps[side]) || [];
      for (var k = 0; k < fresh.length; k++) {
        var cl = fresh[k];
        var prev = prevList.find(function (c) { return clampKey(c) === clampKey(cl); });
        cl.completionMove = (prev && prev.completionMove != null) ? prev.completionMove : next.moveNo;
      }
      next.clamps[side] = fresh;
    }
    return next;
  }

  // 突/袭 的"突袭"吃子目标（完成夹击的下一回合起可用）
  function strikeMoves(clamps, piece, x, y, moveNo) {
    clamps = clamps || [];
    var need = piece.type === 'raider' ? 'straight' : 'diag';
    var res = [];
    for (var i = 0; i < clamps.length; i++) {
      var cl = clamps[i];
      if (cl.line !== need) continue;
      if (cl.completionMove == null || cl.completionMove >= moveNo) continue;
      var st = null;
      var strikers = cl.strikers || [];
      for (var j = 0; j < strikers.length; j++) {
        if (strikers[j].x === x && strikers[j].y === y && strikers[j].id === piece.id) { st = strikers[j]; break; }
      }
      if (st) res.push({ x: cl.enemyX, y: cl.enemyY, capture: true, strike: true });
    }
    return res;
  }

  /* ------------------------------ 合法性 ------------------------------ */
  function findKing(board, side) {
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var p = board[y][x];
      if (p && p.type === 'king' && p.side === side) return { x: x, y: y };
    }
    return null;
  }

  // 两王同列且中间无子（对面笑/飞将），非法
  function kingsFacing(board, k1, k2) {
    if (!k1 || !k2 || k1.x !== k2.x) return false;
    for (var yy = Math.min(k1.y, k2.y) + 1; yy < Math.max(k1.y, k2.y); yy++) {
      if (board[yy][k1.x] !== null) return false;
    }
    return true;
  }

  // 找出两王位置（供 allLegalMoves 一次性计算，避免逐着法扫描）
  function findKings(board) {
    var k = { han: null, hun: null };
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var p = board[y][x];
      if (p && p.type === 'king') k[p.side] = { x: x, y: y };
    }
    return k;
  }

  // 着法是否"可能"造成飞将：两王不同列且非王动→不可能；两王同列时，
  // 仅当着法的起点或终点在该列（或移动的是王）才可能改变遮挡
  function moveCouldExposeKings(kings, fx, fy, tx, ty) {
    if (!kings.han || !kings.hun) return false;
    var kx = kings.han.x === kings.hun.x ? kings.han.x : null;
    if ((fx === kings.han.x && fy === kings.han.y) || (fx === kings.hun.x && fy === kings.hun.y)) return true;
    if (kx === null) return false;
    return fx === kx || tx === kx;
  }

  // 走 (fx,fy)→(tx,ty) 是否会导致两王同列无遮挡（对面笑/飞将）
  function wouldExposeKings(board, kings, fx, fy, tx, ty) {
    if (!kings.han || !kings.hun) return false;
    var target = board[ty][tx];
    if (target && target.type === 'king') return false; // 吃王即胜，飞将不适用
    var k1 = kings.han, k2 = kings.hun;
    if (fx === k1.x && fy === k1.y) k1 = { x: tx, y: ty };
    else if (fx === k2.x && fy === k2.y) k2 = { x: tx, y: ty };
    var b = cloneBoard(board);
    b[ty][tx] = b[fy][fx];
    b[fy][fx] = null;
    return kingsFacing(b, k1, k2);
  }

  // 局面 (x,y) 是否可被 side 的任何棋子吃掉（含突袭）
  function isAttacked(state, side, x, y) {
    var board = state.board;
    for (var yy = 0; yy < H; yy++) {
      for (var xx = 0; xx < W; xx++) {
        var p = board[yy][xx];
        if (!p || p.side !== side) continue;
        var dests = pieceMoves(board, p, xx, yy);
        for (var i = 0; i < dests.length; i++) {
          if (dests[i].capture && dests[i].x === x && dests[i].y === y) return true;
        }
        if (p.type === 'raider' || p.type === 'attacker') {
          var st = strikeMoves(state.clamps[side], p, xx, yy, state.moveNo);
          for (var j = 0; j < st.length; j++) if (st[j].x === x && st[j].y === y) return true;
        }
      }
    }
    return false;
  }

  function inCheck(state, side) {
    side = side || state.turn;
    var k = findKing(state.board, side);
    return !!k && isAttacked(state, other(side), k.x, k.y);
  }

  /* --------------------------- 整局合法着法 --------------------------- */
  function allLegalMoves(state, side) {
    side = side || state.turn;
    var opp = other(side);
    var board = state.board;
    var kings = findKings(board);
    var raw = [];
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var p = board[y][x];
        if (!p || p.side !== side) continue;
        var dests = pieceMoves(board, p, x, y);
        if (p.type === 'raider' || p.type === 'attacker') {
          dests = dests.concat(strikeMoves(state.clamps[side], p, x, y, state.moveNo));
        }
        for (var i = 0; i < dests.length; i++) {
          var d = dests[i];
          if (moveCouldExposeKings(kings, x, y, d.x, d.y) && wouldExposeKings(board, kings, x, y, d.x, d.y)) continue;
          raw.push({ fromX: x, fromY: y, toX: d.x, toY: d.y, capture: d.capture, strike: d.strike });
        }
      }
    }
    // 安全过滤：走完后己方王不得处于被攻击状态（吃王=立即取胜除外）
    var safe = [];
    for (var j = 0; j < raw.length; j++) {
      var m = raw[j];
      var ns = rawMove(state, m.fromX, m.fromY, m.toX, m.toY);
      if (ns.captured && ns.captured.type === 'king') { m.win = true; safe.push(m); continue; }
      var k = findKing(ns.board, side);
      if (k && isAttacked(ns, opp, k.x, k.y)) continue;
      safe.push(m);
    }
    return safe;
  }

  /* ------------------------------ 执行着法 ------------------------------ */
  function applyMove(state, fromX, fromY, toX, toY) {
    var legal = allLegalMoves(state, state.turn);
    var mv = null;
    for (var i = 0; i < legal.length; i++) {
      var m = legal[i];
      if (m.fromX === fromX && m.fromY === fromY && m.toX === toX && m.toY === toY) { mv = m; break; }
    }
    if (!mv) return null;
    var next = rawMove(state, fromX, fromY, toX, toY);
    next.lastMove.strike = mv.strike;
    if (next.captured && next.captured.type === 'king') {
      var loserSide = next.captured.side;
      next.winner = other(loserSide);
      next.result = loserSide === 'hun' ? '汉军获胜（吃掉匈军单王）' : '匈军获胜（吃掉汉军王）';
      return next;
    }
    var oppMoves = allLegalMoves(next, next.turn);
    if (oppMoves.length === 0) {
      var k = findKing(next.board, next.turn);
      var chk = k && isAttacked(next, other(next.turn), k.x, k.y);
      if (chk) {
        next.winner = other(next.turn);
        next.result = next.turn === 'hun' ? '汉军获胜（将死匈军）' : '匈军获胜（将死汉军）';
      } else {
        next.winner = 'draw';
        next.result = '和棋（困毙：无子可动）';
      }
    }
    return next;
  }

  /* ------------------------------ 简易 AI ------------------------------ */
  function aiChoose(state, side) {
    var moves = allLegalMoves(state, side);
    if (!moves.length) return null;
    var opp = other(side);
    // 能直接吃王则必胜
    for (var i = 0; i < moves.length; i++) {
      var cap = state.board[moves[i].toY][moves[i].toX];
      if (cap && cap.type === 'king') return moves[i];
    }
    var best = null, bestScore = -Infinity;
    for (var j = 0; j < moves.length; j++) {
      var m = moves[j];
      var score = Math.random() * 3;
      var mvPiece = state.board[m.fromY][m.fromX];
      var c2 = state.board[m.toY][m.toX];
      if (c2) score += VALUES[c2.type] * 12;
      var ns = rawMove(state, m.fromX, m.fromY, m.toX, m.toY);
      var k = findKing(ns.board, side);
      if (ns.winner !== side && k && isAttacked(ns, opp, k.x, k.y)) score -= 100000; // 王被吃则大忌
      if (isAttacked(ns, opp, m.toX, m.toY)) score -= VALUES[mvPiece.type] * 8;      // 落点会被吃
      if (mvPiece.type === 'pawn') score += (side === 'han' ? m.toY - m.fromY : m.fromY - m.toY) * 0.3;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  /* ------------------------------ 辅助 ------------------------------ */
  function positionKey(state) {
    var s = state.turn + '|';
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var p = state.board[y][x];
        s += p ? p.type[0] + p.side[0] + ';' : '.';
      }
    }
    return s;
  }

  function describeMove(state, move) {
    var p = state.board[move.fromY][move.fromX];
    var nm = nameOf(p);
    var side = p.side === 'han' ? '红' : '黑';
    var s = side + nm + ' (' + move.fromX + ',' + move.fromY + ')→(' + move.toX + ',' + move.toY + ')';
    if (move.capture) s += ' 吃';
    if (move.strike) s += ' ⚡突袭';
    return s;
  }

  return {
    VERSION: '1.00.006', W: W, H: H, SIDES: SIDES,
    TYPE_NAMES: TYPE_NAMES, HUN_NAMES: HUN_NAMES, VALUES: VALUES,
    other: other, nameOf: nameOf, inB: inB, ownSide: ownSide, crossedRiver: crossedRiver, palaceOf: palaceOf,
    newState: newState, cloneBoard: cloneBoard, initialPieces: initialPieces,
    pieceMoves: pieceMoves, computeClamps: computeClamps, rawMove: rawMove,
    allLegalMoves: allLegalMoves, applyMove: applyMove, isAttacked: isAttacked, inCheck: inCheck,
    findKing: findKing, aiChoose: aiChoose, positionKey: positionKey, describeMove: describeMove
  };
});
