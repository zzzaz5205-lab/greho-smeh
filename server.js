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
        classic: ["Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "Худшая фраза хирурга?", "Название для туалетной бумаги."],
        final: ["Напиши 3 вещи, которые нельзя делать в гостях", "3 причины не доверять Диме Модерассу", "3 признака, что ты лысеешь"]
    }
};

const rooms = {};
let timers = {};

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        if (oldCode && rooms[oldCode]) {
            rooms[oldCode].host = socket.id;
            socket.join(oldCode);
            socket.emit('room-created', oldCode);
            return;
        }
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { 
            host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false,
            settings: { timer: 30, lang: 'ru', voice: 'male', moderation: false }
        };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');

        let player = room.players.find(p => p.name === name);
        if (player) {
            player.id = socket.id; // Переподключение
        } else {
            if (room.gameStarted) return socket.emit('error-join', 'Игра уже идет!');
            player = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
            room.players.push(player);
        }

        socket.join(cleanCode);
        io.to(room.host).emit('player-list-update', room.players);
        socket.emit('joined-success', { code: cleanCode, settings: room.settings });
    });

    socket.on('update-settings', ({ code, settings }) => {
        if (rooms[code]) {
            rooms[code].settings = settings;
            io.to(code).emit('settings-updated', settings);
        }
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (!room) return;
        room.gameStarted = true;
        startRound(code, 1);
    });

    function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum;
        room.currentPairIndex = 0;
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];
        
        const qList = (roundNum === 3) ? prompts[room.settings.lang].final : prompts[room.settings.lang].classic;

        for (let i = 0; i < shuffled.length; i += 2) {
            room.pairs.push({
                p1: shuffled[i], p2: shuffled[i+1] || null,
                q: qList[Math.floor(Math.random() * qList.length)],
                ans1: null, ans2: null, votes: [], finished: false
            });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('show-scores', { players: room.players, round: room.round });
        
        io.to(code).emit('round-started', { round: room.round, q: pair.q, p1_id: pair.p1.id, p2_id: pair.p2 ? pair.p2.id : null, settings: room.settings });

        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    socket.on('submit-answer', ({ code, answer }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        const content = Array.isArray(answer) ? answer.join(' | ') : answer;

        if (pair.p1.id === socket.id) pair.ans1 = content;
        if (pair.p2 && pair.p2.id === socket.id) pair.ans2 = content;
        
        if (pair.ans1 && (!pair.p2 || pair.ans2)) {
            clearTimeout(timers[code]);
            io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, settings: room.settings });
            if (!pair.p2) setTimeout(() => finishPair(code), 6000);
        }
    });

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) finishPair(code);
    });

    function finishPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.finished = true;

        let v1 = pair.votes.filter(v => v.voteNum === 1).length;
        let v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = (room.round === 3) ? 200 : 100;
        
        pair.p1.score += v1 * mult;
        if (pair.p2) pair.p2.score += v2 * mult;

        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2 });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 5000);
    }

    socket.on('next-after-scores', (code) => {
        const room = rooms[code];
        if (room.round < 3) startRound(code, room.round + 1);
        else io.to(code).emit('final-results', { players: room.players.sort((a,b) => b.score - a.score) });
    });

    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

server.listen(process.env.PORT || 3000);
