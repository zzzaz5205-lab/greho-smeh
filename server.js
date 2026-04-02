const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));

const prompts = {
    classic: ["Почему vangavgav лысый?", "Почему Дима Moderass д#очит на Вангу?", "Что Ванга скрывает под кепкой?"],
    text: ["Напиши отзыв на: Пылесос для кошек", "Заголовок газеты из 2077 года", "Жалоба на: Слишком яркое солнце"],
    draw: ["Нарисуй: Пьяный кактус", "Нарисуй: Ванга Фiйко", "Нарисуй: Танцующий стул"],
    voice: ["Звук: Как кричит Ванга в лесу?", "Звук: Твоя реакция на бан", "Звук: Озвучь падающий шкаф"]
};

const defaultAns = ["Я промолчал...", "Мозг покинул чат", "Просто смотрел в стену"];
const rooms = {};
let timers = {};

io.on('connection', (socket) => {
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { 
            host: socket.id, players: [], mode: 'classic', currentPairIndex: 0, pairs: [], gameStarted: false,
            settings: { timer: 30, maxPlayers: 12, allowMates: true, bonusX2: false, voice: 'male', subs: true }
        };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const room = rooms[code];
        if (!room) return socket.emit('error-join', 'Комнаты не существует!');
        if (room.gameStarted) return socket.emit('error-join', 'Игра уже началась!');

        // ЖЕСТКИЙ ФИКС ДУБЛИКАТОВ: Проверяем по имени
        const existingIdx = room.players.findIndex(p => p.name === name);
        if (existingIdx !== -1) {
            room.players[existingIdx].id = socket.id; // Обновляем сокет, если переподключился
        } else {
            if (room.players.length >= room.settings.maxPlayers) return socket.emit('error-join', 'Комната полная!');
            const player = { id: socket.id, name, emoji: '❓', score: 0 };
            room.players.push(player);
        }

        socket.join(code);
        io.to(room.host).emit('player-list-update', room.players); // Шлем весь список сразу
        socket.emit('joined-success', code);
    });

    socket.on('select-emoji', ({ code, emoji }) => {
        const room = rooms[code];
        if (room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if (p) { p.emoji = emoji; io.to(room.host).emit('player-list-update', room.players); }
        }
    });

    socket.on('update-settings', ({ code, settings }) => { if (rooms[code]) rooms[code].settings = settings; });

    socket.on('start-game', ({ code, mode }) => {
        const room = rooms[code];
        if (!room) return;
        room.mode = mode; room.gameStarted = true; room.currentPairIndex = 0;
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];
        for (let i = 0; i < shuffled.length; i += 2) {
            room.pairs.push({
                p1: shuffled[i], p2: shuffled[i+1] || null,
                q: prompts[room.mode][Math.floor(Math.random()*prompts[room.mode].length)],
                ans1: null, ans2: null, votes: [], finished: false
            });
        }
        sendPair(code);
    });

    function sendPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('final-results', { players: room.players });
        io.to(code).emit('round-started', { mode: room.mode, q: pair.q, p1_id: pair.p1.id, p2_id: pair.p2 ? pair.p2.id : null, settings: room.settings });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    function forceSubmit(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        if (!pair.ans1) pair.ans1 = room.mode === 'voice' ? 'EMPTY' : defaultAns[Math.floor(Math.random()*defaultAns.length)];
        if (pair.p2 && !pair.ans2) pair.ans2 = room.mode === 'voice' ? 'EMPTY' : defaultAns[Math.floor(Math.random()*defaultAns.length)];
        showVoting(code, pair, room.mode);
    }

    socket.on('submit-answer', ({ code, answer }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (pair.p1.id === socket.id) pair.ans1 = answer;
        if (pair.p2 && pair.p2.id === socket.id) pair.ans2 = answer;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { clearTimeout(timers[code]); showVoting(code, pair, room.mode); }
    });

    function showVoting(code, pair, mode) {
        io.to(code).emit('show-voting', { type: mode, ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, settings: rooms[code].settings });
        if (!pair.p2) setTimeout(() => finishPair(code), 8000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) finishPair(code);
    });

    function finishPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length;
        let v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = room.settings.bonusX2 ? 200 : 100;
        pair.p1.score += v1 * mult; if (pair.p2) pair.p2.score += v2 * mult;
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2 });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 5000);
    }

    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

server.listen(process.env.PORT || 3000);
