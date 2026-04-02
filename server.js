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

const prompts = ["Почему vangavgav лысый?", "Что скрывает Ванга?", "Худшая фраза хирурга?", "За что Дима Moderass любит Вангу?"];
const rooms = {};
let timers = {};

async function getAIQuestion() {
    try {
        const result = await aiModel.generateContent('Придумай 1 смешной и очень короткий вопрос для пати-игры на русском в стиле Quiplash.');
        return result.response.text().trim();
    } catch (e) { return prompts[Math.floor(Math.random()*prompts.length)]; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 30, voice: 'male' } };
        } else { rooms[code].host = socket.id; }
        socket.join(code);
        socket.emit('room-created', code);
        io.to(code).emit('player-list-update', rooms[code].players);
    });

    socket.on('join-room', ({ code, name }) => {
        const c = code?.trim().toUpperCase();
        const r = rooms[c];
        if (!r) return socket.emit('error-join', 'Комната не найдена!');
        
        let p = r.players.find(player => player.name === name);
        if (p) { p.id = socket.id; } 
        else {
            if (r.gameStarted) return socket.emit('error-join', 'Игра уже идет!');
            p = { id: socket.id, name, emoji: '❓', score: 0 };
            r.players.push(p);
        }
        
        socket.join(c);
        socket.emit('joined-success', { code: c, gameStarted: r.gameStarted });
        io.to(r.host).emit('player-list-update', r.players);
    });

    socket.on('select-emoji', ({ code, name, emoji }) => {
        const r = rooms[code];
        const p = r?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(r.host).emit('player-list-update', r.players); }
    });

    socket.on('start-game', (code) => {
        const r = rooms[code];
        if (r && r.players.length >= 2) {
            r.gameStarted = true;
            startRound(code, 1);
        }
    });

    async function startRound(code, roundNum) {
        const r = rooms[code];
        r.round = roundNum; r.currentPairIndex = 0;
        let shuf = [...r.players].sort(() => 0.5 - Math.random());
        r.pairs = [];
        for (let i = 0; i < shuf.length; i += 2) {
            const q = await getAIQuestion();
            r.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [] });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code];
        const p = r.pairs[r.currentPairIndex];
        if (!p) return io.to(code).emit('show-scores', r.players);
        io.to(code).emit('round-started', { q: p.q, p1: p.p1.name, p2: p.p2 ? p.p2.name : null });
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code];
        const p = r.pairs[r.currentPairIndex];
        if (p.p1.name === name) p.ans1 = answer;
        if (p.p2 && p.p2.name === name) p.ans2 = answer;
        if (p.ans1 && (!p.p2 || p.ans2)) {
            io.to(code).emit('show-voting', { ans1: p.ans1, ans2: p.ans2, p1: p.p1.name, p2: p.p2 ? p.p2.name : null });
        }
    });

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code];
        const p = r.pairs[r.currentPairIndex];
        p.votes.push(voteNum);
        if (p.votes.length >= (r.players.length - (p.p2 ? 2 : 1))) {
            let v1 = p.votes.filter(v=>v===1).length, v2 = p.votes.filter(v=>v===2).length;
            p.p1.score += v1*100; if(p.p2) p.p2.score += v2*100;
            io.to(code).emit('voting-results', { v1, v2, p1: p.p1.name, p2: p.p2 ? p.p2.name : null });
            setTimeout(() => { r.currentPairIndex++; sendPair(code); }, 5000);
        }
    });
});
server.listen(process.env.PORT || 3000);
