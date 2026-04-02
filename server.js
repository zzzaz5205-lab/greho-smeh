const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

app.use(express.static(__dirname));

// Маршруты
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));
app.get('/mod', (req, res) => res.sendFile(path.resolve(__dirname, 'mod.html')));

const prompts = {
    ru: {
        classic: ["Почему vangavgav лысый?", "Что скрывает Ванга?", "Худшая фраза хирурга?", "Назови туалетную бумагу.", "За что Дима Moderass любит Вангу?"],
        final: ["Напиши 3 вещи, которые нельзя делать в гостях", "3 причины не доверять Диме Модерассу", "3 признака, что ты лысеешь"]
    }
};

const rooms = {};
let timers = {};

io.on('connection', (socket) => {
    // Создание комнаты хостом
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { 
                host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false,
                settings: { timer: 30, lang: 'ru', voice: 'male', moderation: false }, modId: null
            };
        } else { rooms[code].host = socket.id; }
        socket.join(code);
        socket.emit('room-created', code);
        io.to(code).emit('player-list-update', rooms[code].players);
    });

    // Вход игрока (Фикс клонов)
    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');

        // Если игрок с таким именем уже был, просто обновляем его сокет
        room.players = room.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());

        if (!room.gameStarted && room.players.length >= 12) return socket.emit('error-join', 'Мест нет!');

        const player = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(player);

        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode, settings: room.settings });
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('update-settings', ({ code, settings }) => {
        if (rooms[code]) { rooms[code].settings = settings; io.to(code).emit('settings-updated', settings); }
    });

    socket.on('join-mod', (code) => {
        if (rooms[code]) { rooms[code].modId = socket.id; socket.join(code.toUpperCase()); socket.emit('mod-success'); }
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) {
            room.gameStarted = true;
            startRound(code, 1);
        }
    });

    function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum;
        room.currentPairIndex = 0;
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];
        const qList = (roundNum === 3) ? prompts.ru.final : prompts.ru.classic;
        for (let i = 0; i < shuffled.length; i += 2) {
            room.pairs.push({ p1: shuffled[i], p2: shuffled[i+1] || null, q: qList[Math.floor(Math.random()*qList.length)], ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('show-scores', { players: room.players, round: room.round });
        
        io.to(code).emit('round-started', { round: room.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, settings: room.settings });

        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code];
        const pair = room?.pairs[room.currentPairIndex];
        if (!pair) return;
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        
        if (room.settings.moderation && room.modId) {
            io.to(room.modId).emit('mod-check', { playerId: socket.id, playerName: name, text: txt });
        } else { applyAns(code, pair, name, txt); }
    });

    socket.on('mod-action', ({ code, playerName, text, action }) => {
        const room = rooms[code];
        applyAns(code, room.pairs[room.currentPairIndex], playerName, action === 'block' ? "ЗАБЛОКИРОВАНО" : text);
    });

    function applyAns(code, pair, name, txt) {
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;

        if (pair.ans1 && (!pair.p2 || pair.ans2)) { 
            clearTimeout(timers[code]); 
            io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null }); 
            
            // Таймер на голосование (20 секунд)
            timers[code] = setTimeout(() => finishPair(code), 22000);
        }
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        const needed = room.players.length - (pair.p2 ? 2 : 1);
        if (pair.votes.length >= Math.max(needed, 1)) {
            clearTimeout(timers[code]);
            finishPair(code);
        }
    });

    function finishPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length, v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = (room.round === 3) ? 200 : 100;
        pair.p1.score += v1 * mult; if (pair.p2) pair.p2.score += v2 * mult;
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2 });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 5000);
    }

    socket.on('next-after-scores', (code) => {
        const room = rooms[code];
        if (room.round < 3) startRound(code, room.round + 1);
        else io.to(code).emit('final-results', { players: room.players.sort((a,b)=>b.score-a.score) });
    });

    socket.on('select-emoji', ({ code, name, emoji }) => {
        const room = rooms[code]; const p = room?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', room.players); }
    });

    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

server.listen(process.env.PORT || 3000);
