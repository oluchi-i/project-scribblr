let express = require("express");
let app = express();
let WebSocket = require('ws');
let http = require('http');

let hostname = "localhost";
let port = 3000;

app.use(express.static("public"));
let server = http.createServer(app);
let wss = new WebSocket.Server({ server });

// Global list of rooms: <roomId, GameRoomInstance>
let rooms = new Map(); 

const WORD_LIST = [
  "Apple", "Bicycle", "Cat", "Dog", "House", "Star",
  "Mountain", "River", "Bridge", "Car", "Tree", "Sun",
  "Moon", "Cloud", "Flower", "Bird", "Fish", "Boat",
  "Guitar", "Piano", "Book", "Chair", "Table", "Lamp",
  "Key", "Lock", "Heart", "Smile", "Rain", "Snow",
  "Airplane", "Robot", "Dragon", "Castle", "Ghost",
  "Pizza", "Birthday Cake", "Spider", "Octopus", "Volcano"
];

// --- Game Room Class ---
class GameRoom {
    constructor(roomId, hostId) {
        this.roomId = roomId;
        this.activeUsers = new Map(); // <userId, ws_client>
        this.hostUserId = null;
        this.chatHistory = [];
        this.gameState = 'lobby'; 
        this.currentGame = null;
        this.messageTimestamps = new Map();
        
        // NEW: Scoring system
        this.playerScores = new Map(); // <userId, score>
        this.guessStartTime = null; // Track when guessing phase started
        
        this.MAX_HISTORY = 50;
        this.MESSAGE_LIMIT = 10;
        this.TIME_WINDOW_MS = 3000;
        this.TURN_DURATION_MS = 5000;
        this.GUESS_DURATION_MS = 10000; // Changed to 10 seconds to match your example
        this.MAX_GUESS_SCORE = 100; // Maximum points for instant guess
    }

    // --- NEW: Initialize player score ---
    initializePlayerScore(userId) {
        if (!this.playerScores.has(userId)) {
            this.playerScores.set(userId, 0);
        }
    }

    // --- NEW: Calculate score based on time remaining ---
    calculateGuessScore(timeRemainingMs) {
        const totalTime = this.GUESS_DURATION_MS;
        const percentage = timeRemainingMs / totalTime;
        // Score ranges from 10 to 100 points
        const score = Math.max(10, Math.round(percentage * this.MAX_GUESS_SCORE));
        return score;
    }

    // --- NEW: Add score to player ---
    addScore(userId, points) {
        this.initializePlayerScore(userId);
        const currentScore = this.playerScores.get(userId);
        this.playerScores.set(userId, currentScore + points);
        this.broadcastLeaderboard();
    }

    // --- NEW: Get leaderboard data ---
    getLeaderboard() {
        const leaderboard = [];
        this.playerScores.forEach((score, userId) => {
            leaderboard.push({ userId, score });
        });
        // Sort by score descending
        leaderboard.sort((a, b) => b.score - a.score);
        return leaderboard;
    }

    // --- NEW: Broadcast leaderboard to all players ---
    broadcastLeaderboard() {
        const leaderboard = this.getLeaderboard();
        this.broadcast(JSON.stringify({ 
            type: 'leaderboard-update', 
            leaderboard: leaderboard 
        }));
    }

    // --- Helper to send user list to everyone ---
    broadcastUserList() {
        const users = [];
        this.activeUsers.forEach((ws, userId) => {
            users.push({
                name: userId,
                isHost: (userId === this.hostUserId)
            });
        });
        this.broadcast(JSON.stringify({ type: 'update-user-list', users: users }));
    }

