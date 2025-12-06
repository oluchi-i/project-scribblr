// guess.js
// Single-file replacement implementing the full guessing flow described.
// This file dynamically creates its own guess UI elements (no HTML edits required).
// It intentionally only modifies client-side behavior and assumes the server
// supports the message types we observed (init, chat-message, chat-history,
// host-status/self-connection, user-connected/user-disconnected, yourTurn,
// turn-start, turn-end, start-guessing, updateCanvas). It also uses chat
// broadcasts as the primary cross-client relay (safe when server ignores custom types).

/* ========== Configuration & Globals ========== */

// Attempt to reuse an existing saved id if present
const savedLocalId = localStorage.getItem('myUserId') || null;

// Create websocket (this file owns the client-side WS)
//const ws = new WebSocket(`ws://${window.location.host}`);
window.ws = new WebSocket(`ws://${window.location.host}`);

// DOM references (some may be created dynamically below)
const statusEl = document.getElementById('status');
const messagesEl = document.getElementById('messages');
const chatInputEl = document.getElementById('messageInput');
const chatSendEl = document.getElementById('sendButton');

let myUserId = 'Unknown';
let isHost = false;
let players = [];          // array of {id, name, active}
let currentGuesser = null; // id of current guesser
let lastGuesser = null;    // avoid immediate repeats
let roundStarted = false;
let hasWinner = false;

// Drawer-side variables (drawer is the one who knows the secret word)
let isDrawer = false;
let currentSecretWord = null; // set only for the drawer during their yourTurn

// Guess UI IDs we will create dynamically
const GUESS_UI_CONTAINER_ID = 'guess-controls'; // container for all guess UI
const GUESS_INPUT_ID = 'guess-input';
const GUESS_SUBMIT_ID = 'guess-submit';
const GUESS_FORFEIT_ID = 'guess-forfeit';
const GUESS_TIMER_ID = 'guess-timer';

// Timer state for the active guesser
let guessTimerId = null;
let guessSecondsLeft = 0;

/* ========== Utility helpers ========== */

function log(...args) { console.log('[guess.js]', ...args); }

