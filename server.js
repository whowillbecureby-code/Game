
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

// 중복되지 않는 카드 뽑기
function drawCard(player) {
  const availableCards = Object.keys(CARDS).filter(
    id => !player.hand.includes(id)
  );

  if (availableCards.length === 0) return null;

  return availableCards[
    Math.floor(Math.random() * availableCards.length)
  ];
}

// 생존 플레이어
function alivePlayers(room) {
  return room.players.filter(p => p.hp > 0);
}

// 다음 턴
function nextTurn(room) {
  const alive = alivePlayers(room);

  if (alive.length <= 1) {
    room.status = "finished";
    room.winner = alive[0]?.name || "없음";
    return;
  }

  let count = 0;

  do {
    room.turn = (room.turn + 1) % room.players.length;
    count++;
  } while (
    room.players[room.turn].hp <= 0 &&
    count < room.players.length
  );

  const player = room.players[room.turn];

  // 최대 5장, 손패 중복 방지
  if (player.hand.length < 5) {
    const card = drawCard(player);

    if (card) {
      player.hand.push(card);
    }
  }
}

// 게임 상태 전송
function sendStates(room) {
  room.players.forEach(player => {
    io.to(player.id).emit("gameState", {
      playerId: player.id,
      roomName: room.name,
      status: room.status,
      turn: room.players[room.turn]?.id,
      winner: room.winner,
      log: room.log || [],

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

  // 방 만들기
  socket.on("createRoom", ({ roomName, playerName } = {}) => {
    if (
      !roomName ||
      !playerName ||
      rooms.has(roomName)
    ) {
      socket.emit(
        "errorMessage",
        "방 이름이 이미 있거나 입력이 잘못됐어."
      );
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
        reflect: false,
        hand: []
      }],

      turn: 0,
      status: "waiting",
      winner: null,
      log: ["방이 만들어졌어."]
    };

    rooms.set(roomName, room);

    socket.join(roomName);
    socket.data.roomName = roomName;

    socket.emit("roomJoined", {
      roomName,
      host: true
    });

    sendStates(room);
  });

  // 방 참가
  socket.on("joinRoom", ({ roomName, playerName } = {}) => {
    const room = rooms.get(roomName);

    if (
      !room ||
      room.status !== "waiting" ||
      room.players.length >= 4 ||
      !playerName
    ) {
      socket.emit(
        "errorMessage",
        "참가할 수 없는 방이야."
      );
      return;
    }

    room.players.push({
      id: socket.id,
      name: playerName,
      hp: 100,
      shield: 0,
      poison: 0,
      reflect: false,
      hand: []
    });
    room.log.push(playerName + " 님이 방에 참가했어.");

    socket.join(roomName);
    socket.data.roomName = roomName;

    socket.emit("roomJoined", {
      roomName,
      host: false
    });

    sendStates(room);
  });

  // 게임 시작
  socket.on("startGame", () => {
    const room = rooms.get(socket.data.roomName);

    if (
      !room ||
      room.host !== socket.id ||
      room.status !== "waiting" ||
      room.players.length < 2
    ) {
      return;
    }

    room.status = "playing";
    room.turn = 0;
    room.winner = null;
    room.log.push("게임이 시작됐어. " + room.players[0].name + " 님부터 시작!");

    room.players.forEach(p => {
      p.hand = [];

      for (let i = 0; i < 3; i++) {
        const card = drawCard(p);
        if (card) p.hand.push(card);
      }
    });

    sendStates(room);
  });

  // 카드 사용
  socket.on("playCard", (data = {}) => {
    const { cardId, targetId } = data;

    console.log("카드 요청:", {
      player: socket.id,
      cardId,
      targetId
    });

    const room = rooms.get(socket.data.roomName);

    if (!room || room.status !== "playing") {
      socket.emit("errorMessage", "게임이 진행 중이 아니야.");
      return;
    }

    const player = room.players.find(
      p => p.id === socket.id
    );

    if (!player) {
      socket.emit("errorMessage", "플레이어를 찾을 수 없어.");
      return;
    }

    if (
      !room.players[room.turn] ||
      room.players[room.turn].id !== socket.id
    ) {
      socket.emit("errorMessage", "네 턴이 아니야.");
      return;
    }

    if (player.hp <= 0) {
      socket.emit("errorMessage", "탈락한 플레이어야.");
      return;
    }

    const index = player.hand.indexOf(cardId);

    if (index === -1) {
      socket.emit("errorMessage", "손패에 없는 카드야.");
      return;
    }

    const card = CARDS[cardId];

    if (!card) {
      socket.emit("errorMessage", "존재하지 않는 카드야.");
      return;
    }

    const needsTarget = [
      "attack",
      "poison",
      "drain"
    ].includes(card.type);

    let target = null;

    if (needsTarget) {
      target = room.players.find(
        p => p.id === targetId && p.hp > 0
      );

      if (!target || target.id === player.id) {
        socket.emit(
          "errorMessage",
          "공격 대상을 다시 선택해 줘."
        );
        return;
      }
    }

    // 피해 계산
    function damage(targetPlayer, amount) {
      if (!targetPlayer || targetPlayer.hp <= 0) return;

      if (targetPlayer.shield > 0) {
        const blocked = Math.min(
          targetPlayer.shield,
          amount
        );

        targetPlayer.shield -= blocked;
        amount -= blocked;
      }

      targetPlayer.hp = Math.max(
        0,
        targetPlayer.hp - amount
      );

      if (targetPlayer.reflect && amount > 0) {
        targetPlayer.reflect = false;

        player.hp = Math.max(
          0,
          player.hp - 5
        );
      }
    }

    // 일반 공격 및 혼돈의 일격
    if (card.type === "attack") {
      const amount = card.random
        ? Math.floor(Math.random() * 25) + 1
        : card.damage;

      console.log("공격 데미지:", amount);

      damage(target, amount);
    }

    // 방어 및 반사
    if (card.type === "self") {
      if (cardId === "guard") {
        player.shield += card.shield;
      }

      if (cardId === "reflect") {
        player.reflect = true;
      }
    }

    // 치유
    if (card.type === "heal") {
      player.hp = Math.min(
        100,
        player.hp + card.amount
      );
    }

    // 맹독
    if (card.type === "poison") {
      target.poison = 2;
    }

    // 흡수
    if (card.type === "drain") {
      damage(target, card.damage);

      player.hp = Math.min(
        100,
        player.hp + 5
      );
    }

    // 전체 공격
    if (card.type === "all") {
      room.players.forEach(p => {
        if (p.id !== player.id && p.hp > 0) {
          damage(p, card.damage);
        }
      });
    }

    // 정화
    if (card.type === "cleanse") {
      player.poison = 0;

      player.hp = Math.min(
        100,
        player.hp + card.amount
      );
    }

    // 사용한 카드 제거
    player.hand.splice(index, 1);

    const actionText = player.name + " 님이 " + card.name + " 사용";
    console.log(actionText);
    room.log.push(actionText);
    if (room.log.length > 30) room.log.shift();

    // 현재 플레이어의 독 데미지
    if (player.hp > 0 && player.poison > 0) {
      damage(player, 3);
      player.poison--;
    }

    // 다음 턴
    nextTurn(room);

    // 모든 플레이어에게 최신 상태 전송
    sendStates(room);

    console.log("다음 턴:", room.players[room.turn]?.name);
  });

  // 접속 종료
  socket.on("disconnect", () => {
    const roomName = socket.data.roomName;
    const room = rooms.get(roomName);

    if (!room) return;

    const removedIndex = room.players.findIndex(
      p => p.id === socket.id
    );

    if (removedIndex === -1) return;

    const wasPlaying = room.status === "playing";
    const wasCurrentTurn = removedIndex === room.turn;
    const leavingName = room.players[removedIndex].name;

    room.players.splice(removedIndex, 1);
    room.log.push(leavingName + " 님이 접속을 종료했어.");

    if (room.players.length === 0) {
      rooms.delete(roomName);
      return;
    }

    if (room.host === socket.id) {
      room.host = room.players[0].id;
    }

    if (wasPlaying) {
      if (wasCurrentTurn) {
        room.turn = removedIndex - 1;
        nextTurn(room);
      } else if (removedIndex < room.turn) {
        room.turn--;
      }
    }

    sendStates(room);
  });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
