// P-Day Quips — real-time party game server (Express + Socket.io)
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const BANK = require("./prompts");

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const REVEAL_MS = 7000;
const MAX_ANSWER_LEN = 80;
const ROUND_MULT = { 1: 1, 2: 2 };
const FINAL_VOTE_POINTS = 500;

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- helpers ----------
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const newId = () => crypto.randomBytes(9).toString("base64url");
const clean = (s, max) =>
  String(s || "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

const categoryList = Object.entries(BANK)
  .filter(([, c]) => !c.final)
  .map(([key, c]) => ({ key, label: c.label, count: c.prompts.length }));

function connectedPlayers(room) {
  return [...room.players.values()].filter((p) => p.connected);
}
function activePlayers(room) {
  // players who are part of the current game (joined before start)
  return [...room.players.values()].filter((p) => p.inGame);
}

function drawPrompts(room, n) {
  let pool = [];
  for (const key of room.settings.categories) if (BANK[key]) pool.push(...BANK[key].prompts);
  pool.push(...room.settings.custom);
  pool = [...new Set(pool)];
  let fresh = pool.filter((p) => !room.used.has(p));
  if (fresh.length < n) {
    room.used.clear();
    fresh = pool;
  }
  const picked = shuffle(fresh).slice(0, n);
  picked.forEach((p) => room.used.add(p));
  return picked;
}
function drawFinal(room) {
  const pool = BANK.finals.prompts.filter((p) => !room.used.has(p));
  const p = shuffle(pool.length ? pool : BANK.finals.prompts)[0];
  room.used.add(p);
  return p;
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
}
function setTimer(room, ms, fn) {
  clearTimer(room);
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(() => {
    room.timer = null;
    fn();
  }, ms);
}

// ---------- game flow ----------
function startRound(room) {
  room.round += 1;
  const players = shuffle(activePlayers(room));
  room.used = room.used || new Set();

  if (room.round <= 2) {
    // n prompts, each player gets 2, each prompt goes to 2 players (ring assignment)
    const n = players.length;
    const prompts = drawPrompts(room, n);
    room.matchups = prompts.map((prompt, i) => ({
      prompt,
      a: { pid: players[i].id, text: null },
      b: { pid: players[(i + 1) % n].id, text: null },
      votes: {},
      hidden: false,
      result: null,
    }));
    room.matchups = shuffle(room.matchups);
    room.phase = "answer";
    setTimer(room, room.settings.answerTime * 1000, () => endAnswering(room));
  } else {
    room.final = { prompt: drawFinal(room), answers: {}, votes: {}, hidden: {}, result: null };
    room.phase = "final_answer";
    setTimer(room, room.settings.answerTime * 1000, () => endFinalAnswering(room));
  }
  broadcast(room);
}

function allAnswered(room) {
  return room.matchups.every((m) => m.a.text !== null && m.b.text !== null);
}

function endAnswering(room) {
  clearTimer(room);
  for (const m of room.matchups) {
    if (m.a.text === null) m.a.text = "";
    if (m.b.text === null) m.b.text = "";
  }
  room.mIndex = -1;
  nextMatchup(room);
}

function nextMatchup(room) {
  room.mIndex += 1;
  if (room.mIndex >= room.matchups.length) {
    room.phase = "scores";
    clearTimer(room);
    broadcast(room);
    return;
  }
  const m = room.matchups[room.mIndex];
  const jinx = m.a.text && m.b.text && m.a.text.toLowerCase() === m.b.text.toLowerCase();
  const bothBlank = !m.a.text && !m.b.text;
  if (jinx || bothBlank) {
    m.result = { jinx: !!jinx, bothBlank, a: 0, b: 0, votesA: 0, votesB: 0, sweep: null };
    room.phase = "reveal";
    setTimer(room, REVEAL_MS, () => nextMatchup(room));
  } else {
    room.phase = "vote";
    setTimer(room, room.settings.voteTime * 1000, () => endVoting(room));
  }
  broadcast(room);
}

function eligibleVoters(room, m) {
  return connectedPlayers(room).filter((p) => p.id !== m.a.pid && p.id !== m.b.pid);
}

function endVoting(room) {
  clearTimer(room);
  const m = room.matchups[room.mIndex];
  const mult = ROUND_MULT[room.round] || 1;
  const votesA = Object.values(m.votes).filter((v) => v === "a").length;
  const votesB = Object.values(m.votes).filter((v) => v === "b").length;
  const total = votesA + votesB;
  let a = 0, b = 0, sweep = null;
  if (total > 0) {
    a = Math.round((1000 * mult * votesA) / total);
    b = Math.round((1000 * mult * votesB) / total);
    if (total >= 2 && votesA === total) { sweep = "a"; a += 250 * mult; }
    if (total >= 2 && votesB === total) { sweep = "b"; b += 250 * mult; }
  }
  // a blank answer always earns nothing
  if (!m.a.text) a = 0;
  if (!m.b.text) b = 0;
  m.result = { a, b, votesA, votesB, sweep, voters: { ...m.votes } };
  addScore(room, m.a.pid, a);
  addScore(room, m.b.pid, b);
  room.phase = "reveal";
  setTimer(room, REVEAL_MS, () => nextMatchup(room));
  broadcast(room);
}

function addScore(room, pid, pts) {
  const p = room.players.get(pid);
  if (p) p.score += pts;
}

function endFinalAnswering(room) {
  clearTimer(room);
  const f = room.final;
  for (const p of activePlayers(room)) if (f.answers[p.id] === undefined) f.answers[p.id] = "";
  f.order = shuffle(Object.keys(f.answers).filter((pid) => f.answers[pid]));
  if (f.order.length < 2) {
    f.result = { tally: {}, points: {} };
    room.phase = "final_reveal";
  } else {
    room.phase = "final_vote";
    setTimer(room, room.settings.voteTime * 1000 + 10000, () => endFinalVoting(room));
  }
  broadcast(room);
}

function endFinalVoting(room) {
  clearTimer(room);
  const f = room.final;
  const tally = {};
  for (const pid of Object.values(f.votes)) tally[pid] = (tally[pid] || 0) + 1;
  const points = {};
  for (const [pid, n] of Object.entries(tally)) {
    points[pid] = n * FINAL_VOTE_POINTS;
    addScore(room, pid, points[pid]);
  }
  f.result = { tally, points };
  room.phase = "final_reveal";
  broadcast(room);
}

function resetToLobby(room) {
  clearTimer(room);
  room.phase = "lobby";
  room.round = 0;
  room.matchups = [];
  room.final = null;
  for (const p of room.players.values()) { p.score = 0; p.inGame = false; }
  // drop players who left
  for (const [id, p] of room.players) if (!p.connected) room.players.delete(id);
  broadcast(room);
}

// ---------- views ----------
function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, score: p.score, connected: p.connected, inGame: p.inGame,
    done: playerDone(room, p.id),
  }));
}

