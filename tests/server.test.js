const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { io: connect } = require("socket.io-client");
const { server, io, rooms, CARDS } = require("../server");

let baseUrl;
let roomSequence = 0;

function waitFor(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error("Timed out waiting for " + event));
    }, timeout);
    function onEvent(value) {
      clearTimeout(timer);
      resolve(value);
    }
    socket.once(event, onEvent);
  });
}

async function createMatch(names = ["Host", "Guest"], { start = true } = {}) {
  const roomName = "unit-room-" + (++roomSequence);
  const clients = names.map(() => connect(baseUrl, {
    transports: ["websocket"],
    reconnection: false
  }));

  await Promise.all(clients.map(client =>
    client.connected ? Promise.resolve() : waitFor(client, "connect")
  ));

  const hostJoined = waitFor(clients[0], "roomJoined");
  clients[0].emit("createRoom", {
    roomName,
    playerName: names[0]
  });
  await hostJoined;

  for (let i = 1; i < clients.length; i++) {
    const joined = waitFor(clients[i], "roomJoined");
    clients[i].emit("joinRoom", {
      roomName,
      playerName: names[i]
    });
    await joined;
  }

  if (start) {
    const initialStates = clients.map(client => waitFor(client, "gameState"));
    clients[0].emit("startGame");
    await Promise.all(initialStates);
  }

  return { roomName, room: rooms.get(roomName), clients };
}

async function play(clients, actorIndex, cardId, targetId) {
  const states = clients.map(client => waitFor(client, "gameState"));
  clients[actorIndex].emit("playCard", { cardId, targetId });
  await Promise.all(states);
}

async function closeClients(clients) {
  await Promise.all(clients.map(client => new Promise(resolve => {
    if (!client.connected) return resolve();
    client.once("disconnect", resolve);
    client.disconnect();
  })));
}

before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  await new Promise(resolve => io.close(resolve));
});

test("the server exposes the complete ten-card catalog", () => {
  assert.deepEqual(Object.keys(CARDS), [
    "strike", "heavy", "guard", "heal", "poison",
    "drain", "reflect", "chaos", "lightning", "cleanse"
  ]);
});

test("strike and heavy apply their exact damage values", async () => {
  const match = await createMatch();
  try {
    match.room.players[0].hand = ["strike"];
    await play(match.clients, 0, "strike", match.clients[1].id);
    assert.equal(match.room.players[1].hp, 92);

    match.room.players[1].hand = ["guard"];
    await play(match.clients, 1, "guard");
    match.room.players[0].hand = ["heavy"];
    await play(match.clients, 0, "heavy", match.clients[1].id);
    assert.equal(match.room.players[1].hp, 88);
  } finally {
    await closeClients(match.clients);
  }
});

test("guard creates a ten-point shield and incoming damage consumes shield first", async () => {
  const match = await createMatch();
  try {
    match.room.players[0].hand = ["guard"];
    await play(match.clients, 0, "guard");
    assert.equal(match.room.players[0].shield, 10);

    match.room.players[1].hand = ["strike"];
    await play(match.clients, 1, "strike", match.clients[0].id);
    assert.equal(match.room.players[0].shield, 2);
    assert.equal(match.room.players[0].hp, 100);
  } finally {
    await closeClients(match.clients);
  }
});

test("healing is capped at one hundred HP", async () => {
  const match = await createMatch();
  try {
    match.room.players[0].hp = 96;
    match.room.players[0].hand = ["heal"];
    await play(match.clients, 0, "heal");
    assert.equal(match.room.players[0].hp, 100);
  } finally {
    await closeClients(match.clients);
  }
});

test("poison deals three damage on each of the target's next two actions", async () => {
  const match = await createMatch();
  try {
    match.room.players[0].hand = ["poison"];
    await play(match.clients, 0, "poison", match.clients[1].id);
    assert.equal(match.room.players[1].poison, 2);

    match.room.players[1].hand = ["strike"];
    await play(match.clients, 1, "strike", match.clients[0].id);
    assert.equal(match.room.players[1].hp, 97);
    assert.equal(match.room.players[1].poison, 1);

    match.room.players[0].hand = ["guard"];
    await play(match.clients, 0, "guard");
    match.room.players[1].hand = ["strike"];
    await play(match.clients, 1, "strike", match.clients[0].id);
    assert.equal(match.room.players[1].hp, 94);
    assert.equal(match.room.players[1].poison, 0);
  } finally {
    await closeClients(match.clients);
  }
});

test("drain damages the target and heals the user by five", async () => {
  const match = await createMatch();
  try {
    match.room.players[0].hp = 50;
    match.room.players[0].hand = ["drain"];
    await play(match.clients, 0, "drain", match.clients[1].id);
    assert.equal(match.room.players[1].hp, 95);
    assert.equal(match.room.players[0].hp, 55);
  } finally {
    await closeClients(match.clients);
  }
});

test("reflect returns five damage to the attacker and is consumed", async () => {
  const match = await createMatch();
  try {
    match.room.players[1].reflect = true;
    match.room.players[0].hand = ["strike"];
    await play(match.clients, 0, "strike", match.clients[1].id);
    assert.equal(match.room.players[1].hp, 92);
    assert.equal(match.room.players[0].hp, 95);
    assert.equal(match.room.players[1].reflect, false);
  } finally {
    await closeClients(match.clients);
  }
});

test("chaos damage stays within its one-to-twenty-five range", async () => {
  const match = await createMatch();
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.999999;
    match.room.players[0].hand = ["chaos"];
    await play(match.clients, 0, "chaos", match.clients[1].id);
    assert.equal(match.room.players[1].hp, 75);
  } finally {
    Math.random = originalRandom;
    await closeClients(match.clients);
  }
});

