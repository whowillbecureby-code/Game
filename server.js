
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();

const CARDS = {
  strike: { name: "검격", type: "attack", damage: 8 },
  heavy: { name: "강타", type: "attack", damage: 14 },
  guard: { name: "수호", type: "self", shield: 10 },
  heal: { name: "치유", type: "heal", amount: 9 },
  poison: { name: "맹독", type: "poison", damage: 3 },
  drain: { name: "흡수", type: "drain", damage: 5 },
  reflect: { name: "반사", type: "self" },
  chaos: { name: "혼돈의 일격", type: "attack", random: true },
  lightning: { name: "낙뢰", type: "all", damage: 5 },
  cleanse: { name: "정화", type: "cleanse", amount: 5 }
};

function drawCard(player) {
  const keys = Object.keys(CARDS);
  return keys[Math.floor(Math.random() * keys.length)];
}

function alivePlayers(room) {
  return room.players.filter(p => p.hp > 0);
}

function nextTurn(room) {
  if (alivePlayers(room).length <= 1) {
    room.status = "finished";
    room.winner = alivePlayers(room)[0]?.name || "없음";
    return;
  }

  let count = 0;
  do {
    room.turn = (room.turn + 1) % room.players.length;
    count++;
  } while (
    room.players[room.turn].hp <= 0 &&
    count <= room.players.length
  );

  const player = room.players[room.turn];
  if (player.hand.length < 5) {
    player.hand.push(drawCard(player));
  }
}

function sendStates(room) {
  room.players.forEach(player => {
    io.to(player.id).emit("gameState", {
      roomName: room.name,
      status: room.status,
      turn: room.players[room.turn]?.id,
      winner: room.winner,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        hp: p.hp,
        shield: p.shield,
        poison: p.poison,
        alive: p.hp > 0
      })),
      hand: player.hand.map(id => ({
        id,
        ...CARDS[id]
      }))
    });
  });
}

io.on("connection", socket => {
  socket.on("createRoom", ({ roomName, playerName }) => {
    if (!roomName || !playerName || rooms.has(roomName)) {
      socket.emit("errorMessage", "방 이름이 이미 있거나 입력이 잘못됐어.");
      return;
    }

    const room = {
      name: roomName,
      host: socket.id,
      players: [{
        id: socket.id,
        name: playerName,
        hp: 100,
        shield: 0,
        poison: 0,
        hand: []
      }],
      turn: 0,
      status: "waiting",
      winner: null
    };

    rooms.set(roomName, room);
    socket.join(roomName);
    socket.data.roomName = roomName;
    socket.emit("roomJoined", { roomName, host: true });
    sendStates(room);
  });

  socket.on("joinRoom", ({ roomName, playerName }) => {
    const room = rooms.get(roomName);

    if (!room || room.status !== "waiting" || room.players.length >= 4) {
      socket.emit("errorMessage", "참가할 수 없는 방이야.");
      return;
    }

    room.players.push({
      id: socket.id,
      name: playerName,
      hp: 100,
      shield: 0,
      poison: 0,
      hand: []
    });

    socket.join(roomName);
    socket.data.roomName = roomName;
    socket.emit("roomJoined", { roomName, host: false });
    sendStates(room);
  });

  socket.on("startGame", () => {
    const room = rooms.get(socket.data.roomName);
    if (!room || room.host !== socket.id ||
        room.status !== "waiting" || room.players.length < 2) return;

    room.status = "playing";
    room.players.forEach(p => {
      p.hand = [drawCard(p), drawCard(p), drawCard(p)];
    });

    sendStates(room);
  });

  socket.on("playCard", ({ cardId, targetId }) => {
    const room = rooms.get(socket.data.roomName);
    if (!room || room.status !== "playing") return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || room.players[room.turn].id !== socket.id) return;

    const index = player.hand.indexOf(cardId);
    if (index === -1) return;

    const card = CARDS[cardId];
    const target = room.players.find(p => p.id === targetId && p.hp > 0);

    // 공격·맹독·흡수만 상대 대상을 필요로 함
    if (["attack", "poison", "drain"].includes(card.type) &&
        (!target || target.id === player.id)) return;

    function damage(targetPlayer, amount) {
      if (targetPlayer.shield > 0) {
        const blocked = Math.min(targetPlayer.shield, amount);
        targetPlayer.shield -= blocked;
        amount -= blocked;
      }

      targetPlayer.hp = Math.max(0, targetPlayer.hp - amount);

      if (targetPlayer.reflect && amount > 0) {
        targetPlayer.reflect = false;
        player.hp = Math.max(0, player.hp - 5);
      }
    }

    if (card.type === "attack") {
      damage(target, card.random
        ? Math.floor(Math.random() * 19)
        : card.damage);
    }

    if (card.type === "self") {
      if (cardId === "guard") player.shield += card.shield;
      if (cardId === "reflect") player.reflect = true;
    }

    // 치유는 자기 자신에게 적용
    if (card.type === "heal") {
      player.hp = Math.min(100, player.hp + card.amount);
    }

    if (card.type === "poison") {
      target.poison = 2;
    }

    if (card.type === "drain") {
      damage(target, card.damage);
      player.hp = Math.min(100, player.hp + 5);
    }

    if (card.type === "all") {
      room.players.forEach(p => {
        if (p.id !== player.id && p.hp > 0) damage(p, card.damage);
      });
    }

    if (card.type === "cleanse") {
      player.poison = 0;
      player.hp = Math.min(100, player.hp + card.amount);
    }

    // 사용한 카드를 제거하고 턴 진행
    player.hand.splice(index, 1);

    room.players.forEach(p => {
      if (p.hp > 0 && p.poison > 0) {
        damage(p, 3);
        p.poison--;
      }
    });

    nextTurn(room);
    sendStates(room);
  });

  socket.on("disconnect", () => {
    const roomName = socket.data.roomName;
    const room = rooms.get(roomName);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(roomName);
    } else {
      if (room.host === socket.id) room.host = room.players[0].id;

      if (room.status === "playing") {
        room.turn = Math.max(0, room.turn - 1);
        nextTurn(room);
      }

      sendStates(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
