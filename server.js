const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 4e7, 
    cors: { origin: "*" } 
});

const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(express.static(__dirname));

// Маршруты
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));

// --- ГЛОБАЛЬНЫЙ ЛИДЕРБОРД ---
const leaderboardPath = path.join(__dirname, 'leaderboard.json');
function getLeaderboard() {
    try { return JSON.parse(fs.readFileSync(leaderboardPath)); } catch (e) { return {}; }
}
function updateGlobalScore(name, points, emoji) {
    const board = getLeaderboard();
    if (!board[name]) board[name] = { score: 0, emoji: emoji || '👤' };
    board[name].score += points;
    if (emoji && emoji !== '❓') board[name].emoji = emoji;
    fs.writeFileSync(leaderboardPath, JSON.stringify(board));
    io.emit('global-top-update', formatTop(board));
}
function formatTop(board) {
    return Object.entries(board)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.score - a.score).slice(0, 10);
}

// --- БАЗА ВОПРОСОВ ---
const prompts = {
    ru: {
        classic: ["Почему vangavgav лысый?", "Что скрывает Ванга?", "Худшая фраза хирурга?", "За что Дима Moderass любит Вангу?"],
        final: ["3 вещи, которые нельзя делать в гостях", "3 причины не доверять Диме", "3 признака, что ты лысеешь"]
    }
};

const rooms = {};
let timers = {};

async function getUniqueQuestion(room, isFinal = false) {
    const type = isFinal ? "final" : "classic";
    room.usedQuestions = room.usedQuestions || [];
    try {
        const result = await aiModel.generateContent(`Придумай 1 ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} для игры на русском.`);
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
    socket.emit('global-top-update', formatTop(getLeaderboard()));

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
        room.players = room.players.filter(p => p.name !== name);
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
        room.round = roundNum; room.currentPairIndex = 0; room.pairs = [];
        let shuf = [...room.players].sort(() => 0.5 - Math.random());
        for (let i = 0; i < shuf.length; i += 2) {
            let q = await getUniqueQuestion(room, roundNum === 3);
            room.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair) {
            io.to(code).emit('show-scores', { players: room.players, round: room.round, time: 10 });
            setTimeout(() => {
                if (room.round < 3) startRound(code, room.round + 1);
                else {
                    const sorted = room.players.sort((a,b)=>b.score-a.score);
                    updateGlobalScore(sorted[0].name, 25, sorted[0].emoji);
                    io.to(code).emit('final-results', { players: sorted, best: room.allJokes.sort((a,b)=>b.votes-a.votes).slice(0,5) });
                }
            }, 11000);
            return;
        }
        io.to(code).emit('round-started', { round: room.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, time: 30 });
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code]; const pair = room?.pairs[room.currentPairIndex];
        if (!pair) return;
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : (answer || "EMPTY");
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) showVoting(code, pair);
    });

    function showVoting(code, pair) {
        const isBothEmpty = (pair.ans1 === "EMPTY" && pair.ans2 === "EMPTY");
        io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, bothEmpty: isBothEmpty, p1_name: pair.p1.name, p2_name: pair.p2?.name, time: 20 });
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) finishPair(code);
    });

    function finishPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length, v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let p1Points = !pair.p2 ? 100 : v1 * 100;
        let p2Points = v2 * 100;
        if (pair.ans1 !== "EMPTY") room.allJokes.push({ text: pair.ans1, author: pair.p1.name, votes: v1, emoji: pair.p1.emoji });
        pair.p1.score += p1Points; if (pair.p2) pair.p2.score += p2Points;
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2, p1Points, p2Points });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }
    
    socket.on('update-settings', ({ code, settings }) => { if (rooms[code]) rooms[code].settings = settings; });
    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });
    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ready'));