function appendChatLine(text, cssClass = null) {
  if (!messagesEl) return;
  const div = document.createElement('div');
  div.textContent = text;
  if (cssClass) div.classList.add(cssClass);
  div.style.fontStyle = 'italic';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addChatMessage(text, senderId = null) {
  // Convenience for local UI: we present chat messages similarly to server messages
  if (!messagesEl) return;
  const div = document.createElement('div');
  div.textContent = senderId ? `${senderId}: ${text}` : text;
  if (senderId === myUserId) div.classList.add('my-message');
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Dynamically create Start Game button if missing
function createOrShowStartButton() {
    let btn = document.getElementById("startGameButton");
    if (!btn) {
        btn = document.createElement('button');
        btn.id = "startGameButton";
        btn.textContent = "Start Game";
        btn.style.position = 'fixed';
        btn.style.top = '20px';
        btn.style.left = '50%';
        btn.style.transform = 'translateX(-50%)';
        btn.style.padding = '8px 12px';
        btn.style.zIndex = 10000;
        document.body.appendChild(btn);
    }

    btn.style.display = "block";
    btn.disabled = false;

    // Only add listener once
    if (!btn._guessJsListenerAdded) {
        btn.addEventListener("click", () => {
            // Tell server to start the game
            ws.send(JSON.stringify({ type: "start-game" }));

            // Auto-play background music if exists
            const bgMusic = document.getElementById("backgroundMusic");
            if (bgMusic) {
                bgMusic.volume = 0.5;
                bgMusic.play().catch(err => console.warn("Autoplay blocked:", err));
            }
        });
        btn._guessJsListenerAdded = true;
    }
}

function hideStartButton() {
  const btn = document.getElementById("startGameButton");
  if (btn) btn.style.display = "none";
}

/* ========== Dynamic Guess UI creation ========== */

function createGuessUIIfNeeded() {
  if (document.getElementById(GUESS_UI_CONTAINER_ID)) return;

  const container = document.createElement('div');
  container.id = GUESS_UI_CONTAINER_ID;
  container.style.position = 'fixed';
  container.style.left = '50%';
  container.style.transform = 'translateX(-50%)';
  container.style.bottom = '20px';
  container.style.zIndex = '9999';
  //container.style.display = 'none'; // hidden by default
  container.style.padding = '10px';
  container.style.borderRadius = '8px';
  container.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
  container.style.background = 'linear-gradient(to bottom, #4262b1ff, #a72662ff)';
  container.style.display = 'flex';
  container.style.gap = '8px';
  container.style.alignItems = 'center';
  container.style.backdropFilter = 'max(0, 0, 0, 0.1)';
  container.style.boxShadow = '0 12px 20px rgba(0, 0, 0, 0.4), 0 6px 10px rgba(0, 0, 0, 0.3)';

  // Input
  const inp = document.createElement('input');
  inp.id = GUESS_INPUT_ID;
  inp.type = 'text';
  inp.placeholder = 'Enter your guess...';
  inp.style.padding = '8px';
  inp.style.fontSize = '14px';
  inp.style.width = '500px';
  inp.autocomplete = 'off';
  inp.style.border = '10px solid #ccccccdc';
  inp.style.backdropFilter = 'blur(5px)';

  // Submit
  const submitBtn = document.createElement('button');
  submitBtn.id = GUESS_SUBMIT_ID;
  submitBtn.textContent = 'Submit';
  submitBtn.style.padding = '8px 12px';
  submitBtn.style.cursor = 'pointer';
  submitBtn.style.borderRadius = '5px';
  submitBtn.style.backgroundColor = '#2c93beff';
  submitBtn.style.backdropFilter = 'blur(5px)';

  // Forfeit
  const forfeitBtn = document.createElement('button');
  forfeitBtn.id = GUESS_FORFEIT_ID;
  forfeitBtn.textContent = 'Forfeit';
  forfeitBtn.style.padding = '8px 12px';
  forfeitBtn.style.cursor = 'pointer';
  forfeitBtn.style.borderRadius = '4px';
  forfeitBtn.style.color = 'white';
  forfeitBtn.style.backgroundColor = '#a31d4ed0';

  // Timer
  const timer = document.createElement('div');
  timer.id = GUESS_TIMER_ID;
  timer.style.fontWeight = 'bold';
  timer.style.minWidth = '50px';
  timer.style.textAlign = 'center';
  timer.style.fontSize = '18px';

  container.appendChild(inp);
  container.appendChild(submitBtn);
  container.appendChild(forfeitBtn);
  container.appendChild(timer);

  document.body.appendChild(container);

  // Event listeners
  submitBtn.addEventListener('click', () => {
    const val = inp.value.trim();
    if (!val) return;
    sendGuess(val);
    inp.value = '';
  });

  inp.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitBtn.click();
  });

  forfeitBtn.addEventListener('click', () => {
    // Announce forfeit in chat and treat as failed guess
    ws.send(JSON.stringify({ type: 'chat-message', text: `${myUserId} forfeited.` }));
    handleGuessFailureOrForfeit();
  });
}

/* ========== WebSocket: open / message / close / error ========== */

ws.addEventListener('open', () => {
  log('WebSocket open. Sending init.');
  // send init with saved id (may be null)
  try {
    ws.send(JSON.stringify({ type: 'init', userId: savedLocalId }));
  } catch (e) {
    console.warn('init send failed', e);
  }
  if (statusEl) { statusEl.textContent = 'Connected'; statusEl.style.color = 'green'; }
});

ws.addEventListener('close', () => {
  log('WebSocket closed.');
  if (statusEl) { statusEl.textContent = 'Disconnected'; statusEl.style.color = 'red'; }
});

ws.addEventListener('error', (err) => {
  console.error('WebSocket error', err);
  if (statusEl) { statusEl.textContent = 'Error'; statusEl.style.color = 'red'; }
});

