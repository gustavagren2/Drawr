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
app.get("/health", (_, res) => res.status(200).send("ok"));

/** @type {Record<string, Room>} */
const rooms = Object.create(null);

const WORDS = [
  "apple","banana","guitar","rocket","puzzle","castle","dragon","bridge","island","piano",
  "forest","camera","butterfly","rainbow","octopus","mountain","computer","headphones","turtle",
  "football","strawberry","robot","airplane","hamburger","diamond","skateboard","magnet","lantern",
  "candle","backpack","submarine","umbrella","pyramid","tornado","compass","violin","mermaid","snowman"
];

/**
 * @typedef {{ id:string, name:string, connected:boolean, ready:boolean, socketId:string, drawsDone:number }} Player
 * @typedef {{
 *  id:string, hostId:string|null,
 *  state:'lobby'|'roundStart'|'drawing'|'roundEnd'|'gameOver',
 *  players: Player[],
 *  leaderboard: Record<string, number>,
 *  drawerQueue: string[],
 *  roundIndex: number,
 *  current: null | {
 *    drawerId:string, word:string, masked:string, revealed:Set<number>,
 *    choices:string[], startAt:number, timer?:NodeJS.Timeout, secondsLeft:number,
 *    guesses: Record<string, {correct:boolean, timeLeft?:number, hintsUsed?:number}>,
 *    hintsUsed:number
 *  }
 * }} Room
 */

const uid = () => crypto.randomBytes(8).toString("hex");
const now = () => Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const shuffle = (a)=>{ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]];} return a;};

function getRoom(id){
  if(!rooms[id]){
    rooms[id] = { id, hostId:null, state:"lobby", players:[], leaderboard:{}, drawerQueue:[], roundIndex:0, current:null };
  }
  return rooms[id];
}
function activePlayers(room){ return room.players.filter(p=>p.connected); }
function publicPlayer(p){ return { id:p.id, name:p.name, ready:p.ready, connected:p.connected }; }
function broadcastRoom(room){
  // 🧹 show ONLY active players
  const actives = activePlayers(room);
  io.to(room.id).emit("room:state", {
    id: room.id,
    state: room.state,
    hostId: room.hostId,
    players: actives.map(publicPlayer),
    leaderboard: room.leaderboard,
    roundIndex: room.roundIndex,
    drawerId: room.current?.drawerId || null,
    masked: room.current?.masked || null,
    secondsLeft: room.current?.secondsLeft || 0
  });
}

function chooseThreeWords(){
  const picks=[]; while(picks.length<3){ const w=WORDS[(Math.random()*WORDS.length)|0]; if(!picks.includes(w)&&w.length>=3&&w.length<=12) picks.push(w); }
  return picks;
}
function maskWord(word, revealed=new Set()){
  return word.split("").map((ch,i)=>ch===" "?" ":revealed.has(i)?ch.toUpperCase():"_").join("");
}

// Build a drawer queue where each active player appears 3 times, shuffled
function buildQueue(room){
  const ids = activePlayers(room).map(p=>p.id);
  const q=[]; for(let i=0;i<3;i++) q.push(...ids);
  return shuffle(q);
}

// Remove disconnected players from queue
function pruneQueue(room){
  const aliveIds = new Set(activePlayers(room).map(p=>p.id));
  room.drawerQueue = room.drawerQueue.filter(id => aliveIds.has(id));
}

function startGame(room){
  const ps = activePlayers(room); if(ps.length<2) return false;
  room.leaderboard = {}; for(const p of ps){ room.leaderboard[p.id]=0; p.drawsDone=0; }
  room.drawerQueue = buildQueue(room);
  room.roundIndex=0;
  room.state="roundStart";
  startRound(room);
  return true;
}

