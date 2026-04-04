const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); // Модуль для проверки файлов
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- ДЕБАГ: Пишем в консоль Render список файлов при старте ---
console.log("--- ПРОВЕРКА ФАЙЛОВ ПРИ ЗАПУСКЕ ---");
const filesInRoot = fs.readdirSync(__dirname);
console.log("Файлы в корне:", filesInRoot);
// -------------------------------------------------------------

app.use(express.static(__dirname));

// Функция для безопасной отдачи файлов (ищет везде)
function sendSafe(res, fileName) {
    const p1 = path.join(__dirname, fileName);
    const p2 = path.join(__dirname, 'public', fileName);
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    res.status(404).send(`Ошибка: Файл ${fileName} не найден на сервере! Проверь GitHub.`);
}

// Маршруты
app.get('/', (req, res) => sendSafe(res, 'index.html'));
app.get('/host', (req, res) => sendSafe(res, 'host.html'));
app.get('/player', (req, res) => sendSafe(res, 'player.html'));
app.get('/mod', (req, res) => sendSafe(res, 'mod.html'));

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
        return result.response.text().trim();
    } catch (e) { return prompts.ru.classic[0]; }
}

async function getAIComment(q, a1, a2) {
    try {
        const result = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши короткую едкую реакцию (5 слов).`);
        return result.response.text().trim();
    } catch (e) { return "Ну и кринж!"; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 30, voice: 'male' } };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        room.players = room.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());
        const player = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(player);
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
            let q = (Math.random() < 0.8) ? await getAIQuestion(roundNum === 3) : prompts.ru.classic[0];
            room.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair) {
            io.to(code).emit('show-scores', { players: room.players, round: room.round, time: 15 });
            setTimeout(() => { if (room.round < 3) startRound(code, room.round + 1); }, 16000);
            return;
        }
        io.to(code).emit('round-started', { round: room.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, time: room.settings.timer });
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
        pair.p1.score += v1 * 100; if (pair.p2) pair.p2.score += v2 * 100;
        const comment = await getAIComment(pair.q, pair.ans1, pair.ans2 || "");
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2, aiComment: comment });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }

    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Live on ' + PORT));
