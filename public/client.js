const socket = io();
let state = null;
let me = null;
let selectedCardId = null;
let localAllocations = {};

const el = id => document.getElementById(id);
const AVATARS = ["😄","😎","🥳","🤩","😈","🕺","💃","🧁","🍻","☠️"];
const HEADS = ["V","D","R"];

function cardColor(card){ return (card.suit==="♥" || card.suit==="♦") ? "red" : "black"; }
function cardLabel(card){ return `${card.rank}${card.suit}`; }
function cardNote(card){
  if(card.rank==="A") return "1 ou 11";
  if(card.rank==="V") return "inverse";
  if(card.rank==="D") return "↓ dizaine";
  if(card.rank==="R") return "70";
  return "";
}
function screen(id){
  ["loginScreen","lobbyScreen","gameScreen"].forEach(s=>el(s).classList.add("hidden"));
  el(id).classList.remove("hidden");
}
function emitWithAck(event, payload={}){
  return new Promise(resolve=>{
    socket.emit(event, payload, res=>resolve(res || {ok:true}));
  });
}

el("createBtn").onclick = async () => {
  const name = el("playerName").value.trim() || "Hôte";
  const res = await emitWithAck("createRoom", {name});
  if(!res.ok) return toast(res.error);
};
el("joinBtn").onclick = async () => {
  const name = el("playerName").value.trim() || "Joueur";
  const code = el("roomCode").value.trim().toUpperCase();
  const res = await emitWithAck("joinRoom", {name, code});
  if(!res.ok) return toast(res.error);
};
el("startBtn").onclick = async () => {
  const connectedCount = state?.players?.filter?.(p => p.connected)?.length || state?.players?.length || 0;
  if(connectedCount < 2){
    return toast("Il faut au moins 2 joueurs connectés pour lancer la partie.");
  }

  el("startBtn").textContent = "Lancement...";
  el("startBtn").disabled = true;

  // Envoi renforcé : on envoie une commande simple au serveur.
  socket.emit("forceStartGame");

  setTimeout(() => {
    if(state && !state.started){
      el("startBtn").textContent = "Lancer la partie";
      el("startBtn").disabled = false;
    }
  }, 2500);
};
el("copyCodeBtn").onclick = async () => {
  if(!state?.code) return;
  try { await navigator.clipboard.writeText(state.code); toast("Code copié !"); }
  catch { toast(`Code : ${state.code}`); }
};
el("playBtn").onclick = async () => {
  if(!selectedCardId) return toast("Choisis une carte.");
  const aceValue = el("aceValue").classList.contains("hidden") ? undefined : Number(el("aceValue").value);
  const res = await emitWithAck("playCard", {
    cardId:selectedCardId,
    announcedScore:el("scoreInput").value.trim(),
    aceValue
  });
  if(!res.ok) return toast(res.error);
  selectedCardId = null;
};
el("validateDistributionBtn").onclick = async () => {
  const res = await emitWithAck("setDistribution", {allocations:localAllocations});
  if(!res.ok) return toast(res.error);
};
el("topBottomBtn").onclick = async () => {
  const res = await emitWithAck("deathDirection", {direction:"top"});
  if(!res.ok) toast(res.error);
};
el("bottomTopBtn").onclick = async () => {
  const res = await emitWithAck("deathDirection", {direction:"bottom"});
  if(!res.ok) toast(res.error);
};
el("continueAfterDeathBtn").onclick = async () => {
  const res = await emitWithAck("finishDeath");
  if(!res.ok) toast(res.error);
};

socket.on("state", payload => {
  state = payload.room;
  me = payload.me;
  renderAll();
});
socket.on("toast", toast);
socket.on("startGameError", msg => { toast(msg); const b=el("startBtn"); if(b){ b.textContent="Lancer la partie"; b.disabled=false; } });

