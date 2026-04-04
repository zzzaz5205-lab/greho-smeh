const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 4e7, // 40MB для тяжелых рисунков и аудио
    cors: { origin: "*" } 
});

const genAI = new GoogleGenerativeAI("AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64");
const aiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));

const prompts = {
    ru: {
        classic: ["Почему Ванга лысый?", "Секрет Димы Модерасса", "За что Ванга любит перфоратор?"],
        draw: ["Нарисуй: Пьяный кактус", "Нарисуй: Лицо Димы в 3 утра", "Нарисуй: Лысина Ванги"],
        voice: ["Издай звук: Крик чайки", "Звук: Перфоратор Ванги", "Звук: Дима дает бан"]
    }
};

const rooms = {};
let timers = {};

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { 
                host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], 
                gameStarted: false, allJokes: [], mode: 'classic',
                settings: { timer: 30, voice: 'male', hellMode: false, bonusX2: true, eighteenPlus: false } 
            };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        room.players = room.players.filter(p => p.name !== name);
        const p = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(p);
        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode, settings: room.settings });
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('update-settings', ({ code, settings, mode }) => {
        if (rooms[code]) { 
            rooms[code].settings = settings; 
            rooms[code].mode = mode;
        }
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) { room.gameStarted = true; startRound(code, 1); }
    });

    async function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum; room.currentPairIndex = 0; room.pairs = [];
        let shuf = [...room.players].sort(() => 0.5 - Math.random());
        
        let qList = prompts.ru[room.mode] || prompts.ru.classic;
        for (let i = 0; i < shuf.length; i += 2) {
            let q = qList[Math.floor(Math.random() * qList.length)];
            room.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair) {
            io.to(code).emit('show-scores', { players: room.players, round: room.round, time: 10 });
            return;
        }
        io.to(code).emit('round-started', { mode: room.mode, round: room.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2?.name, time: room.settings.timer });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    function forceSubmit(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        if (!pair.ans1) pair.ans1 = "EMPTY"; if (pair.p2 && !pair.ans2) pair.ans2 = "EMPTY";
        showVoting(code, pair, room.mode);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code]; const pair = room?.pairs[room.currentPairIndex];
        if (!pair) return;
        if (pair.p1.name === name) pair.ans1 = answer;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = answer;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { clearTimeout(timers[code]); showVoting(code, pair, room.mode); }
    });

    function showVoting(code, pair, mode) {
        const isBothEmpty = (pair.ans1 === "EMPTY" && pair.ans2 === "EMPTY");
        io.to(code).emit('show-voting', { type: mode, ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, bothEmpty: isBothEmpty, p1_name: pair.p1.name, p2_name: pair.p2?.name, time: 20 });
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) finishPair(code);
    });

    function finishPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length, v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let p1Points = !pair.p2 ? 100 : v1 * 100;
        let p2Points = v2 * 100;
        
        if (pair.ans1 && pair.ans1 !== "EMPTY") room.allJokes.push({ text: room.mode === 'classic' ? pair.ans1 : `[${room.mode}]`, author: pair.p1.name, votes: v1, emoji: pair.p1.emoji });
        if (pair.p2 && pair.ans2 !== "EMPTY") room.allJokes.push({ text: room.mode === 'classic' ? pair.ans2 : `[${room.mode}]`, author: pair.p2.name, votes: v2, emoji: pair.p2.emoji });

        pair.p1.score += p1Points; if (pair.p2) pair.p2.score += p2Points;
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2, p1Points, p2Points });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }

    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });

    socket.on('next-after-scores', (code) => {
        const room = rooms[code];
        if (room.round < 3) startRound(code, room.round + 1);
        else {
            const best = [...room.allJokes].sort((a,b) => b.votes - a.votes).slice(0, 5);
            const worst = room.allJokes.filter(j => j.votes === 0).slice(0, 5);
            io.to(code).emit('final-results', { players: room.players.sort((a,b)=>b.score-a.score), best, worst });
        }
    });

    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

server.listen(process.env.PORT || 3000);
