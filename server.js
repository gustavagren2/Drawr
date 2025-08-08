import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_,res)=>res.status(200).send("ok"));

/** STATE **/
/**
 * @typedef {{id:string, name:string, avatar:string, putter:string, ready:boolean, connected:boolean, socketId:string, strokes:number[], total:number}} Player
 * @typedef {{
 *  id:string, hostId:string|null, state:'lobby'|'playing'|'holeEnd'|'gameOver',
 *  players: Player[], chat: any[],
 *  holeIndex:number, // 0..8 (we start with 1 sample hole, but keep API 9-hole ready)
 *  turnIndex:number, // index into players array
 *  physics: null | { running:boolean, x:number, y:number, vx:number, vy:number },
 * }} Room
 */

/** memory store */
const rooms = Object.create(null);
const uid = () => crypto.randomBytes(8).toString("hex");

function getRoom(id){
  if(!rooms[id]){
    rooms[id] = {
      id, hostId: null, state: "lobby",
      players: [],
      chat: [],
      holeIndex: 0,
      turnIndex: 0,
      physics: null
    };
  }
  return rooms[id];
}
const activePlayers = r => r.players.filter(p => p.connected);

/** COURSE DATA (MVP: 1 hole) **/
const HOLES = [
  {
    par: 3,
    // start position & cup
    start: { x: 140, y: 260 },
    cup: { x: 700, y: 260, r: 12 },
    // axis-aligned walls as rectangles [x,y,w,h]
    walls: [
      [80, 120, 680, 20],   // top boundary
      [80, 380, 680, 20],   // bottom boundary
      [80, 120, 20, 280],   // left wall
      [760,120, 20, 280],   // right wall
      // a choke in the middle
      [380,120, 20, 120],
      [380,280, 20, 120],
    ]
  }
];

/** Broadcast room (lobby details only) **/
function broadcastRoom(r){
  io.to(r.id).emit("room:state", {
    id: r.id,
    state: r.state,
    hostId: r.hostId,
    players: activePlayers(r).map(p=>({
      id:p.id, name:p.name, avatar:p.avatar, putter:p.putter, ready:p.ready
    })),
    holeIndex: r.holeIndex,
    turnIndex: r.turnIndex
  });
}

function resetScores(p){
  p.strokes = Array(HOLES.length).fill(0);
  p.total = 0;
}

/** Start game **/
function startGame(r){
  const ps = activePlayers(r);
  if(ps.length < 1) return false;
  ps.forEach(resetScores);
  r.holeIndex = 0;
  r.turnIndex = 0;
  r.state = "playing";
  startHole(r);
  return true;
}

/** Start hole **/
function startHole(r){
  const hole = HOLES[r.holeIndex];
  // reset per-hole positions and physics state
  r.physics = { running:false, x: hole.start.x, y: hole.start.y, vx:0, vy:0 };
  // inform clients of hole layout
  io.to(r.id).emit("hole:start", { holeIndex: r.holeIndex, hole });
  announceTurn(r);
}

/** Announce whose turn **/
function announceTurn(r){
  const players = activePlayers(r);
  if (players.length === 0) { r.state = "lobby"; broadcastRoom(r); return; }
  if (r.turnIndex >= players.length) r.turnIndex = 0;
  const pid = players[r.turnIndex].id;
  io.to(r.id).emit("turn:begin", { playerId: pid });
  broadcastRoom(r);
}

/** Next player's turn or next hole **/
function nextTurnOrHole(r, sunk=false){
  const players = activePlayers(r);
  if (players.length === 0) { r.state = "lobby"; broadcastRoom(r); return; }
  if (sunk || r.players.every(p => p.strokes[r.holeIndex] >= 6)) {
    // End of hole
    r.state = "holeEnd";
    const results = r.players.map(p=>({
      id:p.id, name:p.name, strokes:p.strokes[r.holeIndex], total: p.total
    }));
    io.to(r.id).emit("hole:end", { holeIndex: r.holeIndex, par: HOLES[r.holeIndex].par, results });
    broadcastRoom(r);
    // Progress after delay
    setTimeout(()=>{
      r.holeIndex++;
      if (r.holeIndex >= HOLES.length) {
        r.state = "gameOver";
        const board = r.players.map(p=>({id:p.id, name:p.name, total:p.total}));
        io.to(r.id).emit("game:over", { leaderboard: board });
        broadcastRoom(r);
        return;
      }
      r.state = "playing";
      r.turnIndex = 0;
      startHole(r);
    }, 3000);
  } else {
    // Next player's turn
    r.turnIndex = (r.turnIndex + 1) % players.length;
    r.physics.running = false;
    announceTurn(r);
  }
}

