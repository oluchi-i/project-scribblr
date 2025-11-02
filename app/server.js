let axios = require("axios");
let express = require("express");
let app = express();
let WebSocket = require('ws')
let path = require('path')
let http = require('http');

let port = 3000;
let hostname = "localhost";
app.use(express.static("public"));


// Create a standard HTTP server using the express app
let server = http.createServer(app);

//Attach the WebSocket server (ws) to the HTTP server
let wss = new WebSocket.Server({server})

// ---------------- GAME STATE ----------------
let game = {
  state: "WAITING", // WAITING, DRAWING, GUESSING, REVEAL
  players: [], // { id, name, ws, role }
  prompt: "",
  guesser: null,
  drawers: [],
  canvasHistory: [],
};

// Helper: broadcast message to all clients
function broadcast(data, except = null) {
  wss.clients.forEach((client) => {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// --- Guessing Phase ---
function startGuessingPhase() {
  game.state = "GUESSING";
  console.log("Starting guessing phase...");

  if (game.guesser && game.guesser.ws.readyState === WebSocket.OPEN) {
    game.guesser.ws.send(
      JSON.stringify({
        type: "startGuessing",
        canvasHistory: game.canvasHistory,
      })
    );
  }

  broadcast(
    { type: "status", message: "Guesser is reviewing and guessing..." },
    game.guesser?.ws
  );
}

// --- Reveal Phase ---
function startRevealPhase(guess, correct) {
  game.state = "REVEAL";
  broadcast({
    type: "reveal",
    prompt: game.prompt,
    guess,
    correct,
  });

  console.log("Reveal phase:", { guess, correct });

  // Reset game after 10 seconds
  setTimeout(() => {
    game.state = "WAITING";
    game.prompt = "";
    game.canvasHistory = [];
    game.guesser = null;
    game.drawers = [];
    broadcast({ type: "status", message: "Round over. Waiting for next game..." });
  }, 10000);
}

wss.on('connection', (ws) => {
  console.log('A new client connected.');

  const player = { id: Date.now(), ws };
  game.players.push(player);

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      data = {type: "raw", message};
    }

    switch (data.type) {
      case "register":
        player.name = data.name || `Player${player.id}`;
        ws.send(JSON.stringify({ type: "registered", name: player.name }));
        break;

      case "submitGuess":
        if (game.state === "GUESSING" && player === game.guesser) {
          const guess = data.guess.trim();
          const correct =
            guess.toLowerCase() === game.prompt.toLowerCase();
          startRevealPhase(guess, correct);
        }
        break;

      case "startGuessingPhase":
        // for now you can trigger it manually from the client
        game.guesser = player;
        game.prompt = "cat"; // placeholder for testing
        startGuessingPhase();
        break;

    default:
    // We receive the message (as a string or Buffer)
    // console.log('Received message: %s', message); // Uncomment for debugging

    //  Implement a "broadcast" function
    // Iterate over all connected clients
    wss.clients.forEach((client) => {
      // Send the message to all clients *except* the original sender
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
    break;

    }
  });
  ws.on('close', () => {
    console.log('Client disconnected.');
  });

  ws.on('error', (error) => {
    console.error('WebSocket Error: ', error);
  });
});

app.get("/", (req, res) =>
{
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(port, hostname, () => {
    console.log(`http://${hostname}:${port}`);
});


