const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 1e7, 
    cors: { origin: "*" } 
});

// ПРЯМЫЕ ПУТИ ДЛЯ RENDER (Ищет в корне)
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host.html', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player.html', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));

const prompts = {
    classic: [
        "Почему vangavgav лысый?", 
        "Почему Дима Moderass каждый раз д#оч#т на vangavgav?",
        "Самое странное название для туалетной бумаги?", 
        "Что на самом деле шепчут кошки?", 
        "Лучший подарок для злейшего врага?", 
        "Девиз школы магии для очень ленивых.",
        "Что Ванга скрывает под кепкой?", 
        "Худшая фраза от хирурга перед сном."
    ],
    text: ["Напиши отзыв на: Пылесос для кошек", "Заголовок газеты из 2077 года", "Жалоба на: Слишком яркое солнце"],
    draw: ["Нарисуй: Пьяный кактус", "Нарисуй: Ванга Фiйко", "Нарисуй: Танцующий стул", "Нарисуй: Грустный чебурек"]
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
            socket.emit('joined-success', code);
        }
    });

    socket.on('start-game', ({ code, mode }) => {
        const room = rooms[code];
        if (!room) return;
        room.mode = mode;
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

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.p1.name === name) pair.ans1 = answer;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = answer;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) {
            io.to(code).emit('show-voting', { type: room.mode, ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2 });
            if (!pair.p2) setTimeout(() => { if(rooms[code]) finishPair(code); }, 8000);
        }
    });

    socket.on('cast-vote', ({ code, voteNum, voterName }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: voterName, voteNum });
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
        io.to(code).emit('voting-results', { p1_name: pair.p1.name, p1_emoji: pair.p1.emoji, p2_name: pair.p2 ? pair.p2.name : null, p2_emoji: pair.p2 ? pair.p2.emoji : null, isSolo: !pair.p2, v1, v2 });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 5000);
    }

    socket.on('kick-all', (code) => io.to(code).emit('go-to-menu'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Live on ' + PORT));
