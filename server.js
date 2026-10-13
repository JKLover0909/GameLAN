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
const SPAWN_PROTECT_TICKS = 10;   // 0.5s of invulnerability after (re)spawning

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

// Team mode: two sides of up to 3, warm colors vs cool colors
const TEAMS = [
  { id: 'warm', name: 'warm', colors: ['#FF3B30', '#FF9500', '#FFD60A'] },
  { id: 'cool', name: 'cool', colors: ['#34C759', '#00C7FF', '#3F51FF'] },
];
const TEAM_MAX = 3;
const TEAM_KILL_TARGET = 20;      // first side to this many kills wins the match
const HEARTBEAT_MS = 3000;        // drop connections that stop answering pings
const MODES = ['free', 'team'];

// ─── E skill constants (ticks at 20tps) ──────────────────────
// Cooldowns for shield/upgrade start after the effect ends.
const SKILL_COOLDOWN = { circle: 100, square: 40, rectangle: 200, triangle: 80 };
const SHIELD_TICKS = 60;          // circle: 3s shield
const SHIELD_SPEED_MULT = 1.3;    // circle moves 30% faster while shielded
const SHIELD_PADDING = 1.2;       // cells beyond the body radius
const SHIELD_HEAL = 2;
const SHIELD_BLAST_DAMAGE = 3;    // shield explodes when it expires or breaks
const SHIELD_BLAST_EXTRA = 1.5;   // blast reach beyond the shield ring (cells)
const BLAST_DISPLAY_TICKS = 12;
const DASH_DISTANCE_MULT = 3;     // square: 3× own size
const DASH_MIN_MOVE = 0.05;       // dashes shorter than this are refunded
const DASH_DAMAGE = 3;
const DASH_DISPLAY_TICKS = 9;
const UPGRADE_TICKS = 100;        // rectangle: 5s upgraded state
const UPGRADE_SPEED_MULT = 1.15;  // rectangle moves 15% faster while upgraded
const UPGRADE_SHOOT_COOLDOWN = 6; // and fires faster (0.3s instead of 0.4s)
const TWIN_OFFSET = 0.7;          // cells between parallel bullets / beams
const CRESCENT_SPEED = BULLET_SPEED * 1.3; // triangle: 30% faster than a bullet
const CRESCENT_DAMAGE = 3;
const CRESCENT_AREA_MULT = 2;     // crescent area = 2× the triangle's area
const CRESCENT_SUBSTEPS = 2;      // so it cannot skip over a thin body
const CRESCENT_LIFE = 200;        // max ticks alive
const SLOW_TICKS = 40;            // 2s slow on hit
const SLOW_SPEED_MULT = 0.7;      // slowed targets move 30% slower
// ─── Items: one drops at a random spot every 10s ─────────────
const ITEM_INTERVAL_TICKS = 200;  // 10s at 20tps
const ITEM_MAX = 3;               // uncollected items on the field at once
const ITEM_LIFE_TICKS = 200;      // 10s on the field, then it vanishes
const ITEM_SIZE = 1.8;            // cells, pickup box
const ITEM_KINDS = ['heal', 'speed', 'damage'];
const ITEM_HEAL = 2;
const SPEED_BUFF_TICKS = 120;     // 6s
const SPEED_BUFF_MULT = 1.3;      // +30% move speed
const DAMAGE_BUFF_TICKS = 120;    // 6s
const DAMAGE_BUFF_MULT = 1.5;     // +50% damage dealt (rounded up)
const PICKUP_DISPLAY_TICKS = 16;
let nextItemId = 1;

const STREAK_TEXT = ['+1 Object', 'Double Objects', 'Triple Objects', 'Quad Objects', 'Training 100%'];
const NAME_MAX_LEN = 20;

// Map terrain: two long black walls left and right. They block movement,
// dashes and bullets; lasers pierce them.
const WALLS = [
  { x: 14, y: 8, w: 2, h: 29 },
  { x: 64, y: 8, w: 2, h: 29 },
];