ws.addEventListener('message', (event) => {
  // Server may forward raw data:image... strings directly
  if (typeof event.data === 'string' && event.data.startsWith('data:image/')) {
    receiveCanvasImage(event.data);
    return;
  }

  let data;
  try {
    data = JSON.parse(event.data);
  } catch (e) {
    // not JSON
    log('Non-JSON message', event.data);
    return;
  }

  if (!data || !data.type) return;

  switch (data.type) {
    case 'host-status':
      isHost = !!data.isHost;

      if (data.hostId) {
        appendChatLine(`SYSTEM: Host is ${data.hostId}`, 'system-message-connect');
      }

      if (isHost) {
        createOrShowStartButton();
      } else {
        hideStartButton();
      }
      break;

    case 'self-connection':
      myUserId = data.userId;
      localStorage.setItem('myUserId', myUserId);
      // ensure players contains ourselves
      if (!players.find(p => p.id === myUserId)) players.push({ id: myUserId, name: myUserId, active: true });
      break;

    case 'chat-history':
      if (data.history && Array.isArray(data.history)) {
        if (messagesEl) messagesEl.innerHTML = '';
        data.history.forEach(msg => {
          addChatMessage(msg.text, msg.senderId);
        });
      }
      break;

    case 'chat-message':
      // server broadcasted a chat message
      if (data.senderId && data.text) {
        // Drawer-side auto-detect correct guess:
        if (isDrawer && currentSecretWord && data.senderId !== myUserId) {
          try {
            const guessed = data.text.trim().toLowerCase();
            const secret = currentSecretWord.trim().toLowerCase();
            if (guessed === secret) {
              // Drawer detected a correct guess -> announce via chat (so all clients see)
              ws.send(JSON.stringify({
                type: 'chat-message',
                text: `✅ ${data.senderId} guessed correctly!`
              }));
              // Also emit an optional relay event (server may ignore custom types)
              try { ws.send(JSON.stringify({ type: 'guessCorrect', data: { guesser: data.senderId, guesserName: data.senderId } })); } catch (e) {}
              // Local UI
              hasWinner = true;
              hideGuessControls();
              appendChatLine(`SYSTEM: ${data.senderId} guessed correctly!`);
              // reset drawer state
              isDrawer = false;
              currentSecretWord = null;
              currentGuesser = data.senderId;
              lastGuesser = data.senderId;
              return; // don't double-add the original chat
            }
          } catch (err) {
            console.error('Error while drawer checking guess:', err);
          }
        }

        // Normal display of chat message
        addChatMessage(data.text, data.senderId);
      }
      break;

    case 'user-connected':
    case 'player-join':
      // server indicates a new player
      if (data.userId && !players.find(p => p.id === data.userId)) {
        players.push({ id: data.userId, name: data.userId, active: true });
      }
      appendChatLine(`SYSTEM: ${data.userId} connected.`, 'system-message-connect');
      break;

    case 'user-disconnected':
    case 'player-leave':
      if (data.userId) {
        players = players.filter(p => p.id !== data.userId);
        appendChatLine(`SYSTEM: ${data.userId} disconnected.`, 'system-message-disconnect');
      }
      break;

    case 'game-started':
      roundStarted = true;
      hasWinner = false;
      isDrawer = false;
      currentSecretWord = null;
      appendChatLine('SYSTEM: Game started.', 'system-message-connect');
      break;

    case 'yourTurn':
      // This client is the drawer: server sends secret word and turnEndTime
      if (data.word) {
        isDrawer = true;
        currentSecretWord = data.word;
        showBoldPopup(`YOU ARE DRAWING — WORD: ${data.word.toUpperCase()}`, 2500);
        // if turnEndTime present, display countdown header if supported
        if (data.turnEndTime) startTurnCountdown(`IT'S YOUR TURN — Draw: ${data.word.toUpperCase()}`, data.turnEndTime);
      } else {
        isDrawer = true;
        currentSecretWord = null;
        showBoldPopup("YOU ARE DRAWING", 2000);
      }
      break;

    case 'turn-start':
      // Someone else is drawing
      if (data.drawerId) {
        showBoldPopup(`${data.drawerId.toUpperCase()} IS DRAWING`, 2000);
      }
      if (data.turnEndTime) startTurnCountdown(`${data.drawerId} is drawing...`, data.turnEndTime);
      break;

    case 'turn-end':
      isDrawer = false;
      currentSecretWord = null;
      clearTurnCountdown();
      appendChatLine('SYSTEM: Turn ended.');
      break;

    case 'updateCanvas':
      const image = (data.data && (data.data.image || data.data.imageData)) || data.text;
      if (image) receiveCanvasImage(image);
      break;

    case 'start-guessing':
      // Server wants guessing to start. Server may include 'guesser'.
      roundStarted = true;
      hasWinner = false;
      appendChatLine('SYSTEM: Guessing phase started.');
      if (data.guesser) {
        // Server chose the guesser
        handleChosenGuesser({ guesser: data.guesser, guesserName: data.guesser });
      } else {
        // server didn't choose; pick locally
        startNewGuesser();
      }
      break;

    case 'chooseGuesser':
      // Some servers may forward chooseGuesser; handle payload
      if (data.data) handleChosenGuesser(data.data);
      break;

    case 'guessCorrect':
      if (data.data) {
        const name = data.data.guesserName || data.data.guesser;
        appendChatLine(`SYSTEM: ${name} guessed correctly!`, 'system-message-connect');
        hasWinner = true;
        hideGuessControls();
      }
      break;

    case 'guessFailed':
      if (data.data) {
        const name = data.data.guesserName || data.data.guesser;
        appendChatLine(`SYSTEM: ${name} failed.`, 'system-message-disconnect');
        if (!hasWinner) {
          // choose a new guesser (if host or simply locally)
          startNewGuesser();
        }
      }
      break;

    case 'new-host':
      appendChatLine(`SYSTEM: ${data.userId} is now the host.`, 'system-message-connect');
      break;

    default:
      log('Unhandled server event:', data.type);
  }
});

