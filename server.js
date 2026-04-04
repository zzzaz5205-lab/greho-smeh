const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));

const rooms = {};
let timers = {};

// Генерация вопроса с учетом 18+ и Адского режима
async function getProPrompt(room, isFinal = false) {
    const s = room.settings;
    let style = s.eighteenPlus ? "18+, с матами, очень пошлый, жесткий, токсичный" : "мемный, для компании, абсурдный";
    if (s.hellMode) style += ", безумный, бессвязный, пугающий";

    try {
        const promptText = `Ты ведущий игры "Грехо-Смех". Придумай один ${isFinal ? "вопрос на 3 ответа" : "вопрос"} на русском. Стиль: ${style}. Упомяни Вангу или Диму Модерасса. ТОЛЬКО ТЕКСТ.`;
        const result = await aiModel.generateContent(promptText);
        return result.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return "Почему Ванга лысый?"; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { 
                host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false,
                settings: { timer: 30, eighteenPlus: false, hellMode: false, bonusX2: false } 
            };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        room.players = room.players.filter(p => p.name !== name);
        const p = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(p);
        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode });
        io.to(room.host).emit('player-list-update', room.players);
    });

    // Применение настроек
    socket.on('update-settings', ({ code, settings }) => {
        if (rooms[code]) rooms[code].settings = settings;
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) {
            room.gameStarted = true;
            // Сначала запускаем ТУТОРИАЛ на Хосте
            io.to(code).emit('start-tutorial', { settings: room.settings });
        }
    });

    // После туториала хост шлет это событие
    socket.on('tutorial-finished', (code) => {
        startRound(code, 1);
    });

    async function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum; room.currentPairIndex = 0;
        room.pairs = [];
        let shuf = [...room.players].sort(() => 0.5 - Math.random());
        
        for (let i = 0; i < shuf.length; i += 2) {
            let q = await getProPrompt(room, roundNum === 3);
            room.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair) {
            io.to(code).emit('show-scores', { players: room.players, round: room.round, time: 15 });
            setTimeout(() => {
                if (room.round < 3) startRound(code, room.round + 1);
                else io.to(code).emit('final-results', { players: room.players.sort((a,b)=>b.score-a.score) });
            }, 16000);
            return;
        }
        // В адском режиме таймер в 2 раза быстрее
        let currentTimer = room.settings.hellMode ? Math.floor(room.settings.timer / 2) : room.settings.timer;
        
        io.to(code).emit('round-started', { round: room.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, time: currentTimer, hellMode: room.settings.hellMode });
        
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (currentTimer + 1) * 1000);
    }

    // Остальная логика (submit-answer, cast-vote) остается без изменений...
    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code]; const pair = room?.pairs[room.currentPairIndex];
        if (!pair) return;
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { clearTimeout(timers[code]); showVoting(code, pair); }
    });

    function showVoting(code, p) {
        io.to(code).emit('show-voting', { ans1: p.ans1, ans2: p.ans2, isSolo: !p.p2, p1_name: p.p1.name, p2_name: p.p2?.name, time: 20 });
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) { clearTimeout(timers[code]); finishPair(code); }
    });

    async function finishPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return; p.finished = true;
        let v1 = p.votes.filter(v => v.voteNum === 1).length, v2 = p.votes.filter(v => v.voteNum === 2).length;
        let mult = (r.round === 3 || r.settings.bonusX2) ? 200 : 100;
        let p1Points = !p.p2 ? 100 : v1 * mult;
        let p2Points = v2 * mult;
        p.p1.score += p1Points; if (p.p2) p.p2.score += p2Points;
        io.to(code).emit('voting-results', { p1: p.p1, p2: p.p2, isSolo: !p.p2, v1, v2, p1Points, p2Points });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }
});
server.listen(process.env.PORT || 3000);
