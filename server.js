const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3636;

// ─── Game constants ──────────────────────────────────────────
const ARENA_W = 80;
const ARENA_H = 45;
const CELL = 30;
const SPEED = 1;
const MAX_HP = 10;
const BULLET_SPEED = 2.5;          // cells per tick — much faster than player
const SMALL_BULLET_SIZE = 0.4;    // cells
const BIG_BULLET_SIZE = 1.0;      // cells
const RESPAWN_TICKS = 60;         // 3 seconds at 20tps
const SHOOT_COOLDOWN = 8;         // ticks between shots (0.4s at 20tps)
const JOIN_DELAY_TICKS = 60;      // 3s wait before entering the arena

// ─── Charge beam constants ───────────────────────────────────
const CHARGE_TICKS = 10;          // 0.5s at 20tps to fully charge
const BEAM_COOLDOWN_TICKS = 100;  // 5s at 20tps
const CHARGE_SPEED_MULT = 0.2;    // 20% speed while charging
const BEAM_DAMAGE = 5;
const BEAM_WIDTH = 1.2;           // cells wide — the energy ray thickness
const BEAM_DISPLAY_TICKS = 8;     // how long the beam visual lingers (0.4s)

// Exactly 7 rainbow colors — each one can be held by a single player
const PALETTE = [
  { color: '#FF3B30', name: 'red' },
  { color: '#FF9500', name: 'orange' },
  { color: '#FFD60A', name: 'yellow' },
  { color: '#34C759', name: 'green' },
  { color: '#00C7FF', name: 'cyan' },
  { color: '#3F51FF', name: 'indigo' },
  { color: '#AF52DE', name: 'violet' },
];
const MAX_PLAYERS = PALETTE.length;

// ─── E skill constants (ticks at 20tps) ──────────────────────
// Cooldowns for shield/upgrade start after the effect ends.
const SKILL_COOLDOWN = { circle: 100, square: 40, rectangle: 200 };
const SHIELD_TICKS = 60;          // circle: 3s shield
const SHIELD_PADDING = 1.2;       // cells beyond the body radius
const SHIELD_HEAL = 2;
const SHIELD_BLAST_DAMAGE = 2;    // shield explodes when it expires or breaks
const SHIELD_BLAST_EXTRA = 1.5;   // blast reach beyond the shield ring (cells)
const BLAST_DISPLAY_TICKS = 8;
const DASH_DISTANCE_MULT = 3;     // square: 3× own size
const DASH_DAMAGE = 3;
const DASH_DISPLAY_TICKS = 6;
const UPGRADE_TICKS = 100;        // rectangle: 5s upgraded state
const TWIN_OFFSET = 0.7;          // cells between parallel bullets / beams
const STREAK_TEXT = ['+1 Object', 'Double Objects', 'Triple Objects', 'Quad Objects', 'Training 100%'];
const NAME_MAX_LEN = 20;

// Map terrain: two long black walls left and right. They block movement,
// dashes, bullets and lasers.
const WALLS = [
  { x: 14, y: 8, w: 2, h: 29 },
  { x: 64, y: 8, w: 2, h: 29 },
];

const SHAPES = {
  circle:    { w: 3, h: 3 },
  square:    { w: 3, h: 3 },
  rectangle: { w: 4, h: 2 },
};

const CLASS_LABELS = [
  'person', 'car', 'truck', 'bicycle', 'motorcycle',
  'bus', 'dog', 'cat', 'bird', 'horse',
  'backpack', 'umbrella', 'handbag', 'chair', 'bottle',
  'laptop', 'cell phone', 'book', 'clock', 'keyboard',
];

// ─── State ───────────────────────────────────────────────────
const players = new Map();   // id → player
const bullets = [];          // { x, y, vx, vy, ownerId, big, size, color }
const beams = [];            // { x, y, dx, dy, ownerId, color, life }
const dashes = [];           // { x1, y1, x2, y2, color, life } — square dash trails
const blasts = [];           // { x, y, r0, r, color, life } — shield explosions
let nextId = 1;
let nextBulletId = 1;

