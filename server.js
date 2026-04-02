const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 2e7, 
    cors: { origin: "*" } 
});

app.use(express.static(__dirname));

// Принудительные пути для Render
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host.html', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player.html', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));

const prompts = {
    ru: {
        classic: ["Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "Худшая фраза хирурга?", "Название для туалетной бумаги.", "За что Дима Модерасс любит Вангу?"],
        text: ["Отзыв на: Пылесос для кошек", "Заголовок газеты из 2077 года", "Жалоба на: Слишком яркое солнце"],
        draw: ["Нарисуй: Пьяный кактус", "Нарисуй: Ванга Фiйко", "Нарисуй: Танцующий стул"],
        voice: ["Звук: Как кричит Ванга?", "Звук: Реакция на бан", "Звук: Озвучь падающий шкаф"]
    },
    en: {
        classic: ["Why is the sun hot?", "Worst thing to say at a funeral?", "Secret ingredient in a bad soup?", "Name for a boring hero."],
        text: ["Review for: A broken car", "News from year 3050"],
        draw: ["Draw: Rich potato", "Draw: Alien disco"],
        voice: ["Sound: Scary laugh", "Sound: Winning lottery"]
    }
};

const rooms = {};
let timers = {};

io.on('connection', (socket) => {
    // СОЗДАНИЕ КОМНАТЫ
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { 
            host: socket.id, players: [], mode: 'classic', round: 1, currentPairIndex: 0, pairs: [], gameStarted: false,
            settings: { timer: 30, maxPlayers: 12, lang: 'ru', voice: 'male', bonusX2: true }
        };
        socket.join(code);
        socket.emit('room-created', code);
    });

    // ВХОД В КОМНАТУ (С ФИКСОМ КЛОНОВ И КОДА)
    socket.on('join-room', ({ code, name }) => {
        if (!code || !name) return;
        const cleanCode = code.trim().toUpperCase();
        const room = rooms[cleanCode];

        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        if (room.gameStarted) return socket.emit('error-join', 'Игра уже идет!');

        // Защита от дубликатов по имени
        let player = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
        
        if (player) {
            player.id = socket.id; // Перепривязываем сокет к старому игроку
        } else {
            if (room.players.length >= room.settings.maxPlayers) return socket.emit('error-join', 'Мест нет!');
            player = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
            room.players.push(player);
        }

        socket.join(cleanCode);
        io.to(room.host).emit('player-list-update', room.players);
        socket.emit('joined-success', { code: cleanCode, settings: room.settings });
    });

    // ОБНОВЛЕНИЕ НАСТРОЕК
    socket.on('update-settings', ({ code, settings }) => {
        if (rooms[code]) {
            rooms[code].settings = settings;
            io.to(code).emit('settings-updated', settings);
        }
    });

    // ВЫБОР ЭМОДЗИ
    socket.on('select-emoji', ({ code, emoji }) => {
        const room = rooms[code];
        if (room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if (p) { p.emoji = emoji; io.to(room.host).emit('player-list-update', room.players); }
        }
    });

    // СТАРТ ИГРЫ
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
        
        const langPack = prompts[room.settings.lang] || prompts['ru'];
        const qList = langPack[room.mode];

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
        if (!pair) {
            // Раунд окончен -> Таблица лидеров
            return io.to(code).emit('show-scores', { players: room.players, round: room.round });
        }
        
        io.to(code).emit('round-started', { 
            mode: room.mode, round: room.round, q: pair.q, 
            p1_id: pair.p1.id, p2_id: pair.p2 ? pair.p2.id : null, 
            settings: room.settings 
        });

        // Таймер авто-сдачи
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    // ПЕРЕХОД ПОСЛЕ ТАБЛИЦЫ СЧЕТА
    socket.on('next-after-scores', (code) => {
        const room = rooms[code];
        if (!room) return;
        if (room.round < 3) startRound(code, room.round + 1);
        else io.to(code).emit('final-results', { players: room.players.sort((a,b) => b.score - a.score) });
    });

    function forceSubmit(code) {
        const room = rooms[code]; 
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        if (!pair.ans1) pair.ans1 = "..."; 
        if (pair.p2 && !pair.ans2) pair.ans2 = "...";
        showVoting(code, pair, room.mode);
    }

    socket.on('submit-answer', ({ code, answer }) => {
        const room = rooms[code]; 
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return;
        if (pair.p1.id === socket.id) pair.ans1 = answer;
        if (pair.p2 && pair.p2.id === socket.id) pair.ans2 = answer;
        
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { 
            clearTimeout(timers[code]); 
            showVoting(code, pair, room.mode); 
        }
    });

    function showVoting(code, pair, mode) {
        io.to(code).emit('show-voting', { 
            type: mode, ans1: pair.ans1, ans2: pair.ans2, 
            isSolo: !pair.p2, settings: rooms[code].settings,
            p1_id: pair.p1.id, p2_id: pair.p2 ? pair.p2.id : null 
        });
        if (!pair.p2) setTimeout(() => finishPair(code), 6000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; 
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        
        // Когда проголосовали все, кто не участвует
        const votersNeeded = room.players.length - (pair.p2 ? 2 : 1);
        if (pair.votes.length >= Math.max(votersNeeded, 1)) finishPair(code);
    });

    function finishPair(code) {
        const room = rooms[code]; 
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.finished = true;

        let v1 = pair.votes.filter(v => v.voteNum === 1).length;
        let v2 = pair.votes.filter(v => v.voteNum === 2).length;
        
        // Расчет очков (Бонус x2 в 3 раунде)
        let multiplier = (room.round === 3 && room.settings.bonusX2) ? 200 : 100;
        
        pair.p1.lastPoints = v1 * multiplier;
        pair.p1.score += pair.p1.lastPoints;
        if (pair.p2) {
            pair.p2.lastPoints = v2 * multiplier;
            pair.p2.score += pair.p2.lastPoints;
        }

        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2 });
        
        setTimeout(() => { 
            if (rooms[code]) { 
                rooms[code].currentPairIndex++; 
                sendPair(code); 
            } 
        }, 5000);
    }

    socket.on('finish-credits', (code) => { 
        io.to(code).emit('go-to-menu'); 
        delete rooms[code]; 
    });

    socket.on('disconnect', () => {
        // Здесь можно добавить логику обработки вылета хоста
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('SERVER READY'));