function playerDone(room, pid) {
  if (room.phase === "answer") {
    return room.matchups.every((m) => (m.a.pid === pid ? m.a.text !== null : true) && (m.b.pid === pid ? m.b.text !== null : true));
  }
  if (room.phase === "final_answer") return room.final.answers[pid] !== undefined;
  if (room.phase === "vote") {
    const m = room.matchups[room.mIndex];
    return m.a.pid === pid || m.b.pid === pid || m.votes[pid] !== undefined;
  }
  if (room.phase === "final_vote") return room.final.votes[pid] !== undefined;
  return false;
}

function nameOf(room, pid) {
  return room.players.get(pid)?.name || "Someone";
}

function viewFor(room, pid /* null for display */) {
  const v = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    you: pid,
    isHost: pid && pid === room.hostId,
    players: publicPlayers(room),
    deadline: room.deadline,
    now: Date.now(),
    settings: room.settings,
    categories: categoryList,
    minPlayers: MIN_PLAYERS,
    mult: ROUND_MULT[room.round] || 1,
  };

  if (room.phase === "answer") {
    v.myPrompts = room.matchups
      .map((m, i) => {
        const side = m.a.pid === pid ? "a" : m.b.pid === pid ? "b" : null;
        if (!side) return null;
        return { mi: i, prompt: m.prompt, submitted: m[side].text !== null };
      })
      .filter(Boolean);
  }

  if (room.phase === "vote" || room.phase === "reveal") {
    const m = room.matchups[room.mIndex];
    v.matchup = {
      index: room.mIndex,
      total: room.matchups.length,
      prompt: m.prompt,
      a: m.hidden === "a" ? "[removed by host]" : m.a.text,
      b: m.hidden === "b" ? "[removed by host]" : m.b.text,
      mine: m.a.pid === pid ? "a" : m.b.pid === pid ? "b" : null,
      myVote: pid ? m.votes[pid] || null : null,
      votesIn: Object.keys(m.votes).length,
      votersNeeded: eligibleVoters(room, m).length,
    };
    if (room.phase === "reveal") {
      v.matchup.result = m.result;
      v.matchup.nameA = nameOf(room, m.a.pid);
      v.matchup.nameB = nameOf(room, m.b.pid);
      v.matchup.votersA = Object.entries(m.result.voters || {}).filter(([, s]) => s === "a").map(([id]) => nameOf(room, id));
      v.matchup.votersB = Object.entries(m.result.voters || {}).filter(([, s]) => s === "b").map(([id]) => nameOf(room, id));
    }
  }

  if (room.phase === "final_answer") {
    v.final = {
      prompt: room.final.prompt,
      submitted: pid ? room.final.answers[pid] !== undefined : false,
      inGame: pid ? !!room.players.get(pid)?.inGame : false,
    };
  }

  if (room.phase === "final_vote" || room.phase === "final_reveal") {
    const f = room.final;
    const reveal = room.phase === "final_reveal";
    v.final = {
      prompt: f.prompt,
      myVote: pid ? f.votes[pid] || null : null,
      votesIn: Object.keys(f.votes).length,
      answers: (f.order || []).map((aid) => ({
        id: aid,
        text: f.hidden[aid] ? "[removed by host]" : f.answers[aid],
        mine: aid === pid,
        name: reveal ? nameOf(room, aid) : null,
        votes: reveal ? f.result?.tally[aid] || 0 : null,
        points: reveal ? f.result?.points[aid] || 0 : null,
      })),
    };
    if (reveal) v.final.answers.sort((x, y) => (y.votes || 0) - (x.votes || 0));
  }
  return v;
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit("state", viewFor(room, p.id));
  }
  for (const sid of room.displays) io.to(sid).emit("state", viewFor(room, null));
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  const next = connectedPlayers(room)[0];
  if (next) room.hostId = next.id;
}