/* ========== Canvas helper (reuse if canvas exists) ========== */

function receiveCanvasImage(imageData) {
  if (!imageData) return;
  const canvas = document.getElementById('whiteboard');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = imageData;
}

/* ========== Guess flow core functions ========== */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandomGuesser(exclude = []) {
  const eligible = players.filter(p => p && p.id && p.active !== false && !exclude.includes(p.id));
  if (eligible.length === 0) {
    const fallback = players.filter(p => p && p.id && p.active !== false);
    if (fallback.length === 0) return null;
    return fallback[Math.floor(Math.random() * fallback.length)];
  }
  const shuffled = shuffle(eligible);
  return shuffled[0];
}

function startNewGuesser() {
  // select next guesser (avoid immediate repeat)
  const exclude = lastGuesser ? [lastGuesser] : [];
  const chosen = pickRandomGuesser(exclude);
  if (!chosen) {
    appendChatLine('SYSTEM: No eligible guesser could be chosen.');
    return;
  }
  currentGuesser = chosen.id;
  lastGuesser = chosen.id;

  // announce in chat
  ws.send(JSON.stringify({ type: 'chat-message', text: `${chosen.name} is the GUESSER, GUESS THE DRAWING NOW!` }));

  // try to notify via chooseGuesser/private for clients that listen to them
  try {
    ws.send(JSON.stringify({ type: 'chooseGuesser', data: { guesser: chosen.id, guesserName: chosen.name } }));
    ws.send(JSON.stringify({ type: 'private', data: { to: chosen.id, action: 'you-are-guesser' } }));
  } catch (e) { /* server may ignore unknown types */ }

  // Show UI for the chosen guesser only when their client receives chooseGuesser / private
  // But if we are the chosen guesser (local), show right away:
  if (chosen.id === myUserId) {
    showGuesserUIForLocalUser();
  } else {
    showBoldPopup(`${chosen.name.toUpperCase()} IS THE GUESSER`, 2500);
    hideGuessControls();
  }
}

function handleChosenGuesser(payload) {
  if (!payload || !payload.guesser) return;
  currentGuesser = payload.guesser;
  if (currentGuesser === myUserId) {
    // show guess UI locally
    showGuesserUIForLocalUser();
    showBoldBroadcast("YOU'RE THE GUESSER", 2000);
    // small delay then show prompt
    setTimeout(() => showBoldBroadcast("GUESS THE DRAWING", 2000), 600);
  } else {
    // not us: hide local guess UI and show notification
    hideGuessControls();
    const name = payload.guesserName || payload.guesser;
    showBoldBroadcast(`${name.toUpperCase()} IS THE GUESSER`, 2000);
  }
}

