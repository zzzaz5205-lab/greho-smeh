const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));

// БАЗА ВОПРОСОВ НА РАЗНЫХ ЯЗЫКАХ
const prompts = {
    ru: {
        classic: ["Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "Худшая фраза хирурга?", "Придумай название для туалетной бумаги."],
        text: ["Отзыв на: Пылесос для кошек", "Заголовок газеты из 2077 года"],
        draw: ["Нарисуй: Пьяный кактус", "Нарисуй: Ванга Фiйко"],
        voice: ["Звук: Как кричит Ванга?", "Звук: Реакция на бан"]
    },
    en: {
        classic: ["Why is the sun hot?", "Worst thing to say at a wedding?", "Secret ingredient in a bad soup?", "Name for a boring superhero."],
        text: ["Review for: A broken umbrella", "News headline from year 3000"],
        draw: ["Draw: A rich potato", "Draw: Alien dancing disco"],
        voice: ["Sound: Scary ghost laugh", "Sound: Your reaction to winning a million dollars"]
    },
    zh: {
        classic: ["为什么猫会喵喵叫？", "婚礼上最不该说的话？", "给无聊的超级英雄起个名字。"],
        text: ["评价：一把坏掉 y 的雨伞", "来自3000年的新闻头条"],
        draw: ["画：一个有钱的土豆", "画：外星人跳迪斯科"],
        voice: ["声音：恐怖的鬼笑", "声音：赢得一百万后的反应"]
    }
};

const rooms = {};
let timers = {};

io.on('connection', (socket) => {
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { 
            host: socket.id, players: [], mode: 'classic', round: 1, currentPairIndex: 0, pairs: [], gameStarted: false,
            settings: { timer: 30, maxPlayers: 12, lang: 'ru', voice: 'male', bonusX2: true }
        };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const room = rooms[code];
        if (!room) return socket.emit('error-join', 'Room not found!');
        if (room.gameStarted) return socket.emit('error-join', 'Game already started!');
        const player = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(player);
        socket.join(code);
        io.to(room.host).emit('player-list-update', room.players);
        socket.emit('joined-success', { code, settings: room.settings });
    });

    socket.on('update-settings', ({ code, settings }) => {
        if (rooms[code]) {
            rooms[code].settings = settings;
            io.to(code).emit('settings-updated', settings);
        }
    });

    socket.on('start-game', ({ code, mode }) => {
        const room = rooms[code];
        if (!room) return;
        room.mode = mode;
        room.gameStarted = true;
        startRound(code, 1);
    });

    function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum;
        room.currentPairIndex = 0;
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];
        const langPrompts = prompts[room.settings.lang][room.mode];
        for (let i = 0; i < shuffled.length; i += 2) {
            room.pairs.push({
                p1: shuffled[i], p2: shuffled[i+1] || null,
                q: langPrompts[Math.floor(Math.random() * langPrompts.length)],
                ans1: null, ans2: null, votes: [], finished: false
            });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('show-scores', { players: room.players, round: room.round });
        io.to(code).emit('round-started', { mode: room.mode, round: room.round, q: pair.q, p1_id: pair.p1.id, p2_id: pair.p2 ? pair.p2.id : null, settings: room.settings });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    socket.on('next-after-scores', (code) => {
        const room = rooms[code];
        if (room.round < 3) startRound(code, room.round + 1);
        else io.to(code).emit('final-results', { players: room.players.sort((a,b) => b.score - a.score) });
    });

    socket.on('submit-answer', ({ code, answer }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.p1.id === socket.id) pair.ans1 = answer;
        if (pair.p2 && pair.p2.id === socket.id) pair.ans2 = answer;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { clearTimeout(timers[code]); showVoting(code, pair, room.mode); }
    });

    function showVoting(code, pair, mode) {
        io.to(code).emit('show-voting', { type: mode, ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, settings: rooms[code].settings });
        if (!pair.p2) setTimeout(() => finishPair(code), 6000);
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
        let mult = (room.round === 3 && room.settings.bonusX2) ? 200 : 100;
        pair.p1.lastPoints = v1 * mult; pair.p1.score += pair.p1.lastPoints;
        if (pair.p2) { pair.p2.lastPoints = v2 * mult; pair.p2.score += pair.p2.lastPoints; }
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2 });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 5000);
    }
    socket.on('select-emoji', ({ code, emoji }) => {
        const room = rooms[code]; if (room) { const p = room.players.find(pl => pl.id === socket.id); if (p) { p.emoji = emoji; io.to(room.host).emit('player-list-update', room.players); } }
    });
    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

server.listen(process.env.PORT || 3000);