// ---------- sockets ----------
io.on("connection", (socket) => {
  let room = null;
  let pid = null;

  const fail = (msg) => socket.emit("err", msg);
  const isHost = () => room && pid === room.hostId;

  socket.on("create", ({ name, playerId } = {}) => {
    name = clean(name, 16);
    if (!name) return fail("Enter your name first.");
    const code = makeCode();
    room = {
      code,
      players: new Map(),
      displays: new Set(),
      phase: "lobby",
      round: 0,
      matchups: [],
      final: null,
      used: new Set(),
      timer: null,
      deadline: null,
      settings: { answerTime: 90, voteTime: 20, categories: categoryList.map((c) => c.key), custom: [] },
      lastActive: Date.now(),
    };
    rooms.set(code, room);
    pid = playerId && /^[\w-]{6,30}$/.test(playerId) ? playerId : newId();
    room.players.set(pid, { id: pid, name, score: 0, connected: true, socketId: socket.id, inGame: false });
    room.hostId = pid;
    socket.join(code);
    socket.emit("joined", { code, playerId: pid });
    broadcast(room);
  });

  socket.on("join", ({ code, name, playerId, display } = {}) => {
    code = clean(code, 4).toUpperCase();
    const r = rooms.get(code);
    if (!r) return fail("No game with that code. Double-check it with the host.");
    if (display) {
      room = r;
      r.displays.add(socket.id);
      socket.emit("joined", { code, display: true });
      socket.emit("state", viewFor(r, null));
      return;
    }
    // rejoin with existing id
    if (playerId && r.players.has(playerId)) {
      room = r;
      pid = playerId;
      const p = r.players.get(pid);
      p.connected = true;
      p.socketId = socket.id;
      if (name) p.name = clean(name, 16) || p.name;
      ensureHost(r);
      socket.emit("joined", { code, playerId: pid });
      broadcast(r);
      return;
    }
    name = clean(name, 16);
    if (!name) return fail("Enter your name first.");
    if (r.phase !== "lobby") return fail("That game already started. Wait for the next one!");
    if (r.players.size >= MAX_PLAYERS) return fail(`That game is full (${MAX_PLAYERS} max).`);
    const taken = [...r.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return fail("Someone already has that name. Try adding a last initial.");
    room = r;
    pid = newId();
    r.players.set(pid, { id: pid, name, score: 0, connected: true, socketId: socket.id, inGame: false });
    ensureHost(r);
    socket.join(code);
    socket.emit("joined", { code, playerId: pid });
    broadcast(r);
  });

  socket.on("settings", (s = {}) => {
    if (!isHost() || room.phase !== "lobby") return;
    const st = room.settings;
    if ([45, 60, 90, 120].includes(s.answerTime)) st.answerTime = s.answerTime;
    if ([15, 20, 30].includes(s.voteTime)) st.voteTime = s.voteTime;
    if (Array.isArray(s.categories)) {
      const valid = s.categories.filter((k) => categoryList.some((c) => c.key === k));
      if (valid.length) st.categories = valid;
    }
    if (typeof s.custom === "string") {
      st.custom = s.custom.split("\n").map((l) => clean(l, 120)).filter(Boolean).slice(0, 100);
    }
    broadcast(room);
  });

  socket.on("kick", (target) => {
    if (!isHost() || room.phase !== "lobby" || target === pid) return;
    const p = room.players.get(target);
    if (!p) return;
    if (p.socketId) io.to(p.socketId).emit("kicked");
    room.players.delete(target);
    broadcast(room);
  });

  socket.on("start", () => {
    if (!isHost() || room.phase !== "lobby") return;
    const ready = connectedPlayers(room);
    if (ready.length < MIN_PLAYERS) return fail(`Need at least ${MIN_PLAYERS} players.`);
    for (const p of room.players.values()) { p.inGame = p.connected; p.score = 0; }
    for (const [id, p] of room.players) if (!p.connected) room.players.delete(id);
    room.round = 0;
    startRound(room);
  });

  socket.on("answer", ({ mi, text } = {}) => {
    if (!room || !pid) return;
    text = clean(text, MAX_ANSWER_LEN);
    if (room.phase === "answer") {
      const m = room.matchups[mi];
      if (!m) return;
      const side = m.a.pid === pid ? "a" : m.b.pid === pid ? "b" : null;
      if (!side || m[side].text !== null) return;
      m[side].text = text;
      if (allAnswered(room)) return endAnswering(room);
      broadcast(room);
    } else if (room.phase === "final_answer") {
      if (!room.players.get(pid)?.inGame || room.final.answers[pid] !== undefined) return;
      room.final.answers[pid] = text;
      const everyone = activePlayers(room).filter((p) => p.connected).every((p) => room.final.answers[p.id] !== undefined);
      if (everyone) return endFinalAnswering(room);
      broadcast(room);
    }
  });

  socket.on("vote", (choice) => {
    if (!room || !pid) return;
    if (room.phase === "vote") {
      const m = room.matchups[room.mIndex];
      if (m.a.pid === pid || m.b.pid === pid) return;
      if (choice !== "a" && choice !== "b") return;
      if (m.votes[pid]) return;
      m.votes[pid] = choice;
      const needed = eligibleVoters(room, m).length;
      if (Object.keys(m.votes).length >= needed) return endVoting(room);
      broadcast(room);
    } else if (room.phase === "final_vote") {
      const f = room.final;
      if (choice === pid || !f.order.includes(choice) || f.votes[pid]) return;
      f.votes[pid] = choice;
      const voters = connectedPlayers(room);
      const done = voters.every((p) => f.votes[p.id] || (f.order.length === 1 && f.order[0] === p.id));
      if (done) return endFinalVoting(room);
      broadcast(room);
    }
  });

  // host moderation: hide an answer during voting
  socket.on("hide", (target) => {
    if (!isHost()) return;
    if (room.phase === "vote" || room.phase === "reveal") {
      const m = room.matchups[room.mIndex];
      if (target === "a" || target === "b") m.hidden = target;
    } else if (room.phase === "final_vote" || room.phase === "final_reveal") {
      if (room.final.answers[target] !== undefined) room.final.hidden[target] = true;
    }
    broadcast(room);
  });

  socket.on("advance", (from = {}) => {
    if (!isHost()) return;
    // ignore stale/double taps: client says which phase (and matchup) it is advancing from
    if (from.phase && from.phase !== room.phase) return;
    if (from.phase && typeof from.round === "number" && from.round !== room.round) return;
    if ((room.phase === "vote" || room.phase === "reveal") && typeof from.mIndex === "number" && from.mIndex !== room.mIndex) return;
    switch (room.phase) {
      case "answer": return endAnswering(room);
      case "vote": return endVoting(room);
      case "reveal": return nextMatchup(room);
      case "scores": return startRound(room);
      case "final_answer": return endFinalAnswering(room);
      case "final_vote": return endFinalVoting(room);
      case "final_reveal": room.phase = "end"; return broadcast(room);
      case "end": return resetToLobby(room);
    }
  });

  socket.on("leave", () => {
    if (!room || !pid) return;
    if (room.phase === "lobby") room.players.delete(pid);
    else { const p = room.players.get(pid); if (p) { p.connected = false; p.socketId = null; } }
    ensureHost(room);
    broadcast(room);
    room = null; pid = null;
  });

  socket.on("disconnect", () => {
    if (!room) return;
    room.displays.delete(socket.id);
    const p = pid && room.players.get(pid);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      p.socketId = null;
      ensureHost(room);
      // if the game was waiting only on this player, don't stall
      if (room.phase === "vote") {
        const m = room.matchups[room.mIndex];
        if (Object.keys(m.votes).length >= eligibleVoters(room, m).length && eligibleVoters(room, m).length > 0) return endVoting(room);
      }
      broadcast(room);
    }
  });
});

// clean up idle rooms every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, r] of rooms) {
    const anyone = connectedPlayers(r).length > 0 || r.displays.size > 0;
    if (!anyone && r.lastActive < cutoff) { clearTimer(r); rooms.delete(code); }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`P-Day Quips running on http://localhost:${PORT}`));
module.exports = { server, rooms };