/** Physics & shot handling **/
function handleShot(r, playerId, vec){
  const players = activePlayers(r);
  if (players.length === 0) return;
  const current = players[r.turnIndex];
  if (!current || current.id !== playerId) return; // only current player may shoot

  // inc strokes, clamp to 6 max
  const hi = r.holeIndex;
  current.strokes[hi] = Math.min((current.strokes[hi] || 0) + 1, 6);

  const hole = HOLES[hi];
  const ph = r.physics;
  if (!ph) return;
  // launch from current ball pos with vec (already power-limited client-side)
  ph.vx = vec.vx;
  ph.vy = vec.vy;
  ph.running = true;

  // Authoritative sim loop
  const FRIC = 0.985; // friction per tick
  const STOP = 3;     // speed threshold to stop
  const TICK = 1000/60;
  const cup = hole.cup;

  function rectsCollide(x, y, r, rect){
    const [rx,ry,rw,rh] = rect;
    const nx = Math.max(rx, Math.min(x, rx+rw));
    const ny = Math.max(ry, Math.min(y, ry+rh));
    const dx = x - nx, dy = y - ny;
    return (dx*dx + dy*dy) <= r*r;
  }

  const ballR = 8;

  const timer = setInterval(()=>{
    if (!r.physics?.running) { clearInterval(timer); return; }

    // integrate
    ph.x += ph.vx * (TICK/16);
    ph.y += ph.vy * (TICK/16);

    // collide with walls
    for (const w of hole.walls) {
      if (rectsCollide(ph.x, ph.y, ballR, w)) {
        // simple reflect: determine which side we hit more
        const [rx,ry,rw,rh] = w;
        const prevX = ph.x - ph.vx * (TICK/16);
        const prevY = ph.y - ph.vy * (TICK/16);

        const hitLeft = prevX <= rx && ph.x > rx;
        const hitRight = prevX >= rx+rw && ph.x < rx+rw;
        const hitTop = prevY <= ry && ph.y > ry;
        const hitBottom = prevY >= ry+rh && ph.y < ry+rh;

        if (hitLeft || hitRight) ph.vx *= -0.85;
        if (hitTop || hitBottom) ph.vy *= -0.85;

        // push ball out of wall a tiny bit
        if (hitLeft) ph.x = rx - ballR - 1;
        if (hitRight) ph.x = rx+rw + ballR + 1;
        if (hitTop) ph.y = ry - ballR - 1;
        if (hitBottom) ph.y = ry+rh + ballR + 1;

        io.to(r.id).emit("fx:bonk");
      }
    }

    // friction
    ph.vx *= FRIC;
    ph.vy *= FRIC;

    // cup check
    const dx = ph.x - cup.x, dy = ph.y - cup.y;
    if (dx*dx + dy*dy <= (cup.r - 2)*(cup.r - 2)) {
      // sunk!
      io.to(r.id).emit("ball:update", { x: cup.x, y: cup.y, vx:0, vy:0 });
      io.to(r.id).emit("fx:cup");
      ph.running = false;
      clearInterval(timer);

      // compute scores
      const strokes = current.strokes[hi];
      current.total = (current.total||0) + strokes;
      setTimeout(()=> nextTurnOrHole(r, true), 500);
      return;
    }

    // stop?
    if (Math.hypot(ph.vx, ph.vy) < STOP) {
      ph.vx = ph.vy = 0;
      ph.running = false;
      io.to(r.id).emit("ball:update", { x: ph.x, y: ph.y, vx:0, vy:0 });
      clearInterval(timer);

      // stroke limit?
      if (current.strokes[hi] >= 6) {
        io.to(r.id).emit("fx:limit");
      }
      setTimeout(()=> nextTurnOrHole(r, false), 350);
      return;
    }

    // broadcast position
    io.to(r.id).emit("ball:update", { x: ph.x, y: ph.y, vx: ph.vx, vy: ph.vy });
  }, TICK);
}

/** SOCKETS **/
io.on("connection",(socket)=>{
  const roomParam = (socket.handshake.query.room||"").toString().trim();
  const roomId = roomParam || "clubhouse";
  const r = getRoom(roomId);
  socket.join(r.id);

  const player = {
    id: uid(),
    name: "Golfer " + (Math.random()*90+10|0),
    avatar: ["🐸","🐼","🦊","🐵","🐹","🐨","🐔","🐙","🦄","🤖"][Math.floor(Math.random()*10)],
    putter: ["#ff6b6b","#ffd166","#4dd599","#6c77ff","#ff8ccf"][Math.floor(Math.random()*5)],
    ready: false,
    connected: true,
    socketId: socket.id,
    strokes: [],
    total: 0
  };
  r.players.push(player);
  if (!r.hostId) r.hostId = player.id;

  socket.emit("room:joined", { roomId: r.id, playerId: player.id, hostId: r.hostId });
  broadcastRoom(r);

  // lobby
  socket.on("player:set", ({ name, avatar, putter }) => {
    if (typeof name === "string") player.name = name.slice(0,24) || player.name;
    if (typeof avatar === "string") player.avatar = avatar.slice(0,2) || player.avatar;
    if (typeof putter === "string") player.putter = putter;
    broadcastRoom(r);
  });
  socket.on("player:ready", ({ ready }) => {
    player.ready = !!ready;
    broadcastRoom(r);
  });

  socket.on("chat:send", ({ text }) => {
    const msg = (""+(text||"")).slice(0,140);
    io.to(r.id).emit("chat:new", { name: player.name, avatar: player.avatar, text: msg, ts: Date.now() });
  });

  socket.on("game:start", () => {
    if (player.id !== r.hostId) return;
    if (r.state !== "lobby") return;
    const allReady = activePlayers(r).every(p => p.ready);
    if (!allReady) return;
    startGame(r);
  });

  // putting
  socket.on("shot:putt", ({ vx, vy }) => {
    if (r.state !== "playing") return;
    handleShot(r, player.id, { vx, vy });
  });

  socket.on("disconnect", ()=>{
    player.connected = false;
    if (r.hostId === player.id) {
      const next = activePlayers(r)[0];
      r.hostId = next ? next.id : null;
    }
    broadcastRoom(r);
  });
});

server.listen(PORT, ()=>console.log(`⛳️ MiniGolf Party on http://localhost:${PORT}`));