const SHAPES = {
  circle:    { w: 3, h: 3 },
  square:    { w: 3, h: 3 },
  rectangle: { w: 4, h: 2 },
  triangle:  { w: 3, h: 3 },
};

// Crescent ("moon") shape in its local frame, x = flight direction: inside the
// outer circle (radius 1 at the origin) and outside the inner circle (radius 1
// centred CRESCENT_BACK behind). Scaled so its area hits the target.
const CRESCENT_BACK = 0.6;
const CRESCENT = (() => {
  const inLune = (x, y, k) => x * x + y * y <= k * k && (x + CRESCENT_BACK * k) ** 2 + y * y > k * k;
  // Lune area of the unit shape: circle minus the overlap of two unit circles
  const h = CRESCENT_BACK / 2;
  const unitArea = Math.PI - (2 * Math.acos(h) - 2 * h * Math.sqrt(1 - h * h));
  const area = SHAPES.triangle.w * SHAPES.triangle.h / 2 * CRESCENT_AREA_MULT;
  const scale = Math.sqrt(area / unitArea);
  // Grid of sample points covering the shape, used for collisions
  const step = 0.25;
  const points = [];
  for (let x = -scale; x <= scale; x += step) {
    for (let y = -scale; y <= scale; y += step) {
      if (inLune(x, y, scale)) points.push([x, y]);
    }
  }
  return { r: scale, back: CRESCENT_BACK * scale, points };
})();

const CLASS_LABELS = [
  'person', 'car', 'truck', 'bicycle', 'motorcycle',
  'bus', 'dog', 'cat', 'bird', 'horse',
  'backpack', 'umbrella', 'handbag', 'chair', 'bottle',
  'laptop', 'cell phone', 'book', 'clock', 'keyboard',
];

// ─── State ───────────────────────────────────────────────────
// Each mode runs in its own room with its own players and projectiles
function makeRoom(mode) {
  return {
    mode,
    sockets: new Set(),    // connections viewing this room
    players: new Map(),    // id → player
    bullets: [],           // { x, y, vx, vy, ownerId, team, big, size, color }
    beams: [],             // { x, y, dx, dy, ownerId, color, life }
    dashes: [],            // { x1, y1, x2, y2, color, life } — square dash trails
    blasts: [],            // { x, y, r0, r, color, life } — shield explosions
    crescents: [],         // { x, y, dx, dy, ownerId, team, color, life } — triangle E
    items: [],             // { id, kind, x, y, age } — pickups on the field
    pickups: [],           // { kind, x, y, color, life } — pickup flashes
    itemTimer: ITEM_INTERVAL_TICKS,
    score: { warm: 0, cool: 0 }, // team mode: kills per side this match
  };
}
const rooms = { free: makeRoom('free'), team: makeRoom('team') };
const modeSockets = new Set(); // connections still on the mode-select screen
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

// Teams spawn behind their own wall (warm left, cool right); free mode anywhere
function spawnPosition(w = 4, h = 3, team = null) {
  const [minX, maxX] = team === 'warm' ? [1, WALLS[0].x - w - 1]
                     : team === 'cool' ? [WALLS[1].x + WALLS[1].w + 1, ARENA_W - w - 1]
                     : [3, ARENA_W - 4];
  for (;;) {
    const pos = {
      x: minX + Math.floor(Math.random() * (maxX - minX + 1)),
      y: Math.floor(Math.random() * (ARENA_H - 6)) + 3,
    };
    if (!hitsWall(pos.x, pos.y, w, h)) return pos;
  }
}

function broadcast(room, data) {
  const msg = JSON.stringify(data);
  for (const c of room.sockets) {
    if (c.readyState === 1) c.send(msg);
  }
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function colorTaken(room, color) {
  for (const [, p] of room.players) if (p.color === color) return true;
  return false;
}

// Teammates never hurt each other; in free mode nobody has a team
function allies(teamA, teamB) {
  return teamA != null && teamA === teamB;
}

function teamCount(room, teamId) {
  let n = 0;
  for (const [, p] of room.players) if (p.team === teamId) n++;
  return n;
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX_LEN);
}