// True if a w×h box at (x,y) overlaps any wall (touching edges is allowed)
function hitsWall(x, y, w, h) {
  return WALLS.some(r => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
}

// Distance along (dx,dy) from (x0,y0) to where the ray enters a wall
// (Liang–Barsky, in units of the direction vector); Infinity if it never does
function rayToWall(x0, y0, dx, dy) {
  let best = Infinity;
  for (const r of WALLS) {
    const pv = [-dx, dx, -dy, dy];
    const qv = [x0 - r.x, r.x + r.w - x0, y0 - r.y, r.y + r.h - y0];
    let t0 = 0, t1 = Infinity, miss = false;
    for (let i = 0; i < 4 && !miss; i++) {
      if (pv[i] === 0) { if (qv[i] < 0) miss = true; continue; }
      const t = qv[i] / pv[i];
      if (pv[i] < 0) { if (t > t1) miss = true; else if (t > t0) t0 = t; }
      else { if (t < t0) miss = true; else if (t < t1) t1 = t; }
    }
    if (!miss && t0 < best) best = t0;
  }
  return best;
}

function spawnPosition(w = 4, h = 3) {
  for (;;) {
    const pos = {
      x: Math.floor(Math.random() * (ARENA_W - 6)) + 3,
      y: Math.floor(Math.random() * (ARENA_H - 6)) + 3,
    };
    if (!hitsWall(pos.x, pos.y, w, h)) return pos;
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function colorTaken(color) {
  for (const [, p] of players) if (p.color === color) return true;
  return false;
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX_LEN);
}

// Apply damage and handle death + kill credit. Returns true if the target died.
function damagePlayer(target, amount, attackerId) {
  if (target.dead || target.joinTicks > 0) return false;
  target.hp -= amount;
  if (target.hp > 0) return false;
  target.hp = 0;
  target.dead = true;
  target.respawnTimer = RESPAWN_TICKS;
  target.deaths++;
  target.charging = false;
  target.chargeTicks = 0;
  target.streak = 0;
  // Effects end silently on death; their cooldown still applies
  if (target.shieldTicks > 0 || target.upgradeTicks > 0) {
    target.shieldTicks = 0;
    target.upgradeTicks = 0;
    target.skillCooldown = SKILL_COOLDOWN[target.shape];
  }
  const attacker = players.get(attackerId);
  if (attacker) {
    attacker.kills++;
    attacker.streak++;
    const text = STREAK_TEXT[Math.min(attacker.streak, STREAK_TEXT.length) - 1];
    send(attacker.ws, { type: 'kill', streak: attacker.streak, text });
  }
  return true;
}

function bodyCenter(p) {
  return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
}

function shieldRadius(p) {
  return Math.max(p.w, p.h) / 2 + SHIELD_PADDING;
}

// Distance from point (px,py) to the nearest point of a player's box
function distToBox(px, py, p) {
  const cx = Math.max(p.x, Math.min(px, p.x + p.w));
  const cy = Math.max(p.y, Math.min(py, p.y + p.h));
  return Math.hypot(px - cx, py - cy);
}

// Shield ends (expired or broken by a laser): heal, explode, start the cooldown
function endShield(id, p) {
  p.shieldTicks = 0;
  p.hp = Math.min(MAX_HP, p.hp + SHIELD_HEAL);
  p.skillCooldown = SKILL_COOLDOWN.circle;

  const c = bodyCenter(p);
  const r0 = shieldRadius(p);
  const r = r0 + SHIELD_BLAST_EXTRA;
  for (const [pid, target] of players) {
    // Another active shield soaks the blast without breaking
    if (pid === id || target.dead || target.joinTicks > 0 || target.shieldTicks > 0) continue;
    if (distToBox(c.x, c.y, target) <= r) damagePlayer(target, SHIELD_BLAST_DAMAGE, id);
  }
  blasts.push({ ownerId: id, x: c.x, y: c.y, r0, r, color: p.color, life: BLAST_DISPLAY_TICKS });
}

// Distance from point (px,py) to segment (ax,ay)-(bx,by)
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

// Fire one laser from (cx,cy) along (ndx,ndy); pierces every player it touches
function fireBeam(ownerId, owner, cx, cy, ndx, ndy) {
  const hitIds = new Set();
  // The laser stops where it meets a wall
  const maxDist = Math.min(Math.sqrt(ARENA_W * ARENA_W + ARENA_H * ARENA_H), rayToWall(cx, cy, ndx, ndy));
  for (let t = 0; t < maxDist; t += 0.3) {
    const rx = cx + ndx * t;
    const ry = cy + ndy * t;
    if (rx < -1 || rx > ARENA_W + 1 || ry < -1 || ry > ARENA_H + 1) break;
    for (const [pid, target] of players) {
      if (pid === ownerId || target.dead || target.joinTicks > 0 || hitIds.has(pid)) continue;
      if (target.shieldTicks > 0) {
        // The shield absorbs the laser and breaks
        const c = bodyCenter(target);
        if (Math.hypot(rx - c.x, ry - c.y) <= shieldRadius(target) + BEAM_WIDTH / 2) {
          hitIds.add(pid);
          endShield(pid, target);
        }
        continue;
      }
      // Check if ray point is within BEAM_WIDTH/2 of target box
      if (distToBox(rx, ry, target) <= BEAM_WIDTH / 2) {
        hitIds.add(pid);
        damagePlayer(target, BEAM_DAMAGE, ownerId);
      }
    }
  }
  beams.push({
    x: cx, y: cy,
    dx: ndx, dy: ndy,
    len: maxDist,   // cut short by walls
    ownerId,
    color: owner.color,
    life: BEAM_DISPLAY_TICKS,
  });
}

function useSkill(id, p, tx, ty) {
  if (p.skillCooldown > 0 || p.shieldTicks > 0 || p.upgradeTicks > 0) return;

  if (p.shape === 'circle') {
    p.shieldTicks = SHIELD_TICKS;
  } else if (p.shape === 'rectangle') {
    p.upgradeTicks = UPGRADE_TICKS;
  } else if (p.shape === 'square') {
    const start = bodyCenter(p);
    const ddx = tx - start.x;
    const ddy = ty - start.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist < 0.1) return;
    const len = Math.max(p.w, p.h) * DASH_DISTANCE_MULT;
    // Step along the dash path and stop just before a wall
    const steps = Math.ceil(len / 0.1);
    for (let s = 1; s <= steps; s++) {
      const nx = Math.max(0, Math.min(ARENA_W - p.w, p.x + (ddx / dist) * (len / steps)));
      const ny = Math.max(0, Math.min(ARENA_H - p.h, p.y + (ddy / dist) * (len / steps)));
      if (hitsWall(nx, ny, p.w, p.h)) break;
      p.x = nx;
      p.y = ny;
    }
    const end = bodyCenter(p);
    p.skillCooldown = SKILL_COOLDOWN.square;

    let killed = false;
    for (const [pid, target] of players) {
      // A shielded circle is immune to the dash and the shield holds
      if (pid === id || target.dead || target.joinTicks > 0 || target.shieldTicks > 0) continue;
      const c = bodyCenter(target);
      const reach = (Math.max(p.w, p.h) + Math.max(target.w, target.h)) / 2;
      if (distToSegment(c.x, c.y, start.x, start.y, end.x, end.y) <= reach) {
        if (damagePlayer(target, DASH_DAMAGE, id)) killed = true;
      }
    }
    if (killed) p.skillCooldown = 0;   // a dash kill refreshes the dash
    dashes.push({ ownerId: id, x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: p.color, life: DASH_DISPLAY_TICKS });
  }
}

function gameState() {
  const pList = [];
  for (const [id, p] of players) {
    pList.push({
      id, x: p.x, y: p.y, color: p.color,
      label: p.label, conf: p.conf,
      name: p.name, shape: p.shape,
      w: p.w, h: p.h,
      shotCount: p.shotCount,
      hp: p.hp, maxHp: MAX_HP,
      dead: p.dead,
      kills: p.kills,
      deaths: p.deaths,
      charging: p.charging,
      chargeProgress: p.charging ? Math.min(1, p.chargeTicks / CHARGE_TICKS) : 0,
      skillCooldown: p.skillCooldown,
      skillCooldownMax: SKILL_COOLDOWN[p.shape],
      shieldTicks: p.shieldTicks, shieldMax: SHIELD_TICKS,
      shieldRadius: shieldRadius(p),
      upgradeTicks: p.upgradeTicks, upgradeMax: UPGRADE_TICKS,
      streak: p.streak,
      beamCooldown: p.beamCooldown,
      joining: p.joinTicks > 0,
      joinProgress: p.joinTicks > 0 ? 1 - p.joinTicks / JOIN_DELAY_TICKS : 1,
      joinTicks: p.joinTicks,
    });
  }
  const bList = bullets.map(b => ({
    id: b.id, x: b.x, y: b.y,
    size: b.size, big: b.big,
    color: b.color, ownerId: b.ownerId,
  }));
  const beamList = beams.map(b => ({
    x: b.x, y: b.y, dx: b.dx, dy: b.dy, len: b.len,
    color: b.color, ownerId: b.ownerId, life: b.life,
    maxLife: BEAM_DISPLAY_TICKS,
  }));
  return {
    type: 'state',
    players: pList,
    bullets: bList,
    beams: beamList,
    dashes: dashes.map(d => ({ ...d, maxLife: DASH_DISPLAY_TICKS })),
    blasts: blasts.map(b => ({ ...b, maxLife: BLAST_DISPLAY_TICKS })),
    palette: PALETTE,
    maxPlayers: MAX_PLAYERS,
    arena: { w: ARENA_W, h: ARENA_H, cell: CELL },
    walls: WALLS,
  };
}

// ─── HTTP ────────────────────────────────────────────────────
// Arena backgrounds the lobby can pick from (per client, purely visual)
const BACKGROUND_FILES = ['image.png', 'image-liveview.png'];

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  } else if (BACKGROUND_FILES.includes(req.url.slice(1))) {
    const filePath = path.join(__dirname, req.url.slice(1));
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── WebSocket ───────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // A connection sits in the lobby (not in `players`) until it sends a valid join
  const id = nextId++;

  send(ws, { ...gameState(), type: 'welcome', id });

  function handleJoin(msg) {
    if (players.has(id)) return;
    const shape = typeof msg.shape === 'string' && SHAPES[msg.shape] ? msg.shape : null;
    const entry = PALETTE.find(c => c.color === msg.color);
    const name = cleanName(msg.name);
    if (!shape) return send(ws, { type: 'join_error', message: 'Choose a shape.' });
    if (!entry) return send(ws, { type: 'join_error', message: 'Choose a color.' });
    if (!name) return send(ws, { type: 'join_error', message: `Enter a name (1-${NAME_MAX_LEN} chars).` });
    if (players.size >= MAX_PLAYERS) return send(ws, { type: 'join_error', message: 'Session full (7/7).' });
    if (colorTaken(entry.color)) return send(ws, { type: 'join_error', message: 'Color already taken.' });

    players.set(id, {
      x: -100, y: -100,
      color: entry.color,
      name, shape,
      joinTicks: JOIN_DELAY_TICKS,
      dx: 0, dy: 0,
      label: CLASS_LABELS[Math.floor(Math.random() * CLASS_LABELS.length)],
      conf: (0.75 + Math.random() * 0.24).toFixed(2),
      w: SHAPES[shape].w, h: SHAPES[shape].h,
      hp: MAX_HP,
      dead: false,
      respawnTimer: 0,
      shotCount: 0,   // tracks shots for big bullet every 3rd
      shootCooldown: 0, // ticks until can shoot again
      charging: false,  // currently holding space
      chargeTicks: 0,   // how many ticks charged so far
      beamCooldown: 0,  // ticks until the laser can be charged again
      chargeDirX: 0,    // aim direction when charging
      chargeDirY: 0,
      skillCooldown: 0, // ticks until E can be used again
      shieldTicks: 0,   // circle: active shield time left
      upgradeTicks: 0,  // rectangle: active upgrade time left
      streak: 0,        // kills since last death
      kills: 0,
      deaths: 0,
      ws,
    });
    broadcast(gameState());
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'join') return handleJoin(msg);

      const p = players.get(id);
      if (!p) return;

      if (msg.type === 'input_reset') {
        p.dx = 0;
        p.dy = 0;
        p.charging = false;
        p.chargeTicks = 0;
        return;
      }

      if (p.joinTicks > 0) return;

      // All aim coordinates must be finite numbers
      if ('tx' in msg && (!isNum(msg.tx) || !isNum(msg.ty))) return;

      if (msg.type === 'dir' && !p.dead) {
        p.dx = Math.sign(msg.dx ?? 0);
        p.dy = Math.sign(msg.dy ?? 0);
      }

      if (msg.type === 'shoot' && !p.dead) {
        if (p.shootCooldown > 0) return; // on cooldown
        if (p.charging) return; // can't normal-shoot while charging

        // bullet spawns from center of player box
        const { x: cx, y: cy } = bodyCenter(p);
        const dx = msg.tx - cx;
        const dy = msg.ty - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.1) return; // click on self
        p.shootCooldown = SHOOT_COOLDOWN;

        const ndx = dx / dist;
        const ndy = dy / dist;
        p.shotCount++;
        const isBig = (p.shotCount % 3 === 0);

        // Upgraded rectangle fires two parallel bullets
        const offsets = p.upgradeTicks > 0 ? [-TWIN_OFFSET, TWIN_OFFSET] : [0];
        for (const off of offsets) {
          bullets.push({
            id: nextBulletId++,
            x: cx - ndy * off, y: cy + ndx * off,
            vx: ndx * BULLET_SPEED, vy: ndy * BULLET_SPEED,
            ownerId: id,
            big: isBig,
            size: isBig ? BIG_BULLET_SIZE : SMALL_BULLET_SIZE,
            damage: isBig ? 3 : 1,
            color: p.color,
            life: 200,  // max ticks alive (~10s)
          });
        }
      }

      // ── E skill (shape-specific) ──
      if (msg.type === 'skill' && !p.dead) {
        useSkill(id, p, msg.tx, msg.ty);
      }

      // ── Charge beam (Space) ──
      if (msg.type === 'charge_start' && !p.dead && p.beamCooldown <= 0 && !p.charging) {
        p.charging = true;
        p.chargeTicks = 0;
        p.chargeDirX = msg.tx;
        p.chargeDirY = msg.ty;
      }
      if (msg.type === 'charge_aim' && p.charging) {
        p.chargeDirX = msg.tx;
        p.chargeDirY = msg.ty;
      }
      if (msg.type === 'charge_release' && !p.dead) {
        if (p.charging && p.chargeTicks >= CHARGE_TICKS) {
          const { x: cx, y: cy } = bodyCenter(p);
          const tx = isNum(msg.tx) ? msg.tx : p.chargeDirX;
          const ty = isNum(msg.ty) ? msg.ty : p.chargeDirY;
          const ddx = tx - cx;
          const ddy = ty - cy;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dist > 0.1) {
            const ndx = ddx / dist;
            const ndy = ddy / dist;
            // Upgraded rectangle fires two parallel lasers
            const offsets = p.upgradeTicks > 0 ? [-TWIN_OFFSET, TWIN_OFFSET] : [0];
            for (const off of offsets) {
              fireBeam(id, p, cx - ndy * off, cy + ndx * off, ndx, ndy);
            }
            p.beamCooldown = BEAM_COOLDOWN_TICKS;
          }
        }
        p.charging = false;
        p.chargeTicks = 0;
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    players.delete(id);
    // remove bullets and beams owned by this player
    for (let i = bullets.length - 1; i >= 0; i--) {
      if (bullets[i].ownerId === id) bullets.splice(i, 1);
    }
    for (let i = beams.length - 1; i >= 0; i--) {
      if (beams[i].ownerId === id) beams.splice(i, 1);
    }
    for (let i = dashes.length - 1; i >= 0; i--) {
      if (dashes[i].ownerId === id) dashes.splice(i, 1);
    }
    for (let i = blasts.length - 1; i >= 0; i--) {
      if (blasts[i].ownerId === id) blasts.splice(i, 1);
    }
    broadcast(gameState());
  });
});

