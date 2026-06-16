const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

app.get("/health", (req, res) => res.status(200).send("ok"));

const SUITS = ["♣","♦","♥","♠"];
const RANKS = [2,3,4,5,6,7,8,9,10,"A","V","D","R"];
const HEADS = ["V","D","R"];
const AVATARS = ["😄","😎","🥳","🤩","😈","🕺","💃","🧁","🍻","☠️"];

const rooms = new Map();

function uid(){
  return Math.random().toString(36).slice(2, 10);
}
function shuffle(arr){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function makeDeck(){
  const d=[];
  for(const r of RANKS){
    for(const s of SUITS){
      d.push({rank:r, suit:s, id:uid()});
    }
  }
  return shuffle(d);
}
function cardLabel(card){
  return `${card.rank}${card.suit}`;
}
function cardEffect(card){
  if(card.rank==="A") return "ace";
  if(card.rank==="V") return "reverse";
  if(card.rank==="D") return "queen";
  if(card.rank==="R") return "king";
  return "number";
}
function makeRoom(code){
  return {
    code,
    hostId:null,
    started:false,
    players:[],
    currentIndex:0,
    direction:1,
    score:0,
    deck:makeDeck(),
    discard:[],
    lastCard:null,
    lastTenReached:0,
    pendingDistribution:null,
    death:null
  };
}
function getRoom(code){
  code = code.toUpperCase().trim();
  if(!rooms.has(code)) rooms.set(code, makeRoom(code));
  return rooms.get(code);
}
function draw(room){
  if(room.deck.length === 0){
    room.deck = shuffle(room.discard);
    room.discard = [];
  }
  return room.deck.pop();
}
function publicRoom(room){
  return {
    code:room.code,
    hostId:room.hostId,
    started:room.started,
    players:room.players.map((p, i)=>({
      id:p.id,
      name:p.name,
      drinks:p.drinks,
      avatar:p.avatar,
      handCount:p.hand.length,
      connected:p.connected,
      isCurrent:i===room.currentIndex
    })),
    currentPlayerId:room.players[room.currentIndex]?.id || null,
    currentPlayerName:room.players[room.currentIndex]?.name || "",
    direction:room.direction,
    lastCard:room.lastCard,
    pendingDistribution:room.pendingDistribution ? {
      from:room.pendingDistribution.from,
      fromName:room.players.find(p=>p.id===room.pendingDistribution.from)?.name || "",
      remaining:room.pendingDistribution.remaining,
      total:room.pendingDistribution.total,
      allocations:room.pendingDistribution.allocations
    } : null,
    death: room.death ? {
      active:room.death.active,
      playerId:room.death.playerId,
      playerName:room.players.find(p=>p.id===room.death.playerId)?.name || "",
      direction:room.death.direction,
      step:room.death.step,
      locked:room.death.locked,
      finished:room.death.finished,
      message:room.death.message,
      revealed:room.death.revealed,
      grid: room.death.finished ? room.death.grid : null
    } : null
  };
}
function sendState(room){
  for(const p of room.players){
    io.to(p.socketId).emit("state", {
      room:publicRoom(room),
      me:{
        id:p.id,
        name:p.name,
        hand:p.hand,
        drinks:p.drinks,
        isHost:p.id===room.hostId
      }
    });
  }
}
function nextPlayer(room){
  if(room.players.length === 0) return;
  let safety = 0;
  do {
    room.currentIndex += room.direction;
    if(room.currentIndex >= room.players.length) room.currentIndex = 0;
    if(room.currentIndex < 0) room.currentIndex = room.players.length - 1;
    safety++;
  } while(!room.players[room.currentIndex].connected && safety < room.players.length + 2);
}
function startRoom(room){
  if(room.players.length < 2) return {ok:false, error:"Il faut au moins 2 joueurs."};
  room.started = true;
  room.currentIndex = 0;
  room.direction = 1;
  room.deck = makeDeck();
  room.discard = [];
  room.lastTenReached = 0;
  room.pendingDistribution = null;
  room.death = null;

  for(const p of room.players){
    p.hand = [];
    p.drinks = 0;
  }

  let startCard;
  do {
    startCard = draw(room);
    if(!(typeof startCard.rank === "number" && startCard.rank >= 2 && startCard.rank <= 10)){
      room.discard.push(startCard);
      startCard = null;
    }
  } while(!startCard);

  room.score = startCard.rank;
  room.lastCard = startCard;

  for(const p of room.players){
    for(let i=0;i<4;i++) p.hand.push(draw(room));
  }

  if(room.score === 10) room.players[0].drinks += 1;
  return {ok:true, startScore:room.score};
}
function projectedScore(room, card, aceValue=1){
  const effect = cardEffect(card);
  if(effect==="reverse") return room.score;
  if(effect==="queen"){
    const base = Math.floor(room.score/10)*10;
    return Math.max(0, (room.score % 10 === 0) ? room.score - 10 : base);
  }
  if(effect==="king") return 70;
  if(effect==="ace") return room.score + aceValue;
  return room.score + Number(card.rank);
}
function canPlayWithoutLosing(room, card){
  const effect = cardEffect(card);
  if(effect==="reverse" || effect==="queen" || effect==="king") return true;
  if(effect==="ace") return projectedScore(room, card, 1) < 95 || projectedScore(room, card, 11) < 95;
  return projectedScore(room, card) < 95;
}
function applyCard(room, card, aceValue){
  const effect = cardEffect(card);
  if(effect==="reverse"){
    room.direction *= -1;
  } else if(effect==="queen"){
    const base = Math.floor(room.score/10)*10;
    room.score = Math.max(0, (room.score % 10 === 0) ? room.score - 10 : base);
  } else if(effect==="king"){
    room.score = 70;
  } else if(effect==="ace"){
    room.score += aceValue;
  } else {
    room.score += Number(card.rank);
  }
}
function startDeath(room, playerId){
  room.death = {
    active:true,
    playerId,
    direction:null,
    locked:false,
    step:0,
    deck:makeDeck(),
    grid:buildDeathGrid(makeDeck()),
    revealed:[],
    finished:false,
    message:"Choisis le sens de la Traversée."
  };
}
function drawDeath(room){
  if(!room.death || room.death.deck.length===0) return null;
  return room.death.deck.pop();
}
function buildDeathGrid(deck){
  const d = [...deck];
  const rows = [1,4,4,4,4,1];
  return rows.map(size => Array.from({length:size}, () => d.pop()));
}
function resetDeathAttempt(room){
  room.death.step = 0;
  room.death.grid = [1,4,4,4,4,1].map(size => Array.from({length:size}, () => drawDeath(room)));
  room.death.revealed = [];
}
function expectedDeathRow(death){
  const top = [0,1,2,3,4,5];
  const bottom = [5,4,3,2,1,0];
  return (death.direction === "top" ? top : bottom)[death.step];
}

io.on("connection", socket => {
  socket.on("createRoom", ({name}, cb) => {
    const code = uid().slice(0,5).toUpperCase();
    const room = getRoom(code);
    const player = {
      id:socket.id,
      socketId:socket.id,
      name:(name || "Hôte").slice(0,18),
      avatar:AVATARS[0],
      drinks:0,
      hand:[],
      connected:true
    };
    room.hostId = player.id;
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;
    cb?.({ok:true, code});
    sendState(room);
  });

  socket.on("joinRoom", ({code, name}, cb) => {
    if(!code) return cb?.({ok:false, error:"Code manquant."});
    const room = getRoom(code);
    if(room.started) return cb?.({ok:false, error:"La partie est déjà lancée."});
    if(room.players.length >= 10) return cb?.({ok:false, error:"Table complète."});
    const player = {
      id:socket.id,
      socketId:socket.id,
      name:(name || `Joueur ${room.players.length+1}`).slice(0,18),
      avatar:AVATARS[room.players.length % AVATARS.length],
      drinks:0,
      hand:[],
      connected:true
    };
    if(!room.hostId) room.hostId = player.id;
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    cb?.({ok:true, code:room.code});
    sendState(room);
  });

  socket.on("startGame", (cb) => {
    const room = rooms.get(socket.data.roomCode);
    if(!room) return cb?.({ok:false, error:"Salon introuvable."});

    // Mode type Wolfy : dès que 2 joueurs sont dans le salon, n'importe quel joueur présent peut lancer.
    const playerInRoom = room.players.some(p => p.id === socket.id && p.connected);
    if(!playerInRoom) return cb?.({ok:false, error:"Tu n'es pas dans ce salon."});
    if(room.started) return cb?.({ok:false, error:"La partie est déjà lancée."});
    if(room.players.filter(p => p.connected).length < 2) {
      return cb?.({ok:false, error:"Il faut au moins 2 joueurs connectés."});
    }

    const result = startRoom(room);
    cb?.(result);
    sendState(room);
    if(result.ok) io.to(room.code).emit("toast", `Score de départ : ${result.startScore}`);
  });

  socket.on("playCard", ({cardId, announcedScore, aceValue}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if(!room || !room.started) return cb?.({ok:false, error:"Partie non lancée."});
    if(room.pendingDistribution) return cb?.({ok:false, error:"Distribution en cours."});
    if(room.death?.active && !room.death.finished) return cb?.({ok:false, error:"Traversée en cours."});

    const player = room.players[room.currentIndex];
    if(!player || player.id !== socket.id) return cb?.({ok:false, error:"Ce n’est pas ton tour."});

    const hasSafe = player.hand.some(card => canPlayWithoutLosing(room, card));
    if(!hasSafe){
      startDeath(room, player.id);
      io.to(room.code).emit("toast", `${player.name} ne peut pas jouer : Traversée de la Mort !`);
      sendState(room);
      return cb?.({ok:true});
    }

    const idx = player.hand.findIndex(c => c.id === cardId);
    if(idx < 0) return cb?.({ok:false, error:"Carte introuvable."});
    const card = player.hand[idx];

    if(!canPlayWithoutLosing(room, card)){
      return cb?.({ok:false, error:"Cette carte te fait atteindre 95 ou plus."});
    }

    let chosenAce = Number(aceValue || 1);
    if(cardEffect(card)==="ace"){
      if(![1,11].includes(chosenAce)) chosenAce = 1;
      if(projectedScore(room, card, chosenAce) >= 95){
        return cb?.({ok:false, error:"Cette valeur d’As te fait perdre."});
      }
    }

    player.hand.splice(idx,1);
    player.hand.push(draw(room));
    room.discard.push(card);
    applyCard(room, card, chosenAce);
    room.lastCard = card;

    if(announcedScore !== "" && announcedScore !== null && announcedScore !== undefined){
      if(Number(announcedScore) !== room.score){
        player.drinks += 1;
        io.to(room.code).emit("toast", `${player.name} a annoncé un mauvais score : +1 gorgée.`);
      }
    }

    if(room.score % 10 === 0 && room.score > 0 && room.score !== room.lastTenReached){
      room.lastTenReached = room.score;
      room.pendingDistribution = {
        from:player.id,
        remaining:room.score/10,
        total:room.score/10,
        allocations:Object.fromEntries(room.players.map(p => [p.id, 0]))
      };
      sendState(room);
      return cb?.({ok:true});
    }

    nextPlayer(room);
    sendState(room);
    cb?.({ok:true});
  });

  socket.on("setDistribution", ({allocations}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if(!room?.pendingDistribution) return cb?.({ok:false, error:"Aucune distribution."});
    if(room.pendingDistribution.from !== socket.id) return cb?.({ok:false, error:"Ce n’est pas à toi de distribuer."});

    const total = Object.values(allocations || {}).reduce((s,v)=>s+Number(v||0),0);
    if(total !== room.pendingDistribution.total) return cb?.({ok:false, error:"Le total ne correspond pas."});

    for(const p of room.players){
      p.drinks += Number(allocations[p.id] || 0);
    }
    room.pendingDistribution = null;
    nextPlayer(room);
    sendState(room);
    cb?.({ok:true});
  });

  socket.on("deathDirection", ({direction}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    const death = room?.death;
    if(!death?.active || death.playerId !== socket.id) return cb?.({ok:false, error:"Pas ta traversée."});
    if(death.locked) return cb?.({ok:false, error:"Sens déjà choisi."});
    if(!["top","bottom"].includes(direction)) return cb?.({ok:false, error:"Sens invalide."});
    death.direction = direction;
    death.locked = true;
    death.message = direction === "top" ? "Sens verrouillé : Haut → Bas" : "Sens verrouillé : Bas → Haut";
    resetDeathAttempt(room);
    sendState(room);
    cb?.({ok:true});
  });

  socket.on("deathPick", ({row, col}, cb) => {
    const room = rooms.get(socket.data.roomCode);
    const death = room?.death;
    if(!death?.active || death.playerId !== socket.id) return cb?.({ok:false, error:"Pas ta traversée."});
    if(!death.direction) return cb?.({ok:false, error:"Choisis le sens."});
    if(death.finished) return cb?.({ok:false, error:"Traversée terminée."});

    const expected = expectedDeathRow(death);
    if(row !== expected) return cb?.({ok:false, error:"Tu dois suivre la rangée."});
    if((row===0 || row===5) && col !== 0) return cb?.({ok:false, error:"Carte unique obligatoire."});

    const card = death.grid[row]?.[col];
    if(!card){
      const p = room.players.find(x=>x.id===death.playerId);
      p.drinks += 20;
      death.message = "☠️ Paquet épuisé : CUL SEC ! (+20 compté)";
      death.finished = true;
      sendState(room);
      return cb?.({ok:true});
    }

    death.revealed.push({row, col, card});
    const isHead = HEADS.includes(card.rank);
    if(isHead){
      const p = room.players.find(x=>x.id===death.playerId);
      const g = death.step + 1;
      p.drinks += g;
      death.message = `💀 ${cardLabel(card)} : ${g} gorgée(s), on recommence.`;
      sendState(room);
      setTimeout(() => {
        const freshRoom = rooms.get(room.code);
        if(freshRoom?.death?.active && !freshRoom.death.finished){
          resetDeathAttempt(freshRoom);
          freshRoom.death.message = "Nouvelle tentative.";
          sendState(freshRoom);
        }
      }, 1400);
      return cb?.({ok:true});
    }

    death.step++;
    if(death.step >= 6){
      death.message = "✅ Traversée réussie !";
      death.finished = true;
    } else {
      death.message = "Safe ! Rangée suivante.";
    }
    sendState(room);
    cb?.({ok:true});
  });

  socket.on("finishDeath", (cb) => {
    const room = rooms.get(socket.data.roomCode);
    const death = room?.death;
    if(!death?.active || !death.finished || death.playerId !== socket.id) return cb?.({ok:false, error:"Impossible."});

    let startCard;
    do {
      startCard = draw(room);
      if(!(typeof startCard.rank === "number" && startCard.rank >= 2 && startCard.rank <= 10)){
        room.discard.push(startCard);
        startCard = null;
      }
    } while(!startCard);

    room.score = startCard.rank;
    room.lastCard = startCard;
    room.lastTenReached = 0;
    const idx = room.players.findIndex(p=>p.id===death.playerId);
    room.currentIndex = idx >= 0 ? idx : 0;
    room.death = null;
    nextPlayer(room);
    io.to(room.code).emit("toast", `Nouveau score de départ : ${room.score}`);
    sendState(room);
    cb?.({ok:true});
  });


  socket.on("forceStartGame", () => {
    const room = rooms.get(socket.data.roomCode);
    if(!room) {
      socket.emit("startGameError", "Salon introuvable.");
      return;
    }

    const playerInRoom = room.players.some(p => p.id === socket.id && p.connected);
    if(!playerInRoom) {
      socket.emit("startGameError", "Tu n'es pas dans ce salon.");
      return;
    }

    if(room.started) {
      socket.emit("startGameError", "La partie est déjà lancée.");
      return;
    }

    if(room.players.filter(p => p.connected).length < 2) {
      socket.emit("startGameError", "Il faut au moins 2 joueurs connectés.");
      return;
    }

    const result = startRoom(room);
    if(!result.ok) {
      socket.emit("startGameError", result.error || "Impossible de lancer.");
      return;
    }

    io.to(room.code).emit("toast", `Score de départ : ${result.startScore}`);
    sendState(room);
  });


  socket.on("newRound", () => {
    const room = rooms.get(socket.data.roomCode);
    if(!room) {
      socket.emit("startGameError", "Salon introuvable.");
      return;
    }
    const playerInRoom = room.players.some(p => p.id === socket.id && p.connected);
    if(!playerInRoom) {
      socket.emit("startGameError", "Tu n'es pas dans ce salon.");
      return;
    }
    if(room.players.filter(p => p.connected).length < 2) {
      socket.emit("startGameError", "Il faut au moins 2 joueurs connectés.");
      return;
    }
    const result = startRoom(room);
    if(!result.ok) {
      socket.emit("startGameError", result.error || "Impossible de relancer.");
      return;
    }
    io.to(room.code).emit("toast", `Nouvelle partie ! Score de départ : ${result.startScore}`);
    sendState(room);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if(!room) return;
    const p = room.players.find(x => x.id === socket.id);
    if(p) p.connected = false;
    if(room.players.every(x=>!x.connected)){
      setTimeout(()=> {
        const r = rooms.get(code);
        if(r && r.players.every(x=>!x.connected)) rooms.delete(code);
      }, 60000);
    } else {
      sendState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`95 Party lancé sur http://localhost:${PORT}`);
});