    addUser(ws, userId) {
        this.activeUsers.set(userId, ws);
        ws.roomId = this.roomId; 
        
        // Initialize score for new player
        this.initializePlayerScore(userId);
        
        let isHost = false;
        if (this.hostUserId === null) {
            this.hostUserId = userId;
            isHost = true;
        }

        ws.send(JSON.stringify({ type: 'joined-room', roomId: this.roomId }));
        ws.send(JSON.stringify({ type: 'host-status', isHost: isHost, hostId: this.hostUserId }));
        ws.send(JSON.stringify({ type: 'self-connection', userId: userId }));
        ws.send(JSON.stringify({ type: 'chat-history', history: this.chatHistory }));

        const connectionMessage = JSON.stringify({ type: 'user-connected', userId: userId });
        this.broadcast(connectionMessage);

        // Update list for everyone
        this.broadcastUserList();
        
        // Send current leaderboard to new player
        this.broadcastLeaderboard();
    }

    removeUser(userId) {
        const ws = this.activeUsers.get(userId);
        if (ws) {
            this.activeUsers.delete(userId);
            
            if (this.currentGame && (this.currentGame.drawers.includes(userId) || this.currentGame.guesser === userId)) {
                if (this.gameState !== 'lobby') this.endGame(`${userId} disconnected.`);
            }

            if (userId === this.hostUserId) {
                if (this.activeUsers.size > 0) {
                    this.hostUserId = this.activeUsers.keys().next().value;
                    const newHostSocket = this.activeUsers.get(this.hostUserId);
                    if (newHostSocket) newHostSocket.send(JSON.stringify({ type: 'host-status', isHost: true, hostId: this.hostUserId }));
                    
                    const newHostBroadcast = JSON.stringify({ type: 'new-host', userId: this.hostUserId });
                    this.broadcastExclude(newHostBroadcast, this.hostUserId);
                } else {
                    this.hostUserId = null;
                }
            }

            const disconnectMessage = JSON.stringify({ type: 'user-disconnected', userId: userId });
            this.broadcast(disconnectMessage);

            // Update list for everyone
            this.broadcastUserList();
        }
    }

    handleMessage(ws, data, messageRaw) {
        if (messageRaw.toString().startsWith('data:image/')) {
            const broadcastImage = JSON.stringify({
                type: 'canvas-image',
                senderId: ws.userId,
                text: messageRaw.toString()
            });

            this.activeUsers.forEach(client => {
                let canBeSentSomething = client.readyState === WebSocket.OPEN;
                let isCurrentDrawer = (this.gameState === 'DRAWING' && client.userId === this.currentGame.drawers[this.currentGame.currentDrawerIndex]);
                let isCurrentGuesser = (this.gameState === 'GUESSING' && client.userId === this.currentGame.guesser);

                if (canBeSentSomething && (isCurrentDrawer || isCurrentGuesser))
                {
                    client.send(broadcastImage);
                }
            });
            return;
        }

        switch (data.type) {
            case 'chat-message':
                this.handleChat(ws, data);
                break;
            case 'start-game':
                this.handleStartGame(ws);
                break;
        }
    }

    handleChat(ws, data) {
        const now = Date.now();
        if (!this.messageTimestamps.has(ws.userId)) this.messageTimestamps.set(ws.userId, []);
        const timestamps = this.messageTimestamps.get(ws.userId);
        const recentTimestamps = timestamps.filter(ts => now - ts < this.TIME_WINDOW_MS);
        
        if (recentTimestamps.length >= this.MESSAGE_LIMIT) {
            ws.send(JSON.stringify({ type: 'rate-limit-error', message: 'Too fast!' }));
            return;
        }
        recentTimestamps.push(now);
        this.messageTimestamps.set(ws.userId, recentTimestamps);

        const messageText = data.text;
        if (!messageText || !messageText.trim()) return;

        if (this.gameState === 'GUESSING' && ws.userId === this.currentGame.guesser) {
            const guess = messageText.trim().toLowerCase();
            const answer = this.currentGame.secretWord.toLowerCase();

            if (guess === answer) {
                if (this.currentGame.turnTimer) clearTimeout(this.currentGame.turnTimer);
                
                // NEW: Calculate score based on time remaining
                const timeElapsed = Date.now() - this.guessStartTime;
                const timeRemaining = Math.max(0, this.GUESS_DURATION_MS - timeElapsed);
                const score = this.calculateGuessScore(timeRemaining);
                
                // Add score to guesser
                this.addScore(ws.userId, score);
                
                this.broadcastGameResult('correct', ws.userId, this.currentGame.secretWord, score);
                setTimeout(() => { this.endGame('The word was guessed!'); }, 3000);
                return;
            } else {
                this.broadcastGameResult('incorrect', ws.userId, null, messageText);
            }
        }

        const messageData = { type: 'chat-message', senderId: ws.userId, text: messageText };
        this.chatHistory.push(messageData);
        if (this.chatHistory.length > this.MAX_HISTORY) this.chatHistory.shift();
        this.broadcast(JSON.stringify(messageData));
    }

