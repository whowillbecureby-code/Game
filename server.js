const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const clean = (v, max = 18) => String(v || "").trim().slice(0, max);
const alive = room => room.players.filter(p => p.hp > 0);

function publicState(room) {
  return {
    roomName: room.name,
    hostId: room.hostId,
    started: room.started,
    currentTurn: room.currentTurn,
    players: room.players.map(p => ({
      id: p.id, name: p.name, hp: p.hp, shield: p.shield
    })),
    log: room.log.slice(-12),
    winner: room.winner
  };
}
function broadcast(room) {
  io.to(room.name).emit("state", publicState(room));
}
function say(room, message) {
  room.log.push(message);
  if (room.log.length > 30) room.log.shift();
}
function nextTurn(room) {
  const living = alive(room);
  if (living.length <= 1) {
    room.winner = living[0] ? living[0].name : null;
    room.started = false;
    if (room.winner) say(room, room.winner + " 승리!");
    return;
  }
  const currentIndex = room.players.findIndex(p => p.id === room.currentTurn);
  for (let step = 1; step <= room.players.length; step++) {
    const candidate = room.players[(currentIndex + step + room.players.length) % room.players.length];
    if (candidate && candidate.hp > 0) {
      room.currentTurn = candidate.id;
      return;
    }
  }
}
function leaveRoom(socket) {
  const roomName = socket.data.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  socket.data.roomName = null;
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
  if (room.players.length === 0) {
    rooms.delete(roomName);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players[0].id;
  if (room.started && room.currentTurn === socket.id) nextTurn(room);
  say(room, "플레이어 한 명이 나갔습니다.");
  broadcast(room);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ roomName, playerName } = {}) => {
    const name = clean(roomName, 24);
    const nick = clean(playerName, 14) || "플레이어";
    if (!name) return socket.emit("notice", "방 이름을 입력해 주세요.");
    if (rooms.has(name)) return socket.emit("notice", "이미 존재하는 방 이름이에요.");
    const room = {
      name, hostId: socket.id, started: false, currentTurn: null,
      players: [{ id: socket.id, name: nick, hp: 30, shield: 0 }],
      log: [nick + "님이 방을 만들었습니다."], winner: null
    };
    rooms.set(name, room);
    socket.join(name);
    socket.data.roomName = name;
    socket.emit("joined", { roomName: name, playerId: socket.id });
    broadcast(room);
  });

  socket.on("joinRoom", ({ roomName, playerName } = {}) => {
    const name = clean(roomName, 24);
    const nick = clean(playerName, 14) || "플레이어";
    const room = rooms.get(name);
    if (!room) return socket.emit("notice", "해당 방을 찾을 수 없어요.");
    if (room.started) return socket.emit("notice", "이미 게임이 시작된 방이에요.");
    if (room.players.length >= 4) return socket.emit("notice", "방 인원이 가득 찼어요. (최대 4명)");
    if (room.players.some(p => p.name === nick)) return socket.emit("notice", "이미 사용 중인 닉네임이에요.");
    room.players.push({ id: socket.id, name: nick, hp: 30, shield: 0 });
    socket.join(name);
    socket.data.roomName = name;
    socket.emit("joined", { roomName: name, playerId: socket.id });
    say(room, nick + "님이 참가했습니다.");
    broadcast(room);
  });

  socket.on("startGame", () => {
    const room = rooms.get(socket.data.roomName);
    if (!room) return;
    if (socket.id !== room.hostId) return socket.emit("notice", "방장만 시작할 수 있어요.");
    if (room.players.length < 2) return socket.emit("notice", "최소 2명이 있어야 시작할 수 있어요.");
    room.started = true;
    room.winner = null;
    room.players.forEach(p => { p.hp = 30; p.shield = 0; });
    room.currentTurn = room.players[0].id;
    say(room, "게임 시작! 마지막까지 살아남으세요.");
    broadcast(room);
  });

  socket.on("playCard", ({ card, targetId } = {}) => {
    const room = rooms.get(socket.data.roomName);
    if (!room || !room.started) return;
    if (room.currentTurn !== socket.id) return socket.emit("notice", "아직 네 차례가 아니에요.");
    const actor = room.players.find(p => p.id === socket.id);
    if (!actor || actor.hp <= 0) return;
    if (card === "attack") {
      const target = room.players.find(p => p.id === targetId && p.hp > 0 && p.id !== socket.id);
      if (!target) return socket.emit("notice", "공격할 상대를 선택해 주세요.");
      const damage = 8;
      const blocked = Math.min(target.shield, damage);
      target.shield -= blocked;
      target.hp = Math.max(0, target.hp - (damage - blocked));
      say(room, actor.name + "님이 " + target.name + "님에게 공격! 피해 " + (damage - blocked) + " (방어 " + blocked + ")");
      if (target.hp === 0) say(room, target.name + "님 탈락!");
    } else if (card === "defend") {
      actor.shield = Math.min(12, actor.shield + 6);
      say(room, actor.name + "님이 방어 태세! 보호막 +6");
    } else if (card === "heal") {
      const before = actor.hp;
      actor.hp = Math.min(30, actor.hp + 7);
      if (actor.hp === before) return socket.emit("notice", "체력이 이미 가득 찼어요.");
      say(room, actor.name + "님이 회복! 체력 +" + (actor.hp - before));
    } else {
      return socket.emit("notice", "알 수 없는 카드예요.");
    }
    nextTurn(room);
    broadcast(room);
  });

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

server.listen(PORT, () => console.log("Arena server listening on " + PORT));
