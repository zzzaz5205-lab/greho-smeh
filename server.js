const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 2e7, // 20MB для аудио
    cors: { origin: "*" } 
});

app.use(express.static(__dirname));

const prompts = {
    classic: ["Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "Лучший подарок для злейшего врага?"],
    text: ["Напиши отзыв на: Пылесос для кошек", "Заголовок газеты из 2077 года"],
    draw: ["Нарисуй: Пьяный кактус", "Нарисуй: Ванга Фiйко"],
    voice: ["Запиши звук: Как кричит лысая Ванга?", "Запиши: Звук Димы Модерасса в кустах", "Запиши: Твоя реакция на подарок"]
};

const rooms = {};

io.on('connection', (socket) => {
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { host: socket.id, players: [], mode: 'classic', currentPairIndex: 0, pairs: [], gameStarted: false };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const room = rooms[code];
        if (room && !room.gameStarted) {
            socket.join(code);
            const newPlayer = { id: socket.id, name, emoji: '❓', score: 0 };
            room.players.push(newPlayer);
            io.to(room.host).emit('player-joined', newPlayer);
            socket.emit('joined-success', { code, name });
        } else {
            socket.emit('error-join', 'Комната не найдена или игра уже идет');
        }
    });

    socket.on('select-emoji', ({ code, emoji }) => {
        const room = rooms[code];
        if (room) {
            const p = room.players.find(p => p.id === socket.id);
            if (p) {
                p.emoji = emoji;
                io.to(room.host).emit('update-player-emoji', { id: socket.id, emoji });
            }
        }
    });

    socket.on('start-game', ({ code, mode }) => {
        const room = rooms[code];
        if (!room) return;
        room.mode = mode;
        room.gameStarted = true;
        room.currentPairIndex = 0;
        room.pairs = [];
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        for (let i = 0; i < shuffled.length; i += 2) {
            let qList = prompts[room.mode];
            room.pairs.push({
                p1: shuffled[i], p2: shuffled[i+1] || null,
                q: qList[Math.floor(Math.random() * qList.length)],
                ans1: null, ans2: null, votes: [], finished: false
            });
        }
        sendPair(code);
    });

    function sendPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('final-results', { players: room.players });
        io.to(code).emit('round-started', { mode: room.mode, q: pair.q, p1_id: pair.p1.id, p2_id: pair.p2 ? pair.p2.id : null });
    }

    socket.on('submit-answer', ({ code, answer }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.p1.id === socket.id) pair.ans1 = answer;
        if (pair.p2 && pair.p2.id === socket.id) pair.ans2 = answer;

        if (pair.ans1 && (!pair.p2 || pair.ans2)) {
            io.to(code).emit('show-voting', { type: room.mode, ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2 });
            if (!pair.p2) setTimeout(() => { if(rooms[code]) finishPair(code); }, 8000);
        }
    });

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        const participants = pair.p2 ? 2 : 1;
        if (pair.votes.length >= (room.players.length - participants)) finishPair(code);
    });

    function finishPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length;
        let v2 = pair.votes.filter(v => v.voteNum === 2).length;
        pair.p1.score += v1 * 100;
        if (pair.p2) pair.p2.score += v2 * 100;
        io.to(code).emit('voting-results', { 
            p1: { name: pair.p1.name, emoji: pair.p1.emoji },
            p2: pair.p2 ? { name: pair.p2.name, emoji: pair.p2.emoji } : null,
            isSolo: !pair.p2, v1, v2 
        });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 5000);
    }

    socket.on('finish-credits', (code) => {
        io.to(code).emit('go-to-menu');
        delete rooms[code];
    });

    socket.on('disconnect', () => {
        // Логика удаления игрока или уведомление хоста
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server live on ' + PORT));