test("lightning damages every living opponent and not its user", async () => {
  const match = await createMatch(["Host", "Guest", "Third"]);
  try {
    match.room.players[0].hand = ["lightning"];
    await play(match.clients, 0, "lightning");
    assert.equal(match.room.players[0].hp, 100);
    assert.equal(match.room.players[1].hp, 95);
    assert.equal(match.room.players[2].hp, 95);
  } finally {
    await closeClients(match.clients);
  }
});

test("cleanse removes poison before poison damage and heals five", async () => {
  const match = await createMatch();
  try {
    match.room.players[0].hp = 80;
    match.room.players[0].poison = 2;
    match.room.players[0].hand = ["cleanse"];
    await play(match.clients, 0, "cleanse");
    assert.equal(match.room.players[0].hp, 85);
    assert.equal(match.room.players[0].poison, 0);
  } finally {
    await closeClients(match.clients);
  }
});

test("a lethal attack ends the match and declares the sole survivor", async () => {
  const match = await createMatch();
  try {
    match.room.players[1].hp = 8;
    match.room.players[0].hand = ["strike"];
    await play(match.clients, 0, "strike", match.clients[1].id);
    assert.equal(match.room.status, "finished");
    assert.equal(match.room.winner, "Host");
    assert.equal(match.room.players[1].hp, 0);
  } finally {
    await closeClients(match.clients);
  }
});

test("a non-active player's disconnect still ends a two-player match", async () => {
  const match = await createMatch();
  try {
    const hostState = waitFor(match.clients[0], "gameState");
    match.clients[1].disconnect();
    await hostState;
    assert.equal(match.room.status, "finished");
    assert.equal(match.room.winner, "Host");
  } finally {
    await closeClients(match.clients);
  }
});

test("disconnecting the active player also declares the remaining player winner", async () => {
  const match = await createMatch();
  try {
    match.room.turn = 1;
    const hostState = waitFor(match.clients[0], "gameState");
    match.clients[1].disconnect();
    await hostState;
    assert.equal(match.room.status, "finished");
    assert.equal(match.room.winner, "Host");
  } finally {
    await closeClients(match.clients);
  }
});

test("a four-player turn skips eliminated players", async () => {
  const match = await createMatch(["Host", "Guest", "Third", "Fourth"]);
  try {
    match.room.players[1].hp = 0;
    match.room.players[0].hand = ["guard"];
    await play(match.clients, 0, "guard");
    assert.equal(match.room.players[match.room.turn].name, "Third");
  } finally {
    await closeClients(match.clients);
  }
});

test("a player cannot play out of turn", async () => {
  const match = await createMatch();
  try {
    const error = waitFor(match.clients[1], "errorMessage");
    match.clients[1].emit("playCard", { cardId: "strike", targetId: match.clients[0].id });
    assert.match(await error, /네 턴이 아니야/);
    assert.equal(match.room.players[0].hp, 100);
    assert.equal(match.room.players[1].hp, 100);
  } finally {
    await closeClients(match.clients);
  }
});

test("room capacity is limited to four players", async () => {
  const match = await createMatch(["Host", "Guest", "Third", "Fourth"], { start: false });
  const fifth = connect(baseUrl, { transports: ["websocket"], reconnection: false });
  try {
    if (!fifth.connected) await waitFor(fifth, "connect");
    const error = waitFor(fifth, "errorMessage");
    fifth.emit("joinRoom", { roomName: match.roomName, playerName: "Fifth" });
    assert.match(await error, /참가할 수 없는 방이야/);
    assert.equal(match.room.players.length, 4);
  } finally {
    await closeClients([...match.clients, fifth]);
  }
});

test("a complete two-player match reaches a winner through normal card turns", async () => {
  const originalRandom = Math.random;
  let match;
  try {
    // Stable draws make the test reproducible; both players still play through
    // the actual Socket.IO turn and damage handlers until the match ends.
    Math.random = () => 0;
    match = await createMatch();
    let turns = 0;

    while (match.room.status === "playing" && turns < 40) {
      const actorIndex = match.room.turn;
      const targetIndex = actorIndex === 0 ? 1 : 0;
      assert.ok(match.room.players[actorIndex].hand.includes("strike"));
      await play(
        match.clients,
        actorIndex,
        "strike",
        match.clients[targetIndex].id
      );
      turns++;
    }

    assert.ok(turns > 0 && turns < 40, "the match should finish within forty turns");
    assert.equal(match.room.status, "finished");
    assert.ok(["Host", "Guest"].includes(match.room.winner));
    assert.equal(match.room.players.filter(player => player.hp > 0).length, 1);
    assert.equal(match.room.players.filter(player => player.hp === 0).length, 1);
  } finally {
    Math.random = originalRandom;
    if (match) await closeClients(match.clients);
  }
});

test("poison damage is absorbed by an active shield", async () => {
  const match = await createMatch();
  try {
    match.room.players[1].poison = 1;
    match.room.players[1].shield = 3;
    match.room.players[1].hand = ["strike"];
    await play(match.clients, 0, "guard");
    match.room.players[1].hand = ["strike"];
    await play(match.clients, 1, "strike", match.clients[0].id);
    assert.equal(match.room.players[1].hp, 100);
    assert.equal(match.room.players[1].shield, 0);
    assert.equal(match.room.players[1].poison, 0);
  } finally {
    await closeClients(match.clients);
  }
});
