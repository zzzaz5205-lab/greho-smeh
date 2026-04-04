const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 2e7, 
    cors: { origin: "*" } 
});

// --- КОНФИГУРАЦИЯ ИИ GEMINI ---
const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(express.static(__dirname));

// ПРЯМЫЕ МАРШРУТЫ (Защита от "Cannot GET" на Render)
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));
app.get('/mod', (req, res) => res.sendFile(path.resolve(__dirname, 'mod.html')));

// БАЗОВЫЕ ВОПРОСЫ (Запасные)
const prompts = {
    ru: {
        classic: ["Почему vangavgav лысый?", "Что скрывает Ванга под кепкой?", "За что Дима Moderass любит Вангу?", "Худшая фраза хирурга?"],
        final: ["Напиши 3 вещи, которые нельзя делать в гостях", "3 причины не доверять Диме", "3 признака, что ты — Ванга"]
    },
    en: {
        classic: ["Why is the sun hot?", "Worst thing to say at a wedding?", "Secret ingredient in a bad soup?"],
        final: ["3 things to do on Mars", "3 reasons to cry at a party", "3 secret hero names"]
    }
};

const rooms = {};
let timers = {};

// ГЕНЕРАЦИЯ ВОПРОСА ЧЕРЕЗ ИИ
async function getAIQuestion(lang, isFinal = false) {
    try {
        const prompt = `Ты сценарист игры "Грехо-Смех". Придумай один ${isFinal ? "вопрос требующий 3 коротких ответа" : "смешной вопрос"} на языке: ${lang}. Юмор: мемный, едкий, Jackbox style. Упомяни иногда Вангу или Диму. Только текст вопроса.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) {
        const list = prompts[lang] ? prompts[lang] : prompts['ru'];
        return isFinal ? list.final[0] : list.classic[0];
    }
}

// ГЕНЕРАЦИЯ КОММЕНТАРИЯ ЧЕРЕЗ ИИ
async function getAIComment(q, a1, a2) {
    try {
        const prompt = `Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши одну ОЧЕНЬ короткую (до 5 слов) издевательскую реакцию ведущего.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) { return "Ну и бред вы выдали!"; }
}

io.on('connection', (socket) => {
    // ХОСТ: Создание комнаты
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

    // ИГРОК: Вход (Анти-клон)
    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');

        // Если игрок с таким именем уже есть - просто обновляем сокет (фикс обновления страницы)
        let player = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (player) {
            player.id = socket.id;
        } else {
            if (room.gameStarted) return socket.emit('error-join', 'Игра уже идет!');
            if (room.players.length >= room.settings.maxPlayers) return socket.emit('error-join', 'Мест нет!');
            player = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
            room.players.push(player);
        }

        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode, settings: room.settings });
        io.to(room.host).emit('player-list-update', room.players);
    });

    // НАСТРОЙКИ
    socket.on('update-settings', ({ code, settings }) => {
        if (rooms[code]) {
            rooms[code].settings = settings;
            io.to(code).emit('settings-updated', settings);
        }
    });

    // ВЫБОР ПЕРСОНАЖА
    socket.on('select-emoji', ({ code, name, emoji }) => {
        const room = rooms[code];
        const p = room?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', room.players); }
    });

    // МОДЕРАТОР
    socket.on('join-mod', (code) => {
        if (rooms[code]) { rooms[code].modId = socket.id; socket.join(code); socket.emit('mod-success'); }
    });

    // СТАРТ ИГРЫ
    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) {
            room.gameStarted = true;
            startRound(code, 1);
        }
    });

    async function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum;
        room.currentPairIndex = 0;
        let shuf = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];

        // Раунды 1-2: Дуэли. Раунд 3: Все вместе
        const isFinal = (roundNum === 3);
        const count = isFinal ? Math.ceil(shuf.length / 2) : shuf.length;

        for (let i = 0; i < count; i++) {
            const q = await getAIQuestion(room.settings.lang, isFinal);
            if (isFinal) {
                room.pairs.push({ p1: shuf[i*2], p2: shuf[i*2+1] || null, q, ans1: null, ans2: null, votes: [], finished: false, isFinal: true });
            } else {
                room.pairs.push({ p1: shuf[i], p2: shuf[(i+1)%shuf.length], q, ans1: null, ans2: null, votes: [], finished: false, isFinal: false });
            }
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('show-scores', { players: room.players, round: room.round });
        
        io.to(code).emit('round-started', { 
            round: room.round, q: pair.q, 
            p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, 
            settings: room.settings 
        });

        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    function forceSubmit(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        if (!pair.ans1) pair.ans1 = "..."; 
        if (pair.p2 && !pair.ans2) pair.ans2 = "...";
        showVoting(code, pair);
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
            showVoting(code, pair); 
        }
    }

    function showVoting(code, pair) {
        io.to(code).emit('show-voting', { 
            ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, 
            p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null,
            q: pair.q 
        });
        if (!pair.p2) setTimeout(() => finishPair(code), 6000);
        else timers[code] = setTimeout(() => finishPair(code), 22000); // Таймер на голосование
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;

        // Анти-самострел: автор ответа не может голосовать
        const voter = room.players.find(p => p.id === socket.id);
        if (voter.name === pair.p1.name || (pair.p2 && voter.name === pair.p2.name)) return;

        pair.votes.push({ voter: socket.id, voteNum });
        const needed = room.players.length - (pair.p2 ? 2 : 1);
        if (pair.votes.length >= Math.max(needed, 1)) {
            clearTimeout(timers[code]);
            finishPair(code);
        }
    });

    async function finishPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.finished = true;

        let v1 = pair.votes.filter(v => v.voteNum === 1).length;
        let v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = (room.round === 3) ? 300 : room.round * 100;
        
        pair.p1.score += v1 * mult;
        if (pair.p2) pair.p2.score += v2 * mult;

        const comment = await getAIComment(pair.q, pair.ans1, pair.ans2 || "");
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2, aiComment: comment });
        
        setTimeout(() => { 
            if (rooms[code]) { 
                rooms[code].currentPairIndex++; 
                sendPair(code); 
            } 
        }, 8000);
    }

    socket.on('next-after-scores', (code) => {
        const room = rooms[code];
        if (room.round < 3) startRound(code, room.round + 1);
        else io.to(code).emit('final-results', { players: room.players.sort((a,b)=>b.score-a.score) });
    });

    socket.on('finish-credits', (code) => { 
        io.to(code).emit('go-to-menu'); 
        delete rooms[code]; 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('ГРЕХО-СМЕХ ИИ ЗАПУЩЕН! ПОРТ: ' + PORT));
