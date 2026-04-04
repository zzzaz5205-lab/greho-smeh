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

async function getAIQuestion(isFinal = false) {
    try {
        const prompt = `Придумай один ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} для игры Quiplash на русском. Юмор: мемный, абсурдный. Только текст.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) { return isFinal ? "3 признака лысого стримера" : "Почему Ванга лысый?"; }
}

async function getAIComment(q, a1, a2) {
    try {
        const result = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши одну ОЧЕНЬ короткую (5 слов) едкую реакцию.`);
        return result.response.text().trim();
    } catch (e) { return "Это было очень странно."; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { 
            host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false,
            settings: { timer: 30, voice: 'male' }
        };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        if (room.gameStarted) return socket.emit('error-join', 'Игра уже идет!');

        // Удаляем клона по имени
        room.players = room.players.filter(p => p.name !== name);
        const player = { id: socket.id, name, emoji: '❓', score: 0 };
        room.players.push(player);

        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode });
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

        for (let i = 0; i < shuffled.length; i++) {
            let p1 = shuffled[i];
            let p2 = shuffled[(i + 1) % shuffled.length];
            let q = await getAIQuestion(roundNum === 3);
            room.pairs.push({ p1, p2, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('show-scores', { players: room.players, round: room.round });
        
        io.to(code).emit('round-started', { q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2.name, round: room.round, time: 30 });
        
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), 32000);
    }

    function forceSubmit(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        if (!pair.ans1) pair.ans1 = "...";
        if (!pair.ans2) pair.ans2 = "...";
        showVoting(code, pair);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.p1.name === name) pair.ans1 = answer;
        if (pair.p2.name === name) pair.ans2 = answer;
        if (pair.ans1 && pair.ans2) {
            clearTimeout(timers[code]);
            showVoting(code, pair);
        }
    });

    function showVoting(code, pair) {
        io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, p1: pair.p1.name, p2: pair.p2.name, time: 15 });
    }

    socket.on('cast-vote', ({ code, voteNum, name }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.finished) return;
        pair.votes.push(voteNum);
        if (pair.votes.length >= (room.players.length - 2)) {
            finishPair(code, pair);
        }
    });

    async function finishPair(code, pair) {
        if (pair.finished) return;
        pair.finished = true;
        const v1 = pair.votes.filter(v => v === 1).length;
        const v2 = pair.votes.filter(v => v === 2).length;
        pair.p1.score += v1 * 100;
        pair.p2.score += v2 * 100;

        const comm = await getAIComment(pair.q, pair.ans1, pair.ans2);
        io.to(code).emit('voting-results', { v1, v2, aiComment: comm });
        
        setTimeout(() => {
            rooms[code].currentPairIndex++;
            sendPair(code);
        }, 5000);
    }

    socket.on('next-after-scores', (code) => {
        const room = rooms[code];
        if (room.round < 3) startRound(code, room.round + 1);
        else io.to(code).emit('final-results', { players: room.players.sort((a,b)=>b.score-a.score) });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server OK'));