// Apply damage and handle death + kill credit. Returns true if the target died.
function damagePlayer(room, target, amount, attackerId) {
  if (target.dead || target.joinTicks > 0 || target.spawnTicks > 0) return false;
  const source = room.players.get(attackerId);
  if (source && source.damageTicks > 0) amount = Math.ceil(amount * DAMAGE_BUFF_MULT);
  target.hp -= amount;
  if (target.hp > 0) return false;
  target.hp = 0;
  target.dead = true;
  target.respawnTimer = RESPAWN_TICKS;
  target.deaths++;
  target.charging = false;
  target.chargeTicks = 0;
  target.streak = 0;
  target.slowTicks = 0;
  target.speedTicks = 0;
  target.damageTicks = 0;
  // Effects end silently on death; their cooldown still applies
  if (target.shieldTicks > 0 || target.upgradeTicks > 0) {
    target.shieldTicks = 0;
    target.upgradeTicks = 0;
    target.skillCooldown = SKILL_COOLDOWN[target.shape];
  }
  const attacker = room.players.get(attackerId);
  if (attacker) {
    if (attacker.team) room.score[attacker.team]++;
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
function endShield(room, id, p) {
  p.shieldTicks = 0;
  p.hp = Math.min(MAX_HP, p.hp + SHIELD_HEAL);
  p.skillCooldown = SKILL_COOLDOWN.circle;

  const c = bodyCenter(p);
  const r0 = shieldRadius(p);
  const r = r0 + SHIELD_BLAST_EXTRA;
  for (const [pid, target] of room.players) {
    // Another active shield soaks the blast without breaking
    if (pid === id || target.dead || target.joinTicks > 0 || target.shieldTicks > 0) continue;
    if (allies(p.team, target.team)) continue;
    if (distToBox(c.x, c.y, target) <= r) damagePlayer(room, target, SHIELD_BLAST_DAMAGE, id);
  }
  room.blasts.push({ ownerId: id, x: c.x, y: c.y, r0, r, color: p.color, life: BLAST_DISPLAY_TICKS });
}

// Distance from point (px,py) to segment (ax,ay)-(bx,by)
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

// Fire one laser from (cx,cy) along (ndx,ndy); pierces every player it touches
function fireBeam(room, ownerId, owner, cx, cy, ndx, ndy) {
  const hitIds = new Set();
  // The laser pierces walls (only bullets are blocked by them)
  const maxDist = Math.sqrt(ARENA_W * ARENA_W + ARENA_H * ARENA_H);
  for (let t = 0; t < maxDist; t += 0.3) {
    const rx = cx + ndx * t;
    const ry = cy + ndy * t;
    if (rx < -1 || rx > ARENA_W + 1 || ry < -1 || ry > ARENA_H + 1) break;
    for (const [pid, target] of room.players) {
      if (pid === ownerId || target.dead || target.joinTicks > 0 || hitIds.has(pid)) continue;
      if (allies(owner.team, target.team)) continue;
      if (target.shieldTicks > 0) {
        // The shield absorbs the laser and breaks
        const c = bodyCenter(target);
        if (Math.hypot(rx - c.x, ry - c.y) <= shieldRadius(target) + BEAM_WIDTH / 2) {
          hitIds.add(pid);
          endShield(room, pid, target);
        }
        continue;
      }
      // Check if ray point is within BEAM_WIDTH/2 of target box
      if (distToBox(rx, ry, target) <= BEAM_WIDTH / 2) {
        hitIds.add(pid);
        damagePlayer(room, target, BEAM_DAMAGE, ownerId);
      }
    }
  }
  room.beams.push({
    x: cx, y: cy,
    dx: ndx, dy: ndy,
    ownerId,
    color: owner.color,
    life: BEAM_DISPLAY_TICKS,
  });
}

function useSkill(room, id, p, tx, ty) {
  if (p.skillCooldown > 0 || p.shieldTicks > 0 || p.upgradeTicks > 0) return;

  if (p.shape === 'circle') {
    p.shieldTicks = SHIELD_TICKS;
  } else if (p.shape === 'rectangle') {
    p.upgradeTicks = UPGRADE_TICKS;
  } else if (p.shape === 'triangle') {
    const c = bodyCenter(p);
    const ddx = tx - c.x;
    const ddy = ty - c.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist < 0.1) return;
    p.skillCooldown = SKILL_COOLDOWN.triangle;
    room.crescents.push({ x: c.x, y: c.y, dx: ddx / dist, dy: ddy / dist, ownerId: id, team: p.team, color: p.color, life: CRESCENT_LIFE, hitIds: new Set() });
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
    // Dashing straight into a wall moves nothing: keep the skill ready
    if (Math.hypot(end.x - start.x, end.y - start.y) < DASH_MIN_MOVE) return;
    p.skillCooldown = SKILL_COOLDOWN.square;

    let killed = false;
    for (const [pid, target] of room.players) {
      // A shielded circle is immune to the dash and the shield holds
      if (pid === id || target.dead || target.joinTicks > 0 || target.shieldTicks > 0) continue;
      if (allies(p.team, target.team)) continue;
      const c = bodyCenter(target);
      const reach = (Math.max(p.w, p.h) + Math.max(target.w, target.h)) / 2;
      if (distToSegment(c.x, c.y, start.x, start.y, end.x, end.y) <= reach) {
        if (damagePlayer(room, target, DASH_DAMAGE, id)) killed = true;
      }
    }
    if (killed) p.skillCooldown = 0;   // a dash kill refreshes the dash
    room.dashes.push({ ownerId: id, x1: start.x, y1: start.y, x2: end.x, y2: end.y, size: p.w, color: p.color, life: DASH_DISPLAY_TICKS });
  }
}

// Crescent sample points in world space at its current position
function crescentPoints(c) {
  return CRESCENT.points.map(([lx, ly]) => [c.x + c.dx * lx - c.dy * ly, c.y + c.dy * lx + c.dx * ly]);
}

// Advance one crescent by a tick: 'fly', or 'gone' once it leaves the arena
function stepCrescent(room, c) {
  for (let s = 0; s < CRESCENT_SUBSTEPS; s++) {
    c.x += c.dx * CRESCENT_SPEED / CRESCENT_SUBSTEPS;
    c.y += c.dy * CRESCENT_SPEED / CRESCENT_SUBSTEPS;
    const m = CRESCENT.r + 1;
    if (c.x < -m || c.x > ARENA_W + m || c.y < -m || c.y > ARENA_H + m) return 'gone';
    // Pierces walls and bodies; each target is hit at most once
    const pts = crescentPoints(c);
    for (const [pid, target] of room.players) {
      if (pid === c.ownerId || target.dead || target.joinTicks > 0 || c.hitIds.has(pid)) continue;
      if (allies(c.team, target.team)) continue; // passes through teammates
      if (target.shieldTicks > 0) {
        // Only a laser breaks a shield: it stops the crescent and holds
        const tc = bodyCenter(target);
        const sr = shieldRadius(target);
        if (pts.some(([x, y]) => Math.hypot(x - tc.x, y - tc.y) <= sr)) return 'gone';
        continue;
      }
      if (pts.some(([x, y]) => x >= target.x && x <= target.x + target.w && y >= target.y && y <= target.y + target.h)) {
        c.hitIds.add(pid);
        if (target.spawnTicks > 0) continue; // spawn protection: no damage, no slow
        if (!damagePlayer(room, target, CRESCENT_DAMAGE, c.ownerId)) target.slowTicks = SLOW_TICKS;
      }
    }
  }
  return 'fly';
}

function gameState(room) {
  const pList = [];
  for (const [id, p] of room.players) {
    pList.push({
      id, x: p.x, y: p.y, color: p.color,
      label: p.label, conf: p.conf,
      name: p.name, shape: p.shape, team: p.team,
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
      slowed: p.slowTicks > 0,
      speedTicks: p.speedTicks, speedMax: SPEED_BUFF_TICKS,
      damageTicks: p.damageTicks, damageMax: DAMAGE_BUFF_TICKS,
      streak: p.streak,
      beamCooldown: p.beamCooldown,
      joining: p.joinTicks > 0,
      joinProgress: p.joinTicks > 0 ? 1 - p.joinTicks / JOIN_DELAY_TICKS : 1,
      joinTicks: p.joinTicks,
      spawnTicks: p.spawnTicks, spawnMax: SPAWN_PROTECT_TICKS,
    });
  }
  const bList = room.bullets.map(b => ({
    id: b.id, x: b.x, y: b.y,
    size: b.size, big: b.big, twin: b.twin,
    vx: b.vx, vy: b.vy,
    color: b.color, ownerId: b.ownerId,
  }));
  const beamList = room.beams.map(b => ({
    x: b.x, y: b.y, dx: b.dx, dy: b.dy,
    color: b.color, ownerId: b.ownerId, life: b.life,
    maxLife: BEAM_DISPLAY_TICKS,
  }));
  return {
    type: 'state',
    players: pList,
    bullets: bList,
    beams: beamList,
    dashes: room.dashes.map(d => ({ ...d, maxLife: DASH_DISPLAY_TICKS })),
    blasts: room.blasts.map(b => ({ ...b, maxLife: BLAST_DISPLAY_TICKS })),
    crescents: room.crescents.map(c => ({
      x: c.x, y: c.y, dx: c.dx, dy: c.dy, color: c.color, ownerId: c.ownerId,
      r: CRESCENT.r, back: CRESCENT.back,
    })),
    items: room.items.map(it => ({ id: it.id, kind: it.kind, x: it.x, y: it.y, size: ITEM_SIZE, age: it.age, life: ITEM_LIFE_TICKS })),
    pickups: room.pickups.map(pk => ({ ...pk, maxLife: PICKUP_DISPLAY_TICKS })),
    mode: room.mode,
    palette: PALETTE,
    maxPlayers: room.mode === 'team' ? TEAMS.length * TEAM_MAX : MAX_PLAYERS,
    teams: room.mode === 'team' ? TEAMS : null,
    teamMax: TEAM_MAX,
    score: room.mode === 'team' ? room.score : null,
    scoreTarget: TEAM_KILL_TARGET,
    arena: { w: ARENA_W, h: ARENA_H, cell: CELL },
    walls: WALLS,
  };
}

// ─── HTTP ────────────────────────────────────────────────────
// Arena backgrounds the lobby can pick from (per client, purely visual)
const BACKGROUND_FILES = ['image.png', 'image-liveview.png'];

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
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

// Player counts shown on the mode-select screen
function modeSummary() {
  return {
    type: 'modes',
    free: { players: rooms.free.players.size, max: MAX_PLAYERS },
    team: {
      max: TEAM_MAX,
      sides: TEAMS.map(t => ({ id: t.id, players: teamCount(rooms.team, t.id) })),
    },
  };
}

wss.on('connection', (ws) => {
  // A connection starts on the mode-select screen, then views one room's
  // lobby (not in `players`) until it sends a valid join
  const id = nextId++;
  let room = null;

  modeSockets.add(ws);
  send(ws, { ...modeSummary(), id });

  // Heartbeat: a closed tab or dropped laptop that never sends a close frame
  // stops answering pings and is terminated by the interval below
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Match over: the room is torn down and every viewer returns to mode select
  ws.kickToModes = () => {
    room = null;
    modeSockets.add(ws);
    send(ws, { ...modeSummary(), id });
  };

  function enterMode(mode) {
    if (room || !MODES.includes(mode)) return;
    modeSockets.delete(ws);
    room = rooms[mode];
    room.sockets.add(ws);
    send(ws, { ...gameState(room), type: 'welcome', id });
  }

  function leaveRoom() {
    if (!room) return;
    const r = room;
    r.sockets.delete(ws);
    r.players.delete(id);
    // remove projectiles and effects owned by this player
    for (const key of ['bullets', 'beams', 'dashes', 'blasts', 'crescents']) {
      const list = r[key];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].ownerId === id) list.splice(i, 1);
      }
    }
    room = null;
    // Everyone left: the next group starts a fresh match
    if (r.players.size === 0) {
      r.score = { warm: 0, cool: 0 };
      r.items = [];
      r.itemTimer = ITEM_INTERVAL_TICKS;
    }
    broadcast(r, gameState(r));
  }

  function handleJoin(msg) {
    if (room.players.has(id)) return;
    const shape = typeof msg.shape === 'string' && SHAPES[msg.shape] ? msg.shape : null;
    const entry = PALETTE.find(c => c.color === msg.color);
    const name = cleanName(msg.name);
    const team = room.mode === 'team' ? TEAMS.find(t => t.id === msg.team) : null;
    if (!shape) return send(ws, { type: 'join_error', message: 'Choose a shape.' });
    if (room.mode === 'team' && !team) return send(ws, { type: 'join_error', message: 'Choose a side.' });
    if (!entry || (team && !team.colors.includes(entry.color))) return send(ws, { type: 'join_error', message: 'Choose a color.' });
    if (!name) return send(ws, { type: 'join_error', message: `Enter a name (1-${NAME_MAX_LEN} chars).` });
    if (team && teamCount(room, team.id) >= TEAM_MAX) return send(ws, { type: 'join_error', message: `Side full (${TEAM_MAX}/${TEAM_MAX}).` });
    if (!team && room.players.size >= MAX_PLAYERS) return send(ws, { type: 'join_error', message: 'Session full (7/7).' });
    if (colorTaken(room, entry.color)) return send(ws, { type: 'join_error', message: 'Color already taken.' });

    room.players.set(id, {
      x: -100, y: -100,
      color: entry.color,
      name, shape,
      team: team ? team.id : null,
      joinTicks: JOIN_DELAY_TICKS,
      spawnTicks: 0,    // spawn protection time left
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
      slowTicks: 0,     // hit by a crescent: moves slower
      speedTicks: 0,    // speed item time left
      damageTicks: 0,   // damage item time left
      streak: 0,        // kills since last death
      kills: 0,
      deaths: 0,
      ws,
    });
    broadcast(room, gameState(room));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'mode') return enterMode(msg.mode);
      // Tab closing: leave immediately instead of waiting for the socket to drop
      if (msg.type === 'leave') {
        modeSockets.delete(ws);
        leaveRoom();
        return ws.close();
      }
      if (!room) return;
      // Back to the mode-select screen (only from the lobby, not mid-game)
      if (msg.type === 'leave_mode') {
        if (room.players.has(id)) return;
        leaveRoom();
        modeSockets.add(ws);
        return send(ws, { ...modeSummary(), id });
      }
      if (msg.type === 'join') return handleJoin(msg);

      const p = room.players.get(id);
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
        p.shootCooldown = p.upgradeTicks > 0 ? UPGRADE_SHOOT_COOLDOWN : SHOOT_COOLDOWN;

        const ndx = dx / dist;
        const ndy = dy / dist;
        p.shotCount++;
        const isBig = (p.shotCount % 3 === 0);

        // Upgraded rectangle fires two parallel bullets
        const offsets = p.upgradeTicks > 0 ? [-TWIN_OFFSET, TWIN_OFFSET] : [0];
        for (const off of offsets) {
          room.bullets.push({
            id: nextBulletId++,
            x: cx - ndy * off, y: cy + ndx * off,
            vx: ndx * BULLET_SPEED, vy: ndy * BULLET_SPEED,
            ownerId: id,
            team: p.team,
            big: isBig,
            twin: p.upgradeTicks > 0,
            size: isBig ? BIG_BULLET_SIZE : SMALL_BULLET_SIZE,
            damage: isBig ? 3 : 1,
            color: p.color,
            life: 200,  // max ticks alive (~10s)
          });
        }
      }

      // ── E skill (shape-specific) ──
      if (msg.type === 'skill' && !p.dead) {
        useSkill(room, id, p, msg.tx, msg.ty);
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
              fireBeam(room, id, p, cx - ndy * off, cy + ndx * off, ndx, ndy);
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
    modeSockets.delete(ws);
    leaveRoom();
  });
});

