
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();

const CARDS = {
  strike: { name: "검격", type: "attack", damage: 8, text: "적 한 명에게 8 피해" },
  heavy: { name: "강타", type: "attack", damage: 14, text: "적 한 명에게 14 피해" },
  guard: { name: "수호", type: "self", shield: 10, text: "자신에게 보호막 10 부여" },
  heal: { name: "치유", type: "heal", amount: 9, text: "자신의 체력 9 회복" },
  poison: { name: "맹독", type: "poison", damage: 3, text: "적 한 명을 2턴 중독시킴 (행동 후 3 피해)" },
  drain: { name: "흡수", type: "drain", damage: 5, text: "적에게 5 피해, 자신의 체력 5 회복" },
  reflect: { name: "반사", type: "self", text: "다음 공격 1회 반사, 공격자에게 5 피해" },
  chaos: { name: "혼돈의 일격", type: "attack", random: true, text: "적 한 명에게 1~25 랜덤 피해" },
  lightning: { name: "낙뢰", type: "all", damage: 5, text: "모든 생존 적에게 각각 5 피해" },
  cleanse: { name: "정화", type: "cleanse", amount: 5, text: "중독 제거 + 자신의 체력 5 회복" },
  shield_breaker: { name: "쉴드 브레이커", type: "special", text: "상대 한 명의 보호막을 전부 제거" }
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

  // 각 플레이어의 첫 턴에는 시작 손패를 그대로 사용하고,
  // 두 번째 턴부터 턴이 돌아올 때 카드 1장을 보충한다.
  if (!player.hasStartedTurn) {
    player.hasStartedTurn = true;
  } else if (player.hand.length < 5) {
    const card = drawCard(player);

    if (card) {
      player.hand.push(card);
    }
  }
}