function startRound(room){
  clearTimer(room);

  // keep queue clean and skip to next active
  pruneQueue(room);

  // if queue empty → game over
  if(room.drawerQueue.length===0){
    room.state="gameOver"; broadcastRoom(room);
    io.to(room.id).emit("game:over",{ leaderboard: room.leaderboard });
    return;
  }

  // pick next active drawer
  let drawerId = null;
  while(room.drawerQueue.length && !drawerId){
    const candidate = room.drawerQueue.shift();
    const p = room.players.find(x=>x.id===candidate && x.connected);
    if (p) { drawerId = p.id; p.drawsDone = (p.drawsDone||0)+1; }
  }
  if(!drawerId){
    // everyone disconnected? go to lobby
    room.state="lobby"; broadcastRoom(room); return;
  }

  room.state="roundStart"; room.roundIndex++;

  room.current = {
    drawerId, word:"", masked:"", revealed:new Set(), choices:chooseThreeWords(),
    startAt: now(), secondsLeft: 60, hintsUsed:0, timer: undefined,
    guesses: Object.fromEntries(room.players.map(p=>[p.id,{correct:false}]))
  };

  broadcastRoom(room);
  const sockId = room.players.find(p=>p.id===drawerId)?.socketId;
  if(sockId) io.to(sockId).emit("round:choices", { choices: room.current.choices });
}

function clearTimer(room){ if(room.current?.timer){ clearInterval(room.current.timer); room.current.timer=undefined; } }

function revealLetters(room){
  const cur = room.current; if(!cur) return;
  const w = cur.word, list=[];
  for(let i=0;i<w.length;i++){ if(w[i]!==" " && !cur.revealed.has(i)) list.push(i); }
  if(!list.length) return;
  const i = list[(Math.random()*list.length)|0]; cur.revealed.add(i);
  cur.masked = maskWord(w, cur.revealed);
  io.to(room.id).emit("hint:reveal",{ indices:[i], masked: cur.masked });
}

function scoreRound(room){
  const cur = room.current; if(!cur) return { perPlayer: [], best:null };
  const drawerId = cur.drawerId;
  const guessers = activePlayers(room).filter(p=>p.id!==drawerId);
  const G = guessers.length || 1;
  const perPlayer = []; const times=[]; let C=0;

  for(const g of guessers){
    const gi = cur.guesses[g.id]; if(gi?.correct){
      C++;
      const t = clamp(gi.timeLeft ?? 0, 0, 60);
      const hintsUsed = clamp(gi.hintsUsed ?? 0, 0, 3);
      const revealPenalty = 3 - hintsUsed;
      let pts = 200*(t/60) + 30*revealPenalty;
      pts = clamp(Math.round(pts), 0, 250);
      room.leaderboard[g.id] = (room.leaderboard[g.id]||0) + pts;
      perPlayer.push({ id:g.id, name: g.name, points: pts });
      times.push(t);
    }
  }
  const avgT = times.length ? times.reduce((a,b)=>a+b,0)/times.length : 0;
  let drawerPts = clamp(Math.round(250*( (C/G) + (avgT/60) )), 0, 500);
  room.leaderboard[drawerId] = (room.leaderboard[drawerId]||0) + drawerPts;
  const drawerName = room.players.find(p=>p.id===drawerId)?.name || "Drawer";
  perPlayer.push({ id:drawerId, name:drawerName, points: drawerPts });

  const best = perPlayer.slice().sort((a,b)=>b.points-a.points)[0] || null;
  return { perPlayer, best };
}

function startDrawing(room, chosenWord){
  const cur = room.current; if(!cur) return;
  cur.word = chosenWord.toLowerCase(); cur.revealed = new Set(); cur.masked = maskWord(cur.word, cur.revealed);
  room.state="drawing"; cur.startAt=now(); cur.secondsLeft=60; cur.hintsUsed=0;
  broadcastRoom(room);
  io.to(room.id).emit("round:start", { drawerId: cur.drawerId, masked: cur.masked, secondsLeft: cur.secondsLeft });

  cur.timer = setInterval(()=>{
    if(!room.current) return clearTimer(room);
    cur.secondsLeft = Math.max(0, cur.secondsLeft - 1);
    if([30,20,10].includes(cur.secondsLeft)){ revealLetters(room); cur.hintsUsed++; }
    const guessers = activePlayers(room).filter(p=>p.id!==cur.drawerId);
    const allCorrect = guessers.length>0 && guessers.every(g=>cur.guesses[g.id]?.correct);
    io.to(room.id).emit("tick",{ secondsLeft: cur.secondsLeft, masked: cur.masked });
    if(cur.secondsLeft<=0 || allCorrect){
      clearTimer(room);
      const { perPlayer, best } = scoreRound(room);
      room.state="roundEnd";
      io.to(room.id).emit("round:end",{ word: cur.word.toUpperCase(), perPlayer, leaderboard: room.leaderboard, best });
      broadcastRoom(room);
      setTimeout(()=>startRound(room), 4000);
    }
  },1000);
}