const heartbeat = setInterval(() => {
  for (const c of wss.clients) {
    if (!c.isAlive) { c.terminate(); continue; } // fires 'close' → leaveRoom
    c.isAlive = false;
    c.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// Drop a random item every ITEM_INTERVAL_TICKS while anyone is playing;
// a living player touching one picks it up
function tickItems(room) {
  if (room.players.size > 0 && --room.itemTimer <= 0) {
    room.itemTimer = ITEM_INTERVAL_TICKS;
    if (room.items.length < ITEM_MAX) {
      let pos;
      do {
        pos = { x: 3 + Math.random() * (ARENA_W - 6 - ITEM_SIZE), y: 3 + Math.random() * (ARENA_H - 6 - ITEM_SIZE) };
      } while (hitsWall(pos.x - 0.5, pos.y - 0.5, ITEM_SIZE + 1, ITEM_SIZE + 1));
      const kind = ITEM_KINDS[Math.floor(Math.random() * ITEM_KINDS.length)];
      room.items.push({ id: nextItemId++, kind, x: pos.x, y: pos.y, age: 0 });
    }
  }
  for (let i = room.items.length - 1; i >= 0; i--) {
    const it = room.items[i];
    if (++it.age >= ITEM_LIFE_TICKS) { room.items.splice(i, 1); continue; }
    for (const [, p] of room.players) {
      if (p.dead || p.joinTicks > 0) continue;
      if (p.x < it.x + ITEM_SIZE && p.x + p.w > it.x && p.y < it.y + ITEM_SIZE && p.y + p.h > it.y) {
        if (it.kind === 'heal') p.hp = Math.min(MAX_HP, p.hp + ITEM_HEAL);
        else if (it.kind === 'speed') p.speedTicks = SPEED_BUFF_TICKS;
        else p.damageTicks = DAMAGE_BUFF_TICKS;
        room.items.splice(i, 1);
        room.pickups.push({ kind: it.kind, x: it.x + ITEM_SIZE / 2, y: it.y + ITEM_SIZE / 2, color: p.color, life: PICKUP_DISPLAY_TICKS });
        break;
      }
    }
  }
  for (let i = room.pickups.length - 1; i >= 0; i--) {
    if (--room.pickups[i].life <= 0) room.pickups.splice(i, 1);
  }
}

// Team match end: announce the winner, kick everyone and start a fresh session
function endMatch(room) {
  const { warm, cool } = room.score;
  const winner = warm === cool ? null : warm > cool ? 'warm' : 'cool';
  broadcast(room, { type: 'match_end', winner, score: { warm, cool } });
  const sockets = [...room.sockets];
  Object.assign(room, makeRoom(room.mode));
  for (const c of sockets) c.kickToModes();
}

// ─── Game loop (20 tps) ──────────────────────────────────────
let loopTicks = 0;
setInterval(() => {
  for (const room of Object.values(rooms)) tickRoom(room);
  // Refresh the mode-select counts once a second
  if (++loopTicks % 20 === 0 && modeSockets.size > 0) {
    const msg = JSON.stringify(modeSummary());
    for (const c of modeSockets) if (c.readyState === 1) c.send(msg);
  }
}, 50);

function tickRoom(room) {
  // Move players & tick cooldowns
  for (const [id, p] of room.players) {
    if (p.spawnTicks > 0) p.spawnTicks--;
    if (p.joinTicks > 0) {
      p.joinTicks--;
      if (p.joinTicks === 0) {
        const pos = spawnPosition(p.w, p.h, p.team);
        p.x = pos.x;
        p.y = pos.y;
        p.spawnTicks = SPAWN_PROTECT_TICKS;
      }
    }
    if (p.shootCooldown > 0) p.shootCooldown--;
    if (p.beamCooldown > 0) p.beamCooldown--;
    if (p.skillCooldown > 0 && p.shieldTicks <= 0 && p.upgradeTicks <= 0) p.skillCooldown--;
    if (p.slowTicks > 0) p.slowTicks--;
    if (p.speedTicks > 0) p.speedTicks--;
    if (p.damageTicks > 0) p.damageTicks--;

    // Tick active E effects
    if (p.shieldTicks > 0 && !p.dead) {
      p.shieldTicks--;
      if (p.shieldTicks === 0) endShield(room, id, p);
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
        const pos = spawnPosition(p.w, p.h, p.team);
        p.x = pos.x;
        p.y = pos.y;
        p.hp = MAX_HP;
        p.dead = false;
        p.dx = 0;
        p.dy = 0;
        p.spawnTicks = SPAWN_PROTECT_TICKS;
      }
      continue;
    }
    if (p.dx !== 0 || p.dy !== 0) {
      let speedMult = p.charging ? CHARGE_SPEED_MULT : 1;
      if (p.shieldTicks > 0) speedMult *= SHIELD_SPEED_MULT;
      if (p.upgradeTicks > 0) speedMult *= UPGRADE_SPEED_MULT;
      if (p.slowTicks > 0) speedMult *= SLOW_SPEED_MULT;
      if (p.speedTicks > 0) speedMult *= SPEED_BUFF_MULT;
      const nx = p.x + p.dx * SPEED * speedMult;
      const ny = p.y + p.dy * SPEED * speedMult;
      if (nx >= 0 && nx + p.w <= ARENA_W && !hitsWall(nx, p.y, p.w, p.h)) p.x = nx;
      if (ny >= 0 && ny + p.h <= ARENA_H && !hitsWall(p.x, ny, p.w, p.h)) p.y = ny;
    }
  }

  // Move bullets & collision
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    // Swept check so a fast bullet cannot skip over a thin wall in one tick
    const wallHit = rayToWall(b.x, b.y, b.vx, b.vy) <= 1;
    b.x += b.vx;
    b.y += b.vy;
    b.life--;

    // Hit a wall, out of bounds or expired
    if (wallHit || b.x < -1 || b.x > ARENA_W + 1 || b.y < -1 || b.y > ARENA_H + 1 || b.life <= 0) {
      room.bullets.splice(i, 1);
      continue;
    }

    // Check collision with players
    let hit = false;
    for (const [pid, p] of room.players) {
      if (pid === b.ownerId || p.dead || p.joinTicks > 0) continue;
      if (allies(b.team, p.team)) continue; // passes through teammates
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
        damagePlayer(room, p, b.damage, b.ownerId);
        break;
      }
    }
    if (hit) {
      room.bullets.splice(i, 1);
    }
  }

  // Move crescents: pierce walls, bodies and shields until they leave the arena
  for (let i = room.crescents.length - 1; i >= 0; i--) {
    const c = room.crescents[i];
    if (stepCrescent(room, c) !== 'fly' || --c.life <= 0) room.crescents.splice(i, 1);
  }

  // Tick beam display lifetime
  for (let i = room.beams.length - 1; i >= 0; i--) {
    room.beams[i].life--;
    if (room.beams[i].life <= 0) room.beams.splice(i, 1);
  }
  for (let i = room.dashes.length - 1; i >= 0; i--) {
    room.dashes[i].life--;
    if (room.dashes[i].life <= 0) room.dashes.splice(i, 1);
  }
  for (let i = room.blasts.length - 1; i >= 0; i--) {
    room.blasts[i].life--;
    if (room.blasts[i].life <= 0) room.blasts.splice(i, 1);
  }
  tickItems(room);

  if (room.mode === 'team' && Math.max(room.score.warm, room.score.cool) >= TEAM_KILL_TARGET) {
    return endMatch(room);
  }
  broadcast(room, gameState(room));
}

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