/* ========== Guess UI behavior for the local guesser ========== */

function showGuesserUIForLocalUser() {
  createGuessUIIfNeeded();
  const container = document.getElementById(GUESS_UI_CONTAINER_ID);
  const input = document.getElementById(GUESS_INPUT_ID);
  const timer = document.getElementById(GUESS_TIMER_ID);

  if (!container || !input || !timer) return;

  container.style.display = 'flex';
  input.value = '';
  input.focus();

  // Start 10-second timer
  startGuessTimer(10);
}

function hideGuessControls() {
  const container = document.getElementById(GUESS_UI_CONTAINER_ID);
  if (container) container.style.display = 'none';
  clearGuessTimer();
}

function startGuessTimer(seconds) {
  clearGuessTimer();
  guessSecondsLeft = seconds;
  const timer = document.getElementById(GUESS_TIMER_ID);
  if (!timer) return;
  timer.style.display = 'inline-block';
  timer.textContent = guessSecondsLeft;

  guessTimerId = setInterval(() => {
    guessSecondsLeft--;
    if (guessSecondsLeft <= 0) {
      clearGuessTimer();
      timer.textContent = '0';
      // time's up: treat as failure and pick a new guesser
      appendChatLine('SYSTEM: Guesser timed out.', 'system-message-disconnect');
      // Inform others
      try { ws.send(JSON.stringify({ type: 'chat-message', text: `SYSTEM: ${currentGuesser} timed out.` })); } catch (e) {}
      handleGuessFailureOrForfeit();
      return;
    }
    timer.textContent = guessSecondsLeft;
  }, 1000);
}

function clearGuessTimer() {
  if (guessTimerId) {
    clearInterval(guessTimerId);
    guessTimerId = null;
  }
  const timer = document.getElementById(GUESS_TIMER_ID);
  if (timer) { timer.style.display = 'none'; timer.textContent = ''; }
}

function handleGuessFailureOrForfeit() {
  // hide local UI if present
  hideGuessControls();
  // notify server (best-effort custom type)
  try { ws.send(JSON.stringify({ type: 'guessFailed', data: { guesser: currentGuesser } })); } catch (e) {}
  // pick a new guesser after a short delay to let clients see message
  setTimeout(() => {
    startNewGuesser();
  }, 700);
}

/* ========== Sending guesses: we send guesses as chat messages (server broadcasts) ========== */

function sendGuess(text) {
  if (!text || text.trim() === '') return;
  // Send the guess as a chat message (server will broadcast to all)
  try {
    ws.send(JSON.stringify({ type: 'chat-message', text: text }));
  } catch (e) {
    console.error('Failed to send guess chat-message', e);
  }
  // Local UX: if we're the guesser, optionally hide input or wait for drawer to confirm
  // We leave the UI visible until drawer announces result or time runs out
}

/* ========== Small UI utilities ========== */

function showBoldPopup(message, duration = 3000) {
  // a simple center-top big message using existing popup element if present, otherwise create one
  let popup = document.getElementById('popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'popup';
    popup.style.position = 'fixed';
    popup.style.top = '50%';
    popup.style.left = '50%';
    popup.style.transform = 'translate(-50%, -50%)';
    popup.style.padding = '20px 40px';
    popup.style.borderRadius = '20px';
    popup.style.background = 'rgba(0,0,0,0.8)';
    popup.style.color = 'white';
    popup.style.zIndex = '10000';
    popup.style.fontWeight = 'bold';
    popup.style.fontSize = '60px';
    popup.style.textAlign = 'center';
    popup.style.boxShadow = '2px 2px 10px #000';
    document.body.appendChild(popup);
  }
  popup.textContent = message;
  popup.style.display = 'block';
  setTimeout(() => { popup.style.display = 'none'; }, duration);
}

function speak(text) {
    try {
        const utter = new SpeechSynthesisUtterance(text);
        utter.volume = 1;     // Loud
        utter.rate = 0.9;     // Slightly slower for emphasis
        utter.pitch = 1;      
        speechSynthesis.speak(utter);
    } catch (err) {
        console.warn("Speech synthesis failed:", err);
    }
}