    handleStartGame(ws) {
        if (this.gameState !== 'lobby') return;
        if (ws.userId !== this.hostUserId) return;
        if (this.activeUsers.size < 2) {
            ws.send(JSON.stringify({ type: 'game-start-error', message: 'Need at least 2 players.' }));
            return;
        }

        this.gameState = 'DRAWING';
        const randomWord = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
        let playerIds = Array.from(this.activeUsers.keys());
        
        for (let i = playerIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
        }

        const guesserId = playerIds[0];
        const drawerIds = playerIds.slice(1);
        
        this.currentGame = {
            guesser: guesserId,
            drawers: drawerIds,
            currentDrawerIndex: -1,
            turnTimer: null,
            secretWord: randomWord
        };

        this.activeUsers.forEach((socket, userId) => {
            let userRole = (userId === guesserId) ? 'guesser' : 'drawer';
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: 'game-started',
                    role: userRole,
                    guesser: guesserId,
                    drawers: drawerIds,
                    message: `Game Starting! You are: ${userRole}`
                }));
            }
        });
        this.startNextTurn();
    }

    startNextTurn() {
        if (!this.currentGame) return;
        if (this.currentGame.turnTimer) clearTimeout(this.currentGame.turnTimer);

        this.currentGame.currentDrawerIndex++;

        if (this.currentGame.currentDrawerIndex >= this.currentGame.drawers.length) {
            this.gameState = 'GUESSING';
            const guessEndTime = Date.now() + this.GUESS_DURATION_MS;
            
            // NEW: Track when guessing starts for score calculation
            this.guessStartTime = Date.now();

            this.currentGame.turnTimer = setTimeout(() => {
                this.endGame('Guesser ran out of time.', this.currentGame.secretWord);
            }, this.GUESS_DURATION_MS);

            const guessMessage = JSON.stringify({
                type: 'start-guessing',
                guesser: this.currentGame.guesser,
                message: 'Time to guess!',
                guessEndTime: guessEndTime
            });
            this.broadcast(guessMessage);

        } else {
            const activeDrawerId = this.currentGame.drawers[this.currentGame.currentDrawerIndex];
            const activeSocket = this.activeUsers.get(activeDrawerId);
            const turnEndTime = Date.now() + this.TURN_DURATION_MS;

            if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
                activeSocket.send(JSON.stringify({
                    type: 'yourTurn',
                    message: "Your turn!",
                    turnEndTime: turnEndTime,
                    word: this.currentGame.secretWord
                }));
            }

            const turnBroadcast = JSON.stringify({
                type: 'turn-start',
                drawerId: activeDrawerId,
                turnEndTime: turnEndTime
            });
            this.broadcastExclude(turnBroadcast, activeDrawerId);

            this.currentGame.turnTimer = setTimeout(() => {
                if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
                    activeSocket.send(JSON.stringify({ type: 'turn-end' }));
                }
                this.startNextTurn();
            }, this.TURN_DURATION_MS);
        }
    }

    endGame(reason, correctAnswer = null) {
        if (!this.currentGame) return;
        if (this.currentGame.turnTimer) clearTimeout(this.currentGame.turnTimer);

        const endMessagePayload = {
            type: 'game-ended',
            message: `Game ended: ${reason}`,
            reason: reason
        };
        if (correctAnswer) endMessagePayload.correctAnswer = correctAnswer;

        this.broadcast(JSON.stringify(endMessagePayload));

        this.currentGame = null;
        this.gameState = 'lobby';
        this.guessStartTime = null;
        
        // Broadcast final leaderboard
        this.broadcastLeaderboard();
    }

    broadcastGameResult(resultType, guesserId, secretWord, guessText = null) {
        switch (resultType) {
            case 'correct':
                // guessText now contains the score
                const score = guessText;
                this.broadcast(JSON.stringify({ 
                    type: 'guess-result', 
                    result: 'correct', 
                    correctAnswer: secretWord,
                    score: score,
                    guesser: guesserId
                }));
                break;
            case 'incorrect':
                const guesserSocket = this.activeUsers.get(guesserId);
                if (guesserSocket && guesserSocket.readyState === WebSocket.OPEN) {
                    guesserSocket.send(JSON.stringify({ 
                        type: 'guess-result', 
                        result: 'incorrect', 
                        message: `'${guessText}' is incorrect.` 
                    }));
                }
                break;
        }
    }

    broadcast(msg) {
        this.activeUsers.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(msg);
        });
    }

    broadcastExclude(msg, excludeId) {
        this.activeUsers.forEach((client, id) => {
            if (client.readyState === WebSocket.OPEN && id !== excludeId) client.send(msg);
        });
    }
    
    getUserCount() {
        return this.activeUsers.size;
    }
}
// --- End Game Room Class ---