// 게임 상태 전송
function sendStates(room) {
  room.players.forEach(player => {
    if (player.isBot) return;
    io.to(player.id).emit("gameState", {
      playerId: player.id,
      isHost: room.host === player.id,
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


function applyCard(room, player, cardId, targetId) {
  const index = player.hand.indexOf(cardId);
  if (index < 0 || !CARDS[cardId] || player.hp <= 0) return false;
  const card = CARDS[cardId];
  const needsTarget = ["attack", "poison", "drain", "special"].includes(card.type);
  const target = needsTarget
    ? room.players.find(p => p.id === targetId && p.hp > 0 && p.id !== player.id)
    : null;
  if (needsTarget && !target) return false;

  function damage(targetPlayer, amount) {
    if (!targetPlayer || targetPlayer.hp <= 0) return;
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
    damage(target, card.random ? Math.floor(Math.random() * 25) + 1 : card.damage);
  }
  if (card.type === "self") {
    if (cardId === "guard") player.shield += card.shield;
    if (cardId === "reflect") player.reflect = true;
  }
  if (card.type === "heal") player.hp = Math.min(100, player.hp + card.amount);
  if (card.type === "poison") target.poison = 2;
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

  player.hand.splice(index, 1);
  room.log.push(player.name + " 님이 " + card.name + " 사용");
  if (room.log.length > 30) room.log.shift();
  if (player.hp > 0 && player.poison > 0) {
    damage(player, 3);
    player.poison--;
  }
  nextTurn(room);
  return true;
}

function chooseBotMove(room, bot) {
  const livingEnemies = room.players.filter(p => p.hp > 0 && p.id !== bot.id);
  const target = livingEnemies.slice().sort((a, b) => a.hp + a.shield - (b.hp + b.shield))[0];
  const difficulty = room.difficulty || "normal";
  const cards = bot.hand;

  const priority = cardId => {
    const c = CARDS[cardId];
    if (cardId === "cleanse" && bot.poison > 0) return 120;
    if ((cardId === "heal" || cardId === "drain") && bot.hp <= (difficulty === "hard" ? 65 : 48)) return 100;
    if (cardId === "guard" && bot.shield < 5 && bot.hp < 85) return 65;
    if (cardId === "reflect" && !bot.reflect && livingEnemies.length) return 55;
    if (cardId === "lightning" && livingEnemies.length >= 2) return 75;\n    if (cardId === "shield_breaker" && target?.shield > 0) return 80;
    if (["strike", "heavy", "chaos", "poison", "drain"].includes(cardId) && target) {
      let score = cardId === "heavy" ? 70 : cardId === "drain" ? 68 : cardId === "poison" ? 62 : cardId === "chaos" ? 58 : 50;
      if (target.hp <= (c.damage || 8)) score += 18;
      if (cardId === "poison" && target.poison > 0) score -= 20;
      return score;
    }
    if (cardId === "heal" && bot.hp < 92) return 45;
    if (cardId === "guard") return 25;
    return 5;
  };

  const ranked = cards.map(id => ({ id, score: priority(id) }))
    .sort((a, b) => b.score - a.score);
  const chosen = difficulty === "easy"
    ? cards[Math.floor(Math.random() * cards.length)]
    : difficulty === "normal" && Math.random() < 0.35
      ? cards[Math.floor(Math.random() * cards.length)]
      : ranked[0]?.id;

  const chosenCard = CARDS[chosen];
  const chosenTarget = chosenCard && ["attack", "poison", "drain", "special"].includes(chosenCard.type)
    ? target?.id
    : null;
  return { cardId: chosen, targetId: chosenTarget };
}

function scheduleBotTurn(room) {
  if (!room || !room.solo || room.status !== "playing") return;
  const current = room.players[room.turn];
  if (!current?.isBot) return;

  setTimeout(() => {
    if (room.status !== "playing" || room.players[room.turn]?.id !== current.id) return;
    const move = chooseBotMove(room, current);
    if (!move.cardId || !applyCard(room, current, move.cardId, move.targetId)) {
      // A bot should always have a legal move; recover safely if state changed.
      nextTurn(room);
    }
    sendStates(room);
    scheduleBotTurn(room);
  }, 650);
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


  // 싱글플레이: 실제 서버 전투 규칙을 사용하는 봇 대전
  socket.on("createSoloGame", ({ playerName, botCount = 1, difficulty = "normal" } = {}) => {
    const existingRoom = rooms.get(socket.data.roomName);
    if (existingRoom) {
      socket.emit("errorMessage", "이미 참가 중인 방이 있어. 현재 방을 나간 뒤 시작해 줘.");
      return;
    }

    if (!playerName || ![1, 2, 3].includes(Number(botCount)) ||
        !["easy", "normal", "hard"].includes(difficulty)) {
      socket.emit("errorMessage", "싱글플레이 설정을 확인해 줘.");
      return;
    }

    const roomName = "solo-" + socket.id;
    const players = [{
      id: socket.id, name: playerName, hp: 100, shield: 0,
      poison: 0, reflect: false, hand: [], isBot: false
    }];

    for (let i = 0; i < Number(botCount); i++) {
      players.push({
        id: "bot-" + socket.id + "-" + i,
        name: ["전투 봇", "전략 봇", "도전 봇"][i],
        hp: 100, shield: 0, poison: 0, reflect: false,
        hand: [], isBot: true
      });
    }

    const room = {
      name: roomName, host: socket.id, players,
      turn: 0, status: "playing", winner: null,
      difficulty, solo: true,
      log: ["싱글플레이가 시작됐어. 봇들과 승부해 봐!"]
    };

    players.forEach(p => {
      for (let i = 0; i < 4; i++) {
        const card = drawCard(p);
        if (card) p.hand.push(card);
      }
    });
    players[0].hasStartedTurn = true;

    rooms.set(roomName, room);
    socket.join(roomName);
    socket.data.roomName = roomName;
    socket.emit("roomJoined", { roomName, host: true, solo: true });
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
      p.hasStartedTurn = false;

      for (let i = 0; i < 4; i++) {
        const card = drawCard(p);
        if (card) p.hand.push(card);
      }
    });
    room.players[0].hasStartedTurn = true;

    sendStates(room);
  });


  // 카드 사용
  socket.on("playCard", (data = {}) => {
    const { cardId, targetId } = data;
    const room = rooms.get(socket.data.roomName);

    if (!room || room.status !== "playing") {
      socket.emit("errorMessage", "게임이 진행 중이 아니야.");
      return;
    }
    const player = room.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit("errorMessage", "플레이어를 찾을 수 없어.");
      return;
    }
    if (room.players[room.turn]?.id !== socket.id) {
      socket.emit("errorMessage", "네 턴이 아니야.");
      return;
    }
    if (player.hp <= 0) {
      socket.emit("errorMessage", "탈락한 플레이어야.");
      return;
    }
    if (!player.hand.includes(cardId)) {
      socket.emit("errorMessage", "손패에 없는 카드야.");
      return;
    }
    if (!applyCard(room, player, cardId, targetId)) {
      socket.emit("errorMessage", "카드 대상을 다시 선택해 줘.");
      return;
    }
    sendStates(room);
    scheduleBotTurn(room);
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

    // A solo match has no other human to preserve; stop pending bot turns on exit.
    if (room.solo) {
      room.status = "finished";
      rooms.delete(roomName);
      return;
    }

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
      // A non-active player can leave while the current player remains.
      // Check the win condition after every departure, not only when the
      // departing player owned the current turn.
      const alive = alivePlayers(room);

      if (alive.length <= 1) {
        room.status = "finished";
        room.winner = alive[0]?.name || "없음";
      } else if (wasCurrentTurn) {
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

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Export the live server objects so automated integration tests can exercise
// the real Socket.IO handlers without exposing a test-only network endpoint.
module.exports = { server, io, rooms, CARDS };
