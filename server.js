const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));

const rooms = {};
let timers = {};

// Список доступных персонажей
const charTypes = ['red-angry', 'orange-evil', 'blue-sad', 'green-derpy', 'purple-smug'];

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { 
                host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false,
                settings: { timer: 30, voice: 'male' }
            };
        } else { rooms[code].host = socket.id; }
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        if (!code || !name) return;
        const cleanCode = code.trim().toUpperCase();
        const room = rooms[cleanCode];

        if (!room) return socket.emit('error-join', 'Комната не найдена!');

        // Удаляем старую сессию этого игрока (фикс клонов)
        room.players = room.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());

        // Назначаем персонажа по очереди
        const charIndex = room.players.length % charTypes.length;
        const playerChar = charTypes[charIndex];

        const player = { 
            id: socket.id, 
            name: name, 
            char: playerChar, 
            score: 0, 
            lastPoints: 0 
        };
        
        room.players.push(player);
        socket.join(cleanCode);

        // ОТПРАВЛЯЕМ ПОДТВЕРЖДЕНИЕ (Важно: передаем объект)
        socket.emit('joined-success', { code: cleanCode, char: playerChar });
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) {
            room.gameStarted = true;
            startRound(code, 1);
        }
    });

    async function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum;
        room.currentPairIndex = 0;
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];
        
        for (let i = 0; i < shuffled.length; i += 2) {
            const q = "Почему Ванга лысый?"; // Для теста, потом добавим ИИ
            room.pairs.push({ p1: shuffled[i], p2: shuffled[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('show-scores', { players: room.players, round: room.round });
        
        io.to(code).emit('round-started', { 
            round: room.round, q: pair.q, 
            p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null 
        });
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.p1.name === name) pair.ans1 = answer;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = answer;
        
        if (pair.ans1 && (!pair.p2 || pair.ans2)) {
            io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null });
        }
    });

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.finished) return;
        pair.finished = true;
        let mult = 100;
        if (voteNum === 1) pair.p1.score += mult;
        if (voteNum === 2 && pair.p2) pair.p2.score += mult;
        
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2 });
        setTimeout(() => {
            room.currentPairIndex++;
            sendPair(code);
        }, 4000);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server is running...'));