function renderAll(){
  if(!state || !me) return;
  if(!state.started){
    screen("lobbyScreen");
    el("lobbyCode").textContent = state.code;
    const connectedCount = state.players.filter(p => p.connected).length;
    el("hostNote").textContent = connectedCount < 2
      ? "En attente d’au moins 2 joueurs connectés."
      : "Salon prêt : clique sur Lancer la partie.";
    el("startBtn").classList.remove("hidden");
    el("startBtn").textContent = connectedCount < 2 ? "En attente de joueurs..." : "Lancer la partie";
    renderLobby();
    return;
  }
  screen("gameScreen");
  el("gameCode").textContent = state.code;
  renderPlayers();
  renderTable();
  renderHand();
  renderDistribution();
  renderDeath();
}
function renderLobby(){
  const box = el("lobbyPlayers");
  box.innerHTML = "";
  state.players.forEach((p,i)=>{
    const row = document.createElement("div");
    row.className = "joined-player";
    row.innerHTML = `<div class="avatar-mini">${AVATARS[i % AVATARS.length]}</div><strong>${p.name}</strong><span>${p.connected ? "connecté" : "déco"}</span>`;
    box.appendChild(row);
  });
}
function renderPlayers(){
  const layer = el("playersLayer");
  layer.innerHTML = "";
  const n = state.players.length;
  state.players.forEach((p,i)=>{
    const angle = -90 + (360/n)*i;
    const rad = angle * Math.PI / 180;
    const x = 50 + Math.cos(rad)*43;
    const y = 48 + Math.sin(rad)*38;
    const div = document.createElement("div");
    div.className = `player-bubble ${p.isCurrent ? "active":""} ${p.id===me.id ? "me":""}`;
    div.style.left = `${x}%`;
    div.style.top = `${y}%`;
    div.innerHTML = `
      <div class="avatar">${p.avatar}</div>
      <div class="player-name">${p.name}${p.id===me.id ? " (toi)" : ""}</div>
      <div class="player-drinks">🍺 ${p.drinks}</div>
      <div class="mini-hand">${Array.from({length:p.handCount}).map((_,k)=>`<div class="mini-card" style="--r:${(k-1.5)*7}deg"></div>`).join("")}</div>
    `;
    layer.appendChild(div);
  });
}
function renderTable(){
  const ring = el("directionRing");
  ring.classList.toggle("clockwise", state.direction === 1);
  ring.classList.toggle("counterclockwise", state.direction === -1);
  el("directionText").textContent = state.direction === 1 ? "sens horaire" : "sens anti-horaire";
  el("currentPlayerName").textContent = state.currentPlayerName || "Tour";
  if(state.lastCard){
    el("playedCard").textContent = cardLabel(state.lastCard);
    el("playedCard").className = `playing-card last-card ${cardColor(state.lastCard)}`;
  }
  el("meName").textContent = me.name;
  el("meDrinks").textContent = `🍺 ${me.drinks}`;
}
function renderHand(){
  const hand = el("currentHand");
  hand.innerHTML = "";
  const isMyTurn = state.currentPlayerId === me.id && !state.pendingDistribution && !(state.death?.active && !state.death.finished);
  me.hand.forEach(card=>{
    const div = document.createElement("div");
    div.className = `hand-card ${cardColor(card)} ${selectedCardId===card.id?"selected":""} ${isMyTurn ? "" : "disabled"}`;
    div.onclick = () => {
      if(!isMyTurn) return;
      selectedCardId = card.id;
      el("aceValue").classList.toggle("hidden", card.rank !== "A");
      renderHand();
    };
    div.innerHTML = `<div class="card-rank">${card.rank}</div><div class="card-suit">${card.suit}</div><div class="card-note">${cardNote(card)}</div>`;
    hand.appendChild(div);
  });
  el("playBtn").classList.toggle("disabled", !isMyTurn);
  el("turnHint").textContent = isMyTurn ? "C’est ton tour." : `Tour de ${state.currentPlayerName}.`;
}
function renderDistribution(){
  const modal = el("distributionModal");
  if(!state.pendingDistribution){
    modal.classList.add("hidden");
    return;
  }
  modal.classList.remove("hidden");
  const isDistributor = state.pendingDistribution.from === me.id;
  el("validateDistributionBtn").classList.toggle("hidden", !isDistributor);
  el("distributionText").textContent = isDistributor
    ? `Tu as ${state.pendingDistribution.total} gorgée(s) à répartir.`
    : `${state.pendingDistribution.fromName} distribue ${state.pendingDistribution.total} gorgée(s).`;

  if(isDistributor && Object.keys(localAllocations).length === 0){
    localAllocations = Object.fromEntries(state.players.map(p=>[p.id,0]));
  }
  if(!isDistributor) localAllocations = {};

  const list = el("distributionList");
  list.innerHTML = "";
  state.players.forEach(p=>{
    const value = isDistributor ? (localAllocations[p.id] || 0) : (state.pendingDistribution.allocations?.[p.id] || 0);
    const row = document.createElement("div");
    row.className = "distribution-row";
    row.innerHTML = `
      <strong>${p.name}</strong>
      <button class="small-btn" data-action="minus" data-id="${p.id}" ${isDistributor ? "" : "disabled"}>−</button>
      <span>${value}</span>
      <button class="small-btn" data-action="plus" data-id="${p.id}" ${isDistributor ? "" : "disabled"}>+</button>
    `;
    list.appendChild(row);
  });
  if(isDistributor){
    const total = () => Object.values(localAllocations).reduce((s,v)=>s+Number(v||0),0);
    list.querySelectorAll("button").forEach(btn=>{
      btn.onclick = () => {
        const id = btn.dataset.id;
        if(btn.dataset.action==="plus" && total() < state.pendingDistribution.total) localAllocations[id]++;
        if(btn.dataset.action==="minus" && localAllocations[id] > 0) localAllocations[id]--;
        renderDistribution();
      };
    });
  }
}
function renderDeath(){
  const modal = el("deathModal");
  if(!state.death?.active){
    modal.classList.add("hidden");
    return;
  }
  modal.classList.remove("hidden");
  const isMine = state.death.playerId === me.id;
  el("deathIntro").textContent = isMine ? "C’est ta Traversée de la Mort." : `${state.death.playerName} fait sa Traversée.`;
  el("directionChoice").classList.toggle("hidden", !isMine || state.death.locked || state.death.finished);
  el("continueAfterDeathBtn").classList.toggle("hidden", !isMine || !state.death.finished);
  el("deathInfo").textContent = state.death.message || "";

  const grid = el("deathGrid");
  grid.innerHTML = "";
  const rows = [1,4,4,4,4,1];
  const revealedMap = new Map((state.death.revealed || []).map(x=>[`${x.row}-${x.col}`, x.card]));
  rows.forEach((size,r)=>{
    if(size===1){
      const wrap = document.createElement("div");
      wrap.className = "death-row-single";
      wrap.appendChild(makeDeathCell(r,0,isMine,revealedMap));
      grid.appendChild(wrap);
    } else {
      for(let c=0;c<4;c++) grid.appendChild(makeDeathCell(r,c,isMine,revealedMap));
    }
  });
}
function makeDeathCell(r,c,isMine,revealedMap){
  const cell = document.createElement("div");
  const card = revealedMap.get(`${r}-${c}`);
  const isHead = card && HEADS.includes(card.rank);
  cell.className = `death-cell ${card ? "revealed" : ""} ${isHead ? "head" : card ? "safe" : ""} ${isMine ? "" : "disabled"}`;
  if(card) cell.dataset.card = cardLabel(card);
  cell.onclick = async () => {
    if(!isMine || card) return;
    const res = await emitWithAck("deathPick", {row:r, col:c});
    if(!res.ok) toast(res.error);
  };
  return cell;
}
function toast(msg){
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden","pop");
  void t.offsetWidth;
  t.classList.add("pop");
  setTimeout(()=>t.classList.add("hidden"), 1800);
}


// V5 mobile : aide à l’écriture du score sur téléphone
window.addEventListener("load", () => {
  const scoreInput = document.getElementById("scoreInput");
  if(scoreInput){
    scoreInput.addEventListener("touchstart", () => {
      setTimeout(() => scoreInput.focus(), 80);
    }, {passive:true});

    scoreInput.addEventListener("click", () => {
      scoreInput.focus();
    });

    scoreInput.addEventListener("keydown", (e) => {
      if(e.key === "Enter"){
        document.getElementById("playBtn")?.click();
      }
    });
  }
});
