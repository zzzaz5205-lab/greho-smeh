const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 2e7, 
    cors: { origin: "*" } 
});

// --- ЛОГИРОВАНИЕ ДЛЯ ПРОВЕРКИ (Смотри в Logs на Render) ---
console.log("=== ПРОВЕРКА ФАЙЛОВ В СИСТЕМЕ ===");
const files = fs.readdirSync(__dirname);
console.log("Файлы в корне проекта:", files);
if (files.includes('public')) {
    console.log("Файлы внутри папки public:", fs.readdirSync(path.join(__dirname, 'public')));
}
console.log("================================");

// КЛЮЧ ИИ
const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

// Разрешаем статику
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// Универсальная функция отдачи HTML
function serveHTML(res, name) {
    const rootPath = path.join(__dirname, name);
    const pubPath = path.join(__dirname, 'public', name);
    if (fs.existsSync(rootPath)) return res.sendFile(rootPath);
    if (fs.existsSync(pubPath)) return res.sendFile(pubPath);
    res.status(404).send(`Ошибка: Файл ${name} не найден на GitHub!`);
}

// Маршруты
app.get('/', (req, res) => serveHTML(res, 'index.html'));
app.get('/host', (req, res) => serveHTML(res, 'host.html'));
app.get('/player', (req, res) => serveHTML(res, 'player.html'));
app.get('/mod', (req, res) => serveHTML(res, 'mod.html'));

// --- ЛОГИКА ИГРЫ ---
const prompts = {
    ru: {
        classic: ["Почему vangavgav лысый?", "Что скрывает Ванга?", "За что Дима Moderass любит Вангу?"],
        final: ["3 вещи, которые нельзя делать в гостях", "3 признака, что ты лысеешь"]
    }
};

const rooms = {};
let timers = {};

async function getAIQuestion(isFinal = false) {
    try {
        const prompt = `Ты сценарист игры. Придумай один ${isFinal ? "список из 3 вещей" : "смешной вопрос"} на русском. Юмор: мемный. Только текст.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return prompts.ru.classic[0]; }
}

async function getAIComment(q, a1, a2) {
    try {
        const result = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши короткую едкую реакцию (5 слов).`);
        return result.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return "Ну и кринж!"; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 30 } };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        room.players = room.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());
        const p = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(p);
        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode });
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) { room.gameStarted = true; startRound(code, 1); }
    });

    async function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum; room.currentPairIndex = 0;
        let shuf = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];
        for (let i = 0; i < shuf.length; i += 2) {
            let q = await getAIQuestion(roundNum === 3);
            room.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair) {
            io.to(code).emit('show-scores', { players: room.players, round: room.round, time: 15 });
            return;
        }
        io.to(code).emit('round-started', { round: room.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, time: 30 });
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code]; const pair = room?.pairs[room.currentPairIndex];
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) {
            io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, time: 20 });
        }
    });

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) finishPair(code);
    });

    async function finishPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length, v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = room.round * 100;
        let p1Points = v1 * mult, p2Points = v2 * mult;
        pair.p1.score += p1Points; if (pair.p2) pair.p2.score += p2Points;
        const comment = await getAIComment(pair.q, pair.ans1, pair.ans2 || "");
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2, p1Points, p2Points, aiComment: comment });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }

    socket.on('next-after-scores', (code) => {
        if (rooms[code].round < 3) startRound(code, rooms[code].round + 1);
        else io.to(code).emit('final-results', { players: rooms[code].players.sort((a,b)=>b.score-a.score) });
    });
    
    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Live on ' + PORT));
