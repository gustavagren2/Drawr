import express from "express";
import http from "http";
import { Server } from "socket.io";
import compression from "compression";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(compression());
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_,res)=>res.status(200).send("ok"));

const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

/**
 * @typedef {{
 *  id:string, name:string, color:string, ready:boolean, connected:boolean, socketId:string,
 *  // latest state (quantized a bit to keep payload small)
 *  x:number,y:number,z:number, qx:number,qy:number,qz:number,qw:number, s:number // speed
 * }} Player
 * @typedef {{
 *  id:string, hostId:string|null, state:'lobby'|'flying',
 *  players: Player[], chat:any[]
 * }} Room
 */

const rooms = Object.create(null);
const uid = () => crypto.randomBytes(8).toString("hex");
function getRoom(id){
  if(!rooms[id]){
    rooms[id] = { id, hostId:null, state:"lobby", players:[], chat:[] };
  }
  return rooms[id];
}
const activePlayers = r => r.players.filter(p=>p.connected);

function broadcastRoom(r){
  io.to(r.id).emit("room:state", {
    id: r.id,
    state: r.state,
    hostId: r.hostId,
    players: activePlayers(r).map(p => ({
      id:p.id, name:p.name, color:p.color, ready:p.ready
    }))
  });
}

io.on("connection", (socket)=>{
  const roomParam = (socket.handshake.query.room||"").toString().trim();
  const roomId = roomParam || "airfield";
  const r = getRoom(roomId);
  socket.join(r.id);

  const player = {
    id: uid(),
    name: "Pilot "+(Math.random()*90+10|0),
    color: "#7ab8ff",
    ready: false,
    connected: true,
    socketId: socket.id,
    x: 0, y: 200, z: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    s: 0
  };
  r.players.push(player);
  if(!r.hostId) r.hostId = player.id;

  socket.emit("room:joined", { roomId: r.id, playerId: player.id, hostId: r.hostId });
  broadcastRoom(r);

  // lobby updates
  socket.on("player:set", ({name,color})=>{
    if(typeof name==="string") player.name = name.slice(0,24) || player.name;
    if(typeof color==="string") player.color = color;
    broadcastRoom(r);
  });
  socket.on("player:ready", ({ready})=>{
    player.ready = !!ready;
    broadcastRoom(r);
  });
  socket.on("chat:send", ({text})=>{
    const msg = (""+(text||"")).slice(0,140);
    io.to(r.id).emit("chat:new", { name: player.name, text: msg, ts: Date.now() });
  });

  // host starts
  socket.on("game:start", ()=>{
    if(player.id!==r.hostId || r.state!=="lobby") return;
    const ps = activePlayers(r);
    if(ps.length<1) return;
    if(!ps.every(p=>p.ready)) return;
    r.state = "flying";
    // spawn spread
    let angle=0;
    for(const p of ps){
      p.x = Math.cos(angle)*200; p.z = Math.sin(angle)*200; p.y = 200 + (Math.random()*40-20);
      p.qx = 0; p.qy = Math.sin(angle*0.5); p.qz = 0; p.qw = Math.cos(angle*0.5);
      p.s = 30;
      angle += (Math.PI*2)/Math.max(ps.length,1);
    }
    io.to(r.id).emit("game:start");
    broadcastRoom(r);
  });

  // state updates from clients (quantized to reduce spam)
  // We accept client-reported transform for MVP; server just relays to others.
  socket.on("state:update", (p)=>{
    if(r.state!=="flying") return;
    // trust but clamp
    player.x = +p.x||0; player.y=+p.y||0; player.z=+p.z||0;
    player.qx = +p.qx||0; player.qy=+p.qy||0; player.qz=+p.qz||0; player.qw=+p.qw||1;
    player.s = Math.max(0, Math.min(120, +p.s||0));
  });

  // Snapshot relay at ~12 Hz
  const SNAP_MS = 80;
  const snapTimer = setInterval(()=>{
    if(r.state!=="flying") return;
    const payload = activePlayers(r).map(p => ({
      id:p.id,
      // round to 2 decimals to shrink payload + stabilize interpolation
      x:+p.x.toFixed(2), y:+p.y.toFixed(2), z:+p.z.toFixed(2),
      qx:+p.qx.toFixed(4), qy:+p.qy.toFixed(4), qz:+p.qz.toFixed(4), qw:+p.qw.toFixed(4),
      s:+p.s.toFixed(1), name:p.name, color:p.color
    }));
    io.to(r.id).emit("state:snapshot", payload);
  }, SNAP_MS);

  socket.on("disconnect", ()=>{
    player.connected=false;
    if(r.hostId===player.id){
      const n = activePlayers(r)[0];
      r.hostId = n ? n.id : null;
    }
    broadcastRoom(r);
    clearInterval(snapTimer);
  });
});

server.listen(PORT, ()=>console.log(`✈️ AirParty running on http://localhost:${PORT}`));
