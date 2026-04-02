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
    ru: {
        classic: ["Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "Худшая фраза хирурга?", "Название для туалетной бумаги.", "За что Дима Модерасс любит Вангу?"],
        text: ["Отзыв на: Пылесос для кошек", "Заголовок газеты из 2077 года", "Жалоба на: Солнечный свет"],
        draw: ["Нарисуй: Пьяный кактус", "Нарисуй: Ванга Фiйко", "Нарисуй: Танцующий стул"],
        voice: ["Звук: Как кричит Ванга?", "Звук: Реакция на бан", "Звук: Озвучь падающий шкаф"]
    },
    en: {
        classic: ["Why is the sun hot?", "Worst thing to say at a wedding?", "Secret ingredient in a bad soup?"],
        text: ["Review for: A broken car", "News headline from 3050"],
        draw: ["Draw: Alien disco", "Draw: Sad potato"],
        voice: ["Sound: Scary laugh", "Sound: Winning lottery"]
    }
};

const rooms = {};
let timers = {};

io.on('connection', (socket) => {
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { host: socket.id, players: [], mode: 'classic', round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 30, maxPlayers: 12, lang: 'ru', voice: 'male', bonusX2: true } };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        if (room.gameStarted) return socket.emit('error-join', 'Игра уже идет!');

        // ФИКС КЛОНОВ: Удаляем старого игрока с таким же именем, если он есть
        room.players = room.players.filter(p => p.name !== name);

        if (room.players.length >= room.settings.maxPlayers) return socket.emit('error-join', 'Мест нет!');

        const player = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(player);
        socket.join(cleanCode);
        io.to(room.host).emit('player-list-update', room.players);
        socket.emit('joined-success', { code: cleanCode, settings: room.settings });
    });

    socket.on('update-settings', ({ code, settings }) => { if (rooms[code]) { rooms[code].settings = settings; io.to(code).emit('settings-updated', settings); } });

    socket.on('start-game', ({ code, mode }) => {
        const room = rooms[code]; if (!room) return;
        room.mode = mode; room.gameStarted = true;
        startRound(code, 1);
    });

    function startRound(code, roundNum) {
        const room = rooms[code]; room.round = roundNum; room.currentPairIndex = 0;
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];
        const langPack = prompts[room.settings.lang] || prompts['ru'];
        for (let i = 0; i < shuffled.length; i += 2) {
            room.pairs.push({ p1: shuffled[i], p2: shuffled[i+1] || null, q: langPack[room.mode][Math.floor(Math.random()*langPack[room.mode].length)], ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code], pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('show-scores', { players: room.players, round: room.round });
        io.to(code).emit('round-started', { mode: room.mode, round: room.round, q: pair.q, p1_id: pair.p1.id, p2_id: pair.p2 ? pair.p2.id : null, settings: room.settings });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    socket.on('submit-answer', ({ code, answer }) => {
        const room = rooms[code], pair = room.pairs[room.currentPairIndex];
        if (!pair) return;
        if (pair.p1.id === socket.id) pair.ans1 = answer;
        if (pair.p2 && pair.p2.id === socket.id) pair.ans2 = answer;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { clearTimeout(timers[code]); showVoting(code, pair, room.mode); }
    });

    function showVoting(code, pair, mode) {
        io.to(code).emit('show-voting', { type: mode, ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, settings: rooms[code].settings, p1_id: pair.p1.id, p2_id: pair.p2 ? pair.p2.id : null });
        if (!pair.p2) setTimeout(() => finishPair(code), 6000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code], pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) finishPair(code);
    });

    function finishPair(code) {
        const room = rooms[code], pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length, v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = (room.round === 3 && room.settings.bonusX2) ? 200 : 100;
        pair.p1.lastPoints = v1 * mult; pair.p1.score += pair.p1.lastPoints;
        if (pair.p2) { pair.p2.lastPoints = v2 * mult; pair.p2.score += pair.p2.lastPoints; }
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2 });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 5000);
    }

    socket.on('next-after-scores', (code) => {
        const room = rooms[code]; if (!room) return;
        if (room.round < 3) startRound(code, room.round + 1);
        else io.to(code).emit('final-results', { players: room.players.sort((a,b) => b.score - a.score) });
    });

    socket.on('select-emoji', ({ code, emoji }) => {
        const room = rooms[code]; if (room) { const p = room.players.find(pl => pl.id === socket.id); if (p) { p.emoji = emoji; io.to(room.host).emit('player-list-update', room.players); } }
    });

    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

server.listen(process.env.PORT || 3000);