// ─── Game loop (20 tps) ──────────────────────────────────────
setInterval(() => {
  // Move players & tick cooldowns
  for (const [id, p] of players) {
    if (p.joinTicks > 0) {
      p.joinTicks--;
      if (p.joinTicks === 0) {
        const pos = spawnPosition(p.w, p.h);
        p.x = pos.x;
        p.y = pos.y;
      }
    }
    if (p.shootCooldown > 0) p.shootCooldown--;
    if (p.beamCooldown > 0) p.beamCooldown--;
    if (p.skillCooldown > 0 && p.shieldTicks <= 0 && p.upgradeTicks <= 0) p.skillCooldown--;

    // Tick active E effects
    if (p.shieldTicks > 0 && !p.dead) {
      p.shieldTicks--;
      if (p.shieldTicks === 0) endShield(id, p);
    }
    if (p.upgradeTicks > 0 && !p.dead) {
      p.upgradeTicks--;
      if (p.upgradeTicks === 0) p.skillCooldown = SKILL_COOLDOWN.rectangle;
    }

    // Tick charge
    if (p.charging && !p.dead) {
      p.chargeTicks = Math.min(p.chargeTicks + 1, CHARGE_TICKS);
    }

    if (p.dead) {
      p.charging = false;
      p.chargeTicks = 0;
      p.respawnTimer--;
      if (p.respawnTimer <= 0) {
        // Respawn
        const pos = spawnPosition(p.w, p.h);
        p.x = pos.x;
        p.y = pos.y;
        p.hp = MAX_HP;
        p.dead = false;
        p.dx = 0;
        p.dy = 0;
      }
      continue;
    }
    if (p.dx !== 0 || p.dy !== 0) {
      const speedMult = p.charging ? CHARGE_SPEED_MULT : 1;
      const nx = p.x + p.dx * SPEED * speedMult;
      const ny = p.y + p.dy * SPEED * speedMult;
      if (nx >= 0 && nx + p.w <= ARENA_W && !hitsWall(nx, p.y, p.w, p.h)) p.x = nx;
      if (ny >= 0 && ny + p.h <= ARENA_H && !hitsWall(p.x, ny, p.w, p.h)) p.y = ny;
    }
  }

  // Move bullets & collision
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    // Swept check so a fast bullet cannot skip over a thin wall in one tick
    const wallHit = rayToWall(b.x, b.y, b.vx, b.vy) <= 1;
    b.x += b.vx;
    b.y += b.vy;
    b.life--;

    // Hit a wall, out of bounds or expired
    if (wallHit || b.x < -1 || b.x > ARENA_W + 1 || b.y < -1 || b.y > ARENA_H + 1 || b.life <= 0) {
      bullets.splice(i, 1);
      continue;
    }

    // Check collision with players
    let hit = false;
    for (const [pid, p] of players) {
      if (pid === b.ownerId || p.dead || p.joinTicks > 0) continue;
      // Shield blocks normal and big bullets
      if (p.shieldTicks > 0) {
        const c = bodyCenter(p);
        if (Math.hypot(b.x - c.x, b.y - c.y) <= shieldRadius(p)) {
          hit = true;
          break;
        }
        continue;
      }
      // AABB collision: bullet center vs player box
      if (b.x >= p.x && b.x <= p.x + p.w &&
          b.y >= p.y && b.y <= p.y + p.h) {
        hit = true;
        damagePlayer(p, b.damage, b.ownerId);
        break;
      }
    }
    if (hit) {
      bullets.splice(i, 1);
    }
  }

  // Tick beam display lifetime
  for (let i = beams.length - 1; i >= 0; i--) {
    beams[i].life--;
    if (beams[i].life <= 0) beams.splice(i, 1);
  }
  for (let i = dashes.length - 1; i >= 0; i--) {
    dashes[i].life--;
    if (dashes[i].life <= 0) dashes.splice(i, 1);
  }
  for (let i = blasts.length - 1; i >= 0; i--) {
    blasts[i].life--;
    if (blasts[i].life <= 0) blasts.splice(i, 1);
  }

  broadcast(gameState());
}, 50);

// ─── Start ───────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let lanIP = 'localhost';
  for (const addrs of Object.values(nets)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) { lanIP = a.address; break; }
    }
  }
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     🏷️  BBox Annotation Tool (totally legit)     ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Local:  http://localhost:${PORT}                  ║`);
  console.log(`║  LAN:    http://${lanIP}:${PORT}`.padEnd(51) + '║');
  console.log('║                                                  ║');
  console.log('║  Controls: WASD = move, left-click = shoot       ║');
  console.log('║            Hold Space = laser, E = shape skill   ║');
  console.log('║            Every 3rd shot = BIG bullet (3 dmg)   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
