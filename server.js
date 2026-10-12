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

const COLORS = [
  '#00FF00', '#FF0000', '#00BFFF', '#FFFF00', '#FF00FF',
  '#FFA500', '#00FFFF', '#FF6347', '#7CFC00', '#DA70D6',
  '#1E90FF', '#FFD700', '#FF4500', '#32CD32', '#FF69B4',
  '#40E0D0', '#EE82EE', '#F0E68C', '#87CEEB', '#DDA0DD',
];

const CLASS_LABELS = [
  'person', 'car', 'truck', 'bicycle', 'motorcycle',
  'bus', 'dog', 'cat', 'bird', 'horse',
  'backpack', 'umbrella', 'handbag', 'chair', 'bottle',
  'laptop', 'cell phone', 'book', 'clock', 'keyboard',
];

// ─── State ───────────────────────────────────────────────────
const players = new Map();   // id → player
const bullets = [];          // { x, y, vx, vy, ownerId, big, size, color }
const beams = [];            // { x, y, dx, dy, ownerId, color, life, hitIds }
let nextId = 1;
let nextBulletId = 1;

function spawnPosition() {
  return {
    x: Math.floor(Math.random() * (ARENA_W - 6)) + 3,
    y: Math.floor(Math.random() * (ARENA_H - 6)) + 3,
  };
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

function gameState() {
  const pList = [];
  for (const [id, p] of players) {
    pList.push({
      id, x: p.x, y: p.y, color: p.color,
      label: p.label, conf: p.conf,
      w: p.w, h: p.h,
      hp: p.hp, maxHp: MAX_HP,
      dead: p.dead,
      kills: p.kills,
      deaths: p.deaths,
      charging: p.charging,
      chargeProgress: p.charging ? Math.min(1, p.chargeTicks / CHARGE_TICKS) : 0,
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
    x: b.x, y: b.y, dx: b.dx, dy: b.dy,
    color: b.color, ownerId: b.ownerId, life: b.life,
    maxLife: BEAM_DISPLAY_TICKS,
  }));
  return {
    type: 'state',
    players: pList,
    bullets: bList,
    beams: beamList,
    arena: { w: ARENA_W, h: ARENA_H, cell: CELL },
  };
}

// ─── HTTP ────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  } else if (req.url === '/image.png') {
    const filePath = path.join(__dirname, 'image.png');
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
  const id = nextId++;
  const pos = spawnPosition();
  const bw = 2 + Math.floor(Math.random() * 3);  // 2-4
  const bh = 2 + Math.floor(Math.random() * 4);  // 2-5
  const player = {
    x: -100, y: -100,
    color: COLORS[id % COLORS.length],
    joinTicks: JOIN_DELAY_TICKS,
    dx: 0, dy: 0,
    label: CLASS_LABELS[Math.floor(Math.random() * CLASS_LABELS.length)],
    conf: (0.75 + Math.random() * 0.24).toFixed(2),
    w: bw, h: bh,
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
    kills: 0,
    deaths: 0,
    ws,
  };
  players.set(id, player);

  ws.send(JSON.stringify({ ...gameState(), type: 'welcome', id }));
  broadcast(gameState());

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const p = players.get(id);
      if (!p) return;

      if (p.joinTicks > 0) return;

      if (msg.type === 'dir' && !p.dead) {
        p.dx = Math.sign(msg.dx ?? 0);
        p.dy = Math.sign(msg.dy ?? 0);
      }

      if (msg.type === 'shoot' && !p.dead) {
        if (p.shootCooldown > 0) return; // on cooldown
        if (p.charging) return; // can't normal-shoot while charging
        p.shootCooldown = SHOOT_COOLDOWN;

        // target in canvas pixels → convert to grid cells
        const tx = msg.tx;
        const ty = msg.ty;

        // bullet spawns from center of player box
        const cx = p.x + p.w / 2;
        const cy = p.y + p.h / 2;
        const dx = tx - cx;
        const dy = ty - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.1) return; // click on self

        const vx = (dx / dist) * BULLET_SPEED;
        const vy = (dy / dist) * BULLET_SPEED;

        p.shotCount++;
        const isBig = (p.shotCount % 3 === 0);

        bullets.push({
          id: nextBulletId++,
          x: cx, y: cy,
          vx, vy,
          ownerId: id,
          big: isBig,
          size: isBig ? BIG_BULLET_SIZE : SMALL_BULLET_SIZE,
          damage: isBig ? 3 : 1,
          color: p.color,
          life: 200,  // max ticks alive (~10s)
        });
      }

      // ── Charge beam (Space) ──
      if (msg.type === 'charge_start' && !p.dead && p.beamCooldown <= 0 && !p.charging) {
        p.charging = true;
        p.chargeTicks = 0;
        p.chargeDirX = msg.tx || 0;
        p.chargeDirY = msg.ty || 0;
      }
      if (msg.type === 'charge_aim' && p.charging) {
        p.chargeDirX = msg.tx || 0;
        p.chargeDirY = msg.ty || 0;
      }
      if (msg.type === 'charge_release' && !p.dead) {
        if (p.charging && p.chargeTicks >= CHARGE_TICKS) {
          // Fire the beam!
          const cx = p.x + p.w / 2;
          const cy = p.y + p.h / 2;
          const tx = msg.tx || p.chargeDirX;
          const ty = msg.ty || p.chargeDirY;
          const ddx = tx - cx;
          const ddy = ty - cy;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dist > 0.1) {
            const ndx = ddx / dist;
            const ndy = ddy / dist;

            // Raycast: check every player along the beam line
            const hitIds = new Set();
            const maxDist = Math.sqrt(ARENA_W * ARENA_W + ARENA_H * ARENA_H);
            for (let t = 0; t < maxDist; t += 0.3) {
              const rx = cx + ndx * t;
              const ry = cy + ndy * t;
              if (rx < -1 || rx > ARENA_W + 1 || ry < -1 || ry > ARENA_H + 1) break;
              for (const [pid, target] of players) {
                if (pid === id || target.dead || hitIds.has(pid)) continue;
                // Check if ray point is within BEAM_WIDTH/2 of target box
                const closestX = Math.max(target.x, Math.min(rx, target.x + target.w));
                const closestY = Math.max(target.y, Math.min(ry, target.y + target.h));
                const distToBox = Math.sqrt((rx - closestX) ** 2 + (ry - closestY) ** 2);
                if (distToBox <= BEAM_WIDTH / 2) {
                  hitIds.add(pid);
                  target.hp -= BEAM_DAMAGE;
                  if (target.hp <= 0) {
                    target.hp = 0;
                    target.dead = true;
                    target.respawnTimer = RESPAWN_TICKS;
                    target.deaths++;
                    p.kills++;
                  }
                }
              }
            }

            beams.push({
              x: cx, y: cy,
              dx: ndx, dy: ndy,
              ownerId: id,
              color: p.color,
              life: BEAM_DISPLAY_TICKS,
              hitIds: [...hitIds],
            });
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
    broadcast(gameState());
  });
});