// ===== Sockets =====
io.on("connection",(socket)=>{
  const roomParam = (socket.handshake.query.room||"").toString().trim();
  const roomId = roomParam || "party";
  const room = getRoom(roomId);
  socket.join(room.id);

  const player = { id: uid(), name: "Player "+(Math.random()*90+10|0), connected:true, ready:false, socketId: socket.id, drawsDone:0 };
  room.players.push(player);
  if(!room.hostId) room.hostId = player.id;

  socket.emit("room:joined",{ roomId: room.id, playerId: player.id, hostId: room.hostId });
  broadcastRoom(room);

  socket.on("chat:send", ({text})=>{
    const msg = (""+(text||"")).slice(0,200);
    io.to(room.id).emit("chat:new",{ from: player.id, name: player.name, text: msg, ts: Date.now() });
  });
  socket.on("player:setName", ({name})=>{ player.name=(""+(name||"")).slice(0,24)||player.name; broadcastRoom(room); });
  socket.on("player:ready", ({ready})=>{ player.ready=!!ready; broadcastRoom(room); });

  socket.on("game:start", ()=>{
    if(player.id!==room.hostId || room.state!=="lobby") return;
    if(activePlayers(room).length>12){ socket.emit("toast",{type:"error",text:"Max 12 players"}); return; }
    startGame(room);
  });

  socket.on("drawer:chooseWord", ({word})=>{
    const cur=room.current; if(!cur || room.state!=="roundStart") return;
    if(player.id!==cur.drawerId) return;
    if(!cur.choices.includes(word)) return;
    startDrawing(room, word);
  });

  // Forward size/color every packet (client also smooths)
  socket.on("draw:begin",(p)=>{ if(room.current?.drawerId!==player.id || room.state!=="drawing") return; socket.to(room.id).emit("draw:begin", p); });
  socket.on("draw:move",(p)=>{ if(room.current?.drawerId!==player.id || room.state!=="drawing") return; socket.to(room.id).emit("draw:move", p); });
  socket.on("draw:end",(p)=>{ if(room.current?.drawerId!==player.id || room.state!=="drawing") return; socket.to(room.id).emit("draw:end", p || {}); });

  socket.on("guess:submit", ({text})=>{
    const cur=room.current; if(!cur || room.state!=="drawing") return;
    const guess=(""+(text||"")).toLowerCase().trim(); if(!guess) return;
    const gi = cur.guesses[player.id]; if(!gi || gi.correct) return;
    if(guess===cur.word){
      gi.correct=true; gi.timeLeft=cur.secondsLeft; gi.hintsUsed=cur.hintsUsed;
      io.to(room.id).emit("guess:correct",{ playerId: player.id, name: player.name });
      broadcastRoom(room);
    }
  });

  socket.on("play:again", ()=>{
    if(room.state!=="gameOver") return;
    clearTimer(room);
    room.state="lobby"; room.leaderboard={}; room.drawerQueue=[]; room.roundIndex=0; room.current=null;
    for(const p of room.players) p.ready=false;
    broadcastRoom(room);
  });

  socket.on("disconnect", ()=>{
    player.connected=false;
    // if host leaves, pass host to next active
    if(room.hostId===player.id){
      const next = activePlayers(room)[0];
      room.hostId = next ? next.id : null;
    }
    // If current drawer left, end round early
    if(room.current?.drawerId === player.id && room.state === "drawing"){
      clearTimer(room);
      const { perPlayer, best } = scoreRound(room);
      room.state="roundEnd";
      io.to(room.id).emit("round:end",{ word: room.current.word.toUpperCase(), perPlayer, leaderboard: room.leaderboard, best });
      broadcastRoom(room);
      setTimeout(()=>startRound(room), 1500);
    } else {
      // prune queue so they don't appear again
      pruneQueue(room);
      broadcastRoom(room);
    }
  });
});

server.listen(PORT, ()=>console.log(`✅ Running on http://localhost:${PORT}`));
