const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 }); // Увеличили буфер для картинок

app.use(express.static(__dirname));

const prompts = {
    classic: ["Самое странное название для туалетной бумаги?", "Что шепчут кошки?"],
    text: ["Напиши самый плохой отзыв на: Пылесос", "Напиши отзыв на: Огурец"],
    draw: ["Нарисуй: Пьяный единорог", "Нарисуй: Танцующий кактус", "Нарисуй: Ванга Фiйко"]
};

const rooms = {};

io.on('connection', (socket) => {
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { host: socket.id, players: [], mode: 'classic', currentPairIndex: 0, pairs: [] };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name, emoji }) => {
        const room = rooms[code];
        if (room) {
            socket.join(code);
            room.players.push({ id: socket.id, name, emoji, score: 0 });
            io.to(room.host).emit('player-joined', { name, emoji });
            socket.emit('joined-success');
        }
    });

    socket.on('start-game', ({ code, mode }) => {
        const room = rooms[code];
        if (!room) return;
        room.mode = mode;
        setupRound(code);
    });

    function setupRound(code) {
        const room = rooms[code];
        room.currentPairIndex = 0;
        room.pairs = [];
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        for (let i = 0; i < shuffled.length; i += 2) {
            let qList = prompts[room.mode];
            room.pairs.push({
                p1: shuffled[i], p2: shuffled[i+1] || null,
                q: qList[Math.floor(Math.random() * qList.length)],
                ans1: null, ans2: null, votes: []
            });
        }
        startPair(code);
    }

    function startPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('game-over');
        io.to(code).emit('round-started', { mode: room.mode, q: pair.q, p1_id: pair.p1.id, p2_id: pair.p2 ? pair.p2.id : null });
    }

    socket.on('submit-answer', ({ code, name, answer, type }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.p1.name === name) pair.ans1 = answer;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = answer;
        
        if (pair.ans1 && (!pair.p2 || pair.ans2)) {
            io.to(code).emit('show-voting', { type: room.mode, ans1: pair.ans1, ans2: pair.ans2 });
        }
    });

    socket.on('cast-vote', ({ code, voteNum, voterName }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        pair.votes.push({ voter: voterName, voteNum });
        if (pair.votes.length >= 1) {
            io.to(code).emit('voting-results', { 
                p1_name: pair.p1.name, p1_emoji: pair.p1.emoji,
                p2_name: pair.p2 ? pair.p2.name : "Бот", p2_emoji: "🤖"
            });
            setTimeout(() => { room.currentPairIndex++; startPair(code); }, 4000);
        }
    });
});

server.listen(process.env.PORT || 3000);
