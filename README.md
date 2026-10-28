# P-Day Quips

A Quiplash-style party game for missionaries. One person hosts and everyone else joins on their own phone with a 4-letter room code. A laptop or TV display is optional.

## How a game runs
- **3–12 players.** Rounds 1 and 2: each player gets 2 prompts, and every prompt goes to exactly 2 players.
- The two answers go head-to-head, anonymously, and everyone else votes. Each matchup is worth 1,000 points (2,000 in Round 2), split by vote share. Winning every vote earns a **Clean Sweep** bonus (+250 / +500). Identical answers are a **Jinx**, and neither player scores.
- **Final round:** everyone answers the same prompt and votes for a favorite (500 points per vote).
- **Host tools:** set answer and vote timers, choose prompt categories, add your own prompts (inside jokes about your district), remove players in the lobby, hide any answer during voting, and skip ahead.
- If a phone locks or drops off, reopen the site and the player rejoins automatically.

## Run it locally (same Wi-Fi)
```
npm install
npm start
```
Players open `http://<host-computer-ip>:3000`. For a TV display, open `/?tv` on the big screen.

## Deploy it (recommended)
Any host that runs Node and supports WebSockets will work. On Render:
1. Push this folder to a GitHub repo.
2. Create a Render **Web Service** from the repo with build command `npm install`, start command `npm start`, and **one instance**. Game state lives in memory.
3. Share the URL. The free tier sleeps when idle, so the first load can take about 30 seconds. Open it a minute before you play.

## Edit prompts
All prompts live in `prompts.js`, grouped by category. The rule: tease the mission *experience*, not sacred things.

## Test
`npm test` runs a simulated 5-bot game through every phase.
