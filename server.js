const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));

const questions = ["Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "Самое странное название для туалетной бумаги?", "За что Дима Moderass любит Вангу?"];
const rooms = {};
let timers = {};

io.on('connection', (socket) => {
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const c = code?.toUpperCase();
        const r = rooms[c];
        if (!r) return socket.emit('error-join', 'Комната не найдена!');
        r.players = r.players.filter(p => p.name !== name);
        const p = { id: socket.id, name, emoji: '❓', score: 0 };
        r.players.push(p);
        socket.join(c);
        socket.emit('joined-success', { code: c });
        io.to(r.host).emit('player-list-update', r.players);
    });

    socket.on('start-game', (code) => {
        const r = rooms[code];
        if (r && r.players.length >= 2) {
            r.gameStarted = true;
            startRound(code, 1);
        }
    });

    function startRound(code, roundNum) {
        const r = rooms[code];
        r.round = roundNum;
        r.currentPairIndex = 0;
        let shuffled = [...r.players].sort(() => 0.5 - Math.random());
        r.pairs = [];
        for (let i = 0; i < shuffled.length; i += 2) {
            r.pairs.push({ p1: shuffled[i], p2: shuffled[i+1] || null, q: questions[Math.floor(Math.random()*questions.length)], ans1: null, ans2: null, votes: [] });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code];
        const p = r.pairs[r.currentPairIndex];
        if (!p) return io.to(code).emit('show-scores', r.players);
        
        // Запускаем таймер на 30 секунд для ответа
        io.to(code).emit('round-started', { q: p.q, p1: p.p1.name, p2: p.p2 ? p.p2.name : null, time: 30 });
        
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), 31000);
    }

    function forceSubmit(code) {
        const r = rooms[code];
        const p = r.pairs[r.currentPairIndex];
        if(!p.ans1) p.ans1 = "..."; if(p.p2 && !p.ans2) p.ans2 = "...";
        showVoting(code, p);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code];
        const p = r.pairs[r.currentPairIndex];
        if (p.p1.name === name) p.ans1 = answer;
        if (p.p2 && p.p2.name === name) p.ans2 = answer;
        if (p.ans1 && (!p.p2 || p.ans2)) {
            clearTimeout(timers[code]);
            showVoting(code, p);
        }
    });

    function showVoting(code, p) {
        // Запускаем таймер на 15 секунд для голосования
        io.to(code).emit('show-voting', { ans1: p.ans1, ans2: p.ans2, p1: p.p1.name, p2: p.p2 ? p.p2.name : null, time: 15 });
        if(!p.p2) setTimeout(() => nextPair(code), 5000);
        else timers[code] = setTimeout(() => nextPair(code), 16000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code];
        const p = r.pairs[r.currentPairIndex];
        p.votes.push(voteNum);
        if (p.votes.length >= (r.players.length - (p.p2 ? 2 : 1))) {
            clearTimeout(timers[code]);
            nextPair(code);
        }
    });

    function nextPair(code) {
        const r = rooms[code];
        const p = r.pairs[r.currentPairIndex];
        let v1 = p.votes.filter(v=>v===1).length, v2 = p.votes.filter(v=>v===2).length;
        p.p1.score += v1*100; if(p.p2) p.p2.score += v2*100;
        io.to(code).emit('voting-results', { v1, v2, p1: p.p1.name, p2: p.p2 ? p.p2.name : null });
        setTimeout(() => { r.currentPairIndex++; sendPair(code); }, 4000);
    }

    socket.on('next-after-scores', code => {
        if(rooms[code].round < 3) startRound(code, rooms[code].round+1);
        else io.to(code).emit('final-results', rooms[code].players.sort((a,b)=>b.score-a.score));
    });
});
server.listen(process.env.PORT || 3000);
