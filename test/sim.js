// Simulates a full game with N bots. Shortens timers by forcing all actions immediately.
const { io } = require("socket.io-client");
const URL = "http://localhost:3999";
const N = Number(process.argv[2] || 5);
const bots = [];
let code;
const log = (...a) => console.log(...a);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function mk(name) {
  const s = io(URL, { transports: ["websocket"] });
  const b = { name, s, st: null, id: null, uid: Math.random() };
  s.on("state", st => { if (st.phase==="answer" && b.cnt===undefined) b.cnt = st.myPrompts.length; b.st = st; act(b); });
  s.on("joined", j => b.id = j.playerId);
  s.on("err", e => log("ERR", name, e));
  return b;
}
const acted = new Set();
function act(b) {
  const st = b.st, key = (k) => `${b.uid}|${st.phase}|${st.round}|${k}`;
  if (st.phase === "answer") for (const p of st.myPrompts) if (!p.submitted && !acted.has(key(p.mi))) {
    acted.add(key(p.mi)); setTimeout(() => b.s.emit("answer", { mi: p.mi, text: `${b.name} says ${p.mi}` }), 20);
  }
  if (st.phase === "vote" && !st.matchup.mine && !st.matchup.myVote && !acted.has(key("v"+st.matchup.index))) {
    acted.add(key("v"+st.matchup.index)); setTimeout(() => b.s.emit("vote", Math.random() < .5 ? "a" : "b"), 20);
  }
  if (st.phase === "final_answer" && !st.final.submitted && !acted.has(key("f"))) {
    acted.add(key("f")); b.s.emit("answer", { text: `${b.name} final` });
  }
  if (st.phase === "final_vote" && !st.final.myVote && !acted.has(key("fv"))) {
    acted.add(key("fv")); const opt = st.final.answers.filter(a => !a.mine); b.s.emit("vote", opt[0].id);
  }
}
(async () => {
  const host = mk("Host"); bots.push(host);
  host.s.emit("create", { name: "Host" });
  await wait(300); code = host.st.code; log("room", code);
  for (let i = 1; i < N; i++) { const b = mk("Bot" + i); bots.push(b); b.s.emit("join", { code, name: "Bot" + i }); }
  // also a TV display
  const tv = io(URL, { transports: ["websocket"] }); let tvPhases = [];
  tv.on("state", st => { if (tvPhases.at(-1) !== st.phase) tvPhases.push(st.phase); });
  tv.emit("join", { code, display: true });
  await wait(400);
  // dup name check + bad code
  const d = mk("dup"); d.s.emit("join", { code, name: "bot1" }); d.s.emit("join", { code: "ZZZZ", name: "x" });
  await wait(200); d.s.close();
  log("lobby players:", host.st.players.map(p => p.name).join(","));
  const phases = [];
  host.s.on("state", st => {
    const tag = st.phase + (st.matchup ? "#" + st.matchup.index : "");
    if (phases.at(-1) !== tag) phases.push(tag);
    if (["reveal","scores","final_reveal"].includes(st.phase)) { const f = { phase: st.phase, round: st.round, mIndex: st.matchup?.index }; setTimeout(() => host.s.emit("advance", f), 50); }
  });
  host.s.emit("start");
  // check prompt distribution
  await wait(300);
  
  // test reconnect mid-game: Bot1 disconnects and rejoins with id
  const b1 = bots[1]; const id = b1.id; b1.s.close();
  await wait(100);
  const b1b = mk("Bot1"); bots[1] = b1b; b1b.s.emit("join", { code, playerId: id });
  for (let t = 0; t < 400; t++) { await wait(250); if (host.st.phase === "end") break; }
  log("prompts/player:", bots.map(b=>b.cnt).join(",")); log("phases:", phases.join(" > "));
  log("tv phases:", tvPhases.join(" > "));
  log("final phase:", host.st.phase);
  log("scores:", host.st.players.map(p => `${p.name}=${p.score}`).join(" "));
  // play again
  host.s.emit("advance", {phase:"end", round: host.st.round}); await wait(200); log("after play again:", host.st.phase, host.st.players.map(p=>p.score).join(","));
  process.exit(0);
})();
