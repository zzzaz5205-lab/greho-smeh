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

const prompts = {
    ru: {
        classic: ["Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "За что Дима любит Вангу?", "Худшая фраза хирурга?"],
        final: ["3 вещи, которые нельзя делать в гостях", "3 причины не доверять Диме", "3 признака, что ты лысеешь"]
    }
};

const rooms = {};
let timers = {};

async function getUniqueQuestion(room, isFinal = false) {
    const type = isFinal ? "final" : "classic";
    room.usedQuestions = room.usedQuestions || [];
    try {
        const result = await aiModel.generateContent(`Придумай 1 ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} для игры на русском. Юмор: мемный.`);
        let q = result.response.text().trim().replace(/[*"']/g, "");
        if (q && !room.usedQuestions.includes(q)) { room.usedQuestions.push(q); return q; }
    } catch (e) {}
    let available = prompts.ru[type].filter(q => !room.usedQuestions.includes(q));
    if (available.length === 0) { room.usedQuestions = []; available = prompts.ru[type]; }
    const q = available[Math.floor(Math.random() * available.length)];
    room.usedQuestions.push(q);
    return q;
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, usedQuestions: [], allJokes: [], settings: { timer: 30, voice: 'male' } };
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
        if (!room) return;
        room.round = roundNum;
        room.currentPairIndex = 0;
        let shuf = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];

        // ФИКС ЛОГИКИ ПАР: Идем по 2 игрока
        for (let i = 0; i < shuf.length; i += 2) {
            let p1 = shuf[i];
            let p2 = shuf[i + 1] || null; // Если игрока нет, p2 будет null (одиночка)
            let q = await getUniqueQuestion(room, roundNum === 3);
            room.pairs.push({ p1, p2, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code];
        if (!room) return;
        const pair = room.pairs[room.currentPairIndex];

        if (!pair) {
            // КОНЕЦ ВСЕХ ПАР В РАУНДЕ: Показываем счет
            io.to(code).emit('show-scores', { players: room.players, round: room.round, time: 10 });
            
            if (timers[code]) clearTimeout(timers[code]);
            timers[code] = setTimeout(() => {
                if (room.round < 3) {
                    startRound(code, room.round + 1);
                } else {
                    const best = [...room.allJokes].sort((a,b) => b.votes - a.votes).slice(0, 5);
                    io.to(code).emit('final-results', { players: room.players.sort((a,b)=>b.score-a.score), best });
                }
            }, 11000);
            return;
        }

        io.to(code).emit('round-started', { 
            round: room.round, 
            q: pair.q, 
            p1_name: pair.p1.name, 
            p2_name: pair.p2 ? pair.p2.name : null, 
            time: 30 
        });

        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), 32000);
    }

    function forceSubmit(code) {
        const room = rooms[code];
        if (!room) return;
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        if (!pair.ans1) pair.ans1 = "EMPTY"; 
        if (pair.p2 && !pair.ans2) pair.ans2 = "EMPTY";
        showVoting(code, pair);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code];
        if (!room) return;
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) return;

        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : (answer || "EMPTY");
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;

        if (pair.ans1 && (!pair.p2 || pair.ans2)) {
            clearTimeout(timers[code]);
            showVoting(code, pair);
        }
    });

    function showVoting(code, pair) {
        const room = rooms[code];
        const isBothEmpty = (pair.ans1 === "EMPTY" && pair.ans2 === "EMPTY");
        io.to(code).emit('show-voting', { 
            ans1: pair.ans1, 
            ans2: pair.ans2, 
            isSolo: !pair.p2, 
            bothEmpty: isBothEmpty, 
            p1_name: pair.p1.name, 
            p2_name: pair.p2 ? pair.p2.name : null, 
            time: 20 
        });
        
        if (timers[code]) clearTimeout(timers[code]);
        // Если соло или оба молчат — ждем 7 сек и идем дальше
        let delay = (isBothEmpty || !pair.p2) ? 7000 : 22000;
        timers[code] = setTimeout(() => { if (rooms[code]) finishPair(code); }, delay);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) {
            clearTimeout(timers[code]);
            finishPair(code);
        }
    });

    function finishPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.finished = true;

        let v1 = pair.votes.filter(v => v.voteNum === 1).length;
        let v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = room.round * 100;
        
        let p1Points = (pair.ans1 === "EMPTY") ? 0 : (!pair.p2 ? 100 : v1 * mult);
        let p2Points = (pair.ans2 === "EMPTY") ? 0 : (v2 * mult);
        
        pair.p1.score += p1Points;
        if (pair.p2) pair.p2.score += p2Points;

        if (pair.ans1 !== "EMPTY") room.allJokes.push({ text: pair.ans1, author: pair.p1.name, votes: v1, emoji: pair.p1.emoji });
        if (pair.p2 && pair.ans2 !== "EMPTY") room.allJokes.push({ text: pair.ans2, author: pair.p2.name, votes: v2, emoji: pair.p2.emoji });

        io.to(code).emit('voting-results', { 
            p1: pair.p1, p2: pair.p2, 
            isSolo: !pair.p2, 
            v1, v2, p1Points, p2Points,
            aiComment: "Результаты на экране!" 
        });

        setTimeout(() => {
            if (rooms[code]) {
                rooms[code].currentPairIndex++;
                sendPair(code);
            }
        }, 8000);
    }

    socket.on('update-settings', ({ code, settings }) => { if (rooms[code]) rooms[code].settings = settings; });
    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });
    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Live'));