// ─── Game loop (20 tps) ──────────────────────────────────────
setInterval(() => {
  // Move players & tick cooldowns
  for (const [, p] of players) {
    if (p.joinTicks > 0) {
      p.joinTicks--;
      if (p.joinTicks === 0) {
        const pos = spawnPosition();
        p.x = pos.x;
        p.y = pos.y;
      }
    }
    if (p.shootCooldown > 0) p.shootCooldown--;
    if (p.beamCooldown > 0) p.beamCooldown--;

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
        const pos = spawnPosition();
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
      if (nx >= 0 && nx + p.w <= ARENA_W) p.x = nx;
      if (ny >= 0 && ny + p.h <= ARENA_H) p.y = ny;
    }
  }

  // Move bullets & collision
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.life--;

    // Out of bounds or expired
    if (b.x < -1 || b.x > ARENA_W + 1 || b.y < -1 || b.y > ARENA_H + 1 || b.life <= 0) {
      bullets.splice(i, 1);
      continue;
    }

    // Check collision with players
    let hit = false;
    for (const [pid, p] of players) {
      if (pid === b.ownerId || p.dead) continue;
      // AABB collision: bullet center vs player box
      if (b.x >= p.x && b.x <= p.x + p.w &&
          b.y >= p.y && b.y <= p.y + p.h) {
        p.hp -= b.damage;
        hit = true;

        if (p.hp <= 0) {
          p.hp = 0;
          p.dead = true;
          p.respawnTimer = RESPAWN_TICKS;
          p.deaths++;
          // Credit kill to shooter
          const shooter = players.get(b.ownerId);
          if (shooter) shooter.kills++;
        }
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
  console.log('║  Controls: Arrow keys = move                     ║');
  console.log('║            Q = shoot toward mouse cursor         ║');
  console.log('║            Every 3rd Q = BIG bullet (3 dmg)      ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