function showBoldBroadcast(message, duration = 2000) {
    let banner = document.getElementById("big-center-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "big-center-banner";
        banner.style.position = "fixed";
        banner.style.top = "50%";
        banner.style.left = "50%";
        banner.style.transform = "translate(-50%, -50%)";
        banner.style.fontSize = "60px";
        banner.style.fontWeight = "900";
        banner.style.textAlign = "center";
        banner.style.color = "white";
        banner.style.padding = "20px 40px";
        banner.style.borderRadius = "20px";
        banner.style.background = "rgba(0,0,0,0.7)";
        banner.style.zIndex = "99999";
        banner.style.textShadow = "2px 2px 10px black";
        document.body.appendChild(banner);
    }

    banner.textContent = message;
    banner.style.display = "block";

    speak(message);

    setTimeout(() => {
        banner.style.display = "none";
    }, duration);
}


/* ========== Hook existing chat send UI (if present) ========== */

if (chatSendEl && chatInputEl) {
  chatSendEl.addEventListener('click', () => {
    const txt = chatInputEl.value.trim();
    if (!txt) return;
    try { ws.send(JSON.stringify({ type: 'chat-message', text: txt })); } catch (e) {}
    chatInputEl.value = '';
  });
  chatInputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') chatSendEl.click();
  });
}

/* ========== Host G-key trigger to start guessing ========== */
document.addEventListener('keypress', (e) => {
  if (e.key.toLowerCase() !== 'G') return;
  if (!isHost || !roundStarted) return;

  log('Host pressed G: starting guessing phase');

  // Ask server to start guessing
  try {
    ws.send(JSON.stringify({ type: 'start-guessing' }));
  } catch (err) {
    console.warn('start-guessing send failed', err);
  }

  // Local fallback if server doesn't respond after 300ms
  setTimeout(() => {
    if (!currentGuesser) {
      log('Server did not respond, picking a local guesser...');
      startNewGuesser();
    }
  }, 300);
});


/* ========== Turn countdown UI helpers (optional header placement) ========== */

let turnInterval = null;
function startTurnCountdown(text, endTime) {
  const header = document.getElementById('game-status-display');
  if (!header) return;
  clearTurnCountdown();
  function update() {
    const msLeft = endTime - Date.now();
    if (msLeft <= 0) {
      header.innerHTML = `${text} (0s)`;
      clearTurnCountdown();
      return;
    }
    const secs = Math.ceil(msLeft / 1000);
    header.innerHTML = `${text} (${secs}s)`;
    header.style.color = secs <= 10 ? 'orange' : 'green';
  }
  update();
  turnInterval = setInterval(update, 1000);
}

function clearTurnCountdown() {
  if (turnInterval) { clearInterval(turnInterval); turnInterval = null; }
  const header = document.getElementById('game-status-display');
  if (header) {
    header.innerHTML = 'Whiteboard';
    header.style.color = '#333';
  }
}

/* ========== Initialize: create guess UI (hidden), ensure chat hooking ======= */

createGuessUIIfNeeded();
hideGuessControls(); // ensure hidden at start

if (startGameButton) {
    startGameButton.addEventListener("click", () => {
        // Tell the server to start the game
        ws.send(JSON.stringify({ type: "start-game" }));

        // Auto-play music
        const bgMusic = document.getElementById("backgroundMusic");
        if (bgMusic) {
            bgMusic.volume = 0.5;
            bgMusic.play().catch(err => {
                console.warn("Autoplay blocked:", err);
            });
        }
    });
}

window.addEventListener("DOMContentLoaded", () => {
    createOrShowStartButton();
    //hideStartButton();
});


/* ========== Notes for maintainers ==========
 - This file expects the server forwards chat-message broadcasts and handles 'init' on connection.
 - Guesses are sent as chat messages. The drawer (who gets the secret word via 'yourTurn')
   detects correct guesses by matching chat messages to the secret word, then announces
   the correct guess via a chat broadcast so all clients can show the result.
 - The code creates its own guess input UI (ids: guess-controls, guess-input, guess-submit,
   guess-forfeit, guess-timer) and will not require HTML edits.
 - The host can press 'G' to trigger the guessing phase (best-effort; server may also trigger).
 - This implementation intentionally avoids modifying server or HTML files.
============================================== */
