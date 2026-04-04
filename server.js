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

// Маршруты для Render
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));
app.get('/mod', (req, res) => res.sendFile(path.resolve(__dirname, 'mod.html')));

const prompts = {
    ru: {
        classic: ["Почему vangavgav лысый?", "Что скрывает Ванга под кепкой?", "За что Дима Moderass любит Вангу?", "Худшая фраза хирурга?"],
        final: ["Напиши 3 причины не доверять Диме", "3 признака, что ты — Ванга", "3 вещи, которые нельзя делать в подвале"]
    }
};

const rooms = {};
let timers = {};

// ГЕНЕРАЦИЯ ВОПРОСА ЧЕРЕЗ ИИ
async function getAIQuestion(isFinal = false) {
    try {
        const type = isFinal ? "список из 3 абсурдных вещей" : "смешной вопрос";
        const prompt = `Ты сценарист игры "Грехо-Смех". Придумай один ${type} на русском. Юмор: мемный, едкий, Jackbox style. Упомяни иногда Вангу или Диму. Только текст вопроса.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) {
        return isFinal ? prompts.ru.final[0] : prompts.ru.classic[0];
    }
}

// ГЕНЕРАЦИЯ КОММЕНТАРИЯ ЧЕРЕЗ ИИ
async function getAIComment(q, a1, a2) {
    try {
        const prompt = `Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши ОЧЕНЬ короткую (до 5 слов) едкую или смешную реакцию ведущего.`;
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
                settings: { timer: 30, moderation: false }
            };
        } else { rooms[code].host = socket.id; }
        socket.join(code);
        socket.emit('room-created', code);
        io.to(code).emit('player-list-update', rooms[code].players);
    });

    // ИГРОК: Вход (Фикс клонов по имени)
    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');

        // Если игрок с таким именем уже есть - обновляем его сокет (защита от клонов)
        room.players = room.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());

        if (!room.gameStarted && room.players.length >= 12) return socket.emit('error-join', 'Мест нет!');

        const player = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(player);

        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode });
        io.to(room.host).emit('player-list-update', room.players);
    });

    // ВЫБОР ЭМОДЗИ
    socket.on('select-emoji', ({ code, name, emoji }) => {
        const room = rooms[code];
        const p = room?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', room.players); }
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

        // Раунды 1-2: Пары. Раунд 3: Все вместе (Трихлыст)
        const isFinal = (roundNum === 3);
        const count = isFinal ? Math.ceil(shuf.length / 2) : shuf.length;

        for (let i = 0; i < count; i++) {
            // 80% Шанс на вопрос от ИИ
            const q = (Math.random() < 0.8) ? await getAIQuestion(isFinal) : prompts.ru.classic[0];
            
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
        if (!pair) {
            // Конец раунда -> Таблица очков
            return io.to(code).emit('show-scores', { players: room.players, round: room.round, time: 15 });
        }
        
        io.to(code).emit('round-started', { 
            round: room.round, q: pair.q, 
            p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, 
            time: room.settings.timer 
        });

        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 1) * 1000);
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
        
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;

        if (pair.ans1 && (!pair.p2 || pair.ans2)) { 
            clearTimeout(timers[code]); 
            showVoting(code, pair); 
        }
    });

    function showVoting(code, pair) {
        io.to(code).emit('show-voting', { 
            ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, 
            p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null,
            time: 20 
        });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => finishPair(code), 22000); // Таймер голосования
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
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
        
        // Очки: R1=100 за голос, R2=200, R3=300
        let mult = room.round * 100;
        let p1Points = v1 * mult;
        let p2Points = v2 * mult;
        
        pair.p1.score += p1Points;
        if (pair.p2) pair.p2.score += p2Points;

        const comment = await getAIComment(pair.q, pair.ans1, pair.ans2 || "");
        
        io.to(code).emit('voting-results', { 
            p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, 
            v1, v2, p1Points, p2Points, aiComment: comment 
        });

        setTimeout(() => { 
            if (rooms[code]) { 
                rooms[code].currentPairIndex++; 
                sendPair(code); 
            } 
        }, 8000);
    }

    socket.on('next-after-scores', (code) => {
        const room = rooms[code];
        if (!room) return;
        clearTimeout(timers[code]);
        if (room.round < 3) startRound(code, room.round + 1);
        else io.to(code).emit('final-results', { players: room.players.sort((a,b)=>b.score-a.score) });
    });

    socket.on('finish-credits', (code) => { 
        io.to(code).emit('go-to-menu'); 
        delete rooms[code]; 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('ГРЕХО-СМЕХ ИИ ГОТОВ! ПОРТ: ' + PORT));