let roomIdCounter = 1;

function broadcastRoomList() {
    const roomList = [];
    rooms.forEach((room, id) => {
        roomList.push({
            id: id,
            name: `Room ${id}`,
            players: room.getUserCount(),
            status: room.gameState
        });
    });

    const message = JSON.stringify({ type: 'room-list', rooms: roomList });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && !client.roomId && client.userId) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    ws.roomId = null; 
    ws.userId = null; 

    ws.on('message', (message) => {
        let data;
        const messageStr = message.toString();

        if (messageStr.startsWith('data:image/')) {
            if (ws.roomId && rooms.has(ws.roomId)) {
                rooms.get(ws.roomId).handleMessage(ws, null, messageStr);
            }
            return;
        }

        try { data = JSON.parse(messageStr); } catch (e) { return; }

        if (data.type === 'login') {
            ws.userId = data.username || `User_${Math.floor(Math.random() * 1000)}`;
            broadcastRoomList(); 
            return;
        }

        if (data.type === 'leave-room') {
            if (ws.roomId && rooms.has(ws.roomId)) {
                const room = rooms.get(ws.roomId);
                room.removeUser(ws.userId);
                if (room.getUserCount() === 0) rooms.delete(ws.roomId);
            }
            ws.roomId = null;
            broadcastRoomList(); 
            return;
        }

        if (!ws.roomId) {
            switch (data.type) {
                case 'create-room':
                    if (!ws.userId) return; 
                    const newRoomId = `room_${roomIdCounter++}`;
                    const newRoom = new GameRoom(newRoomId, ws.userId);
                    rooms.set(newRoomId, newRoom);
                    
                    newRoom.addUser(ws, ws.userId);
                    broadcastRoomList(); 
                    break;

                case 'join-room':
                    if (!ws.userId) return; 
                    const targetRoomId = data.roomId;
                    if (rooms.has(targetRoomId)) {
                        rooms.get(targetRoomId).addUser(ws, ws.userId);
                        broadcastRoomList(); 
                    }
                    break;
            }
        } else {
            if (rooms.has(ws.roomId)) {
                rooms.get(ws.roomId).handleMessage(ws, data, messageStr);
            }
        }
    });

    ws.on('close', () => {
        if (ws.roomId && rooms.has(ws.roomId)) {
            const room = rooms.get(ws.roomId);
            room.removeUser(ws.userId);
            if (room.getUserCount() === 0) rooms.delete(ws.roomId);
        }
        broadcastRoomList();
    });
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}`);
});
