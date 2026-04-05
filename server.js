const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 4e7, // 40MB для тяжелых данных
    cors: { origin: "*" } 
});

// --- КОНФИГУРАЦИЯ ИИ GEMINI ---
const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

app.use(express.static(__dirname));

// Прямые пути для Render
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));
app.get('/mod', (req, res) => res.sendFile(path.resolve(__dirname, 'mod.html')));

// --- ГЛОБАЛЬНЫЙ ЛИДЕРБОРД ---
const leaderboardPath = path.join(__dirname, 'leaderboard.json');

function getLeaderboard() {
    try {
        if (!fs.existsSync(leaderboardPath)) return {};
        return JSON.parse(fs.readFileSync(leaderboardPath));
    } catch (e) { return {}; }
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
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
}

// --- БАЗА ВОПРОСОВ ---
const prompts = {
    ru: {
        classic: ["Почему Ванга лысый?", "Секрет Димы Модерасса", "За что Ванга любит перфоратор?", "Худшая фраза хирурга?"],
        final: ["3 причины не доверять Диме", "3 признака, что ты лысеешь", "3 вещи, которые нельзя делать в церкви"]
    },
    en: {
        classic: ["Why is the sun hot?", "Worst wedding gift?", "Secret ingredient in a bad soup?"],
        final: ["3 things to do on Mars", "3 reasons to cry at a party"]
    }
};

const rooms = {};
let timers = {};

// ГЕНЕРАТОР ВОПРОСОВ ИИ
async function getUniqueQuestion(room, isFinal = false) {
    const type = isFinal ? "final" : "classic";
    room.usedQuestions = room.usedQuestions || [];
    
    if (Math.random() < 0.85) {
        try {
            const style = room.settings.eighteenPlus ? "18+, жесткий, токсичный" : "мемный, абсурдный";
            const task = isFinal ? "вопрос требующий списка из 3 вещей" : "смешной вопрос";
            const prompt = `Придумай один ${task} для игры "Грехо-Смех" на языке ${room.settings.lang}. Стиль: ${style}. Упомяни Вангу или Диму. Только текст.`;
            const result = await aiModel.generateContent(prompt);
            let q = result.response.text().trim().replace(/[*"']/g, "");
            if (q && !room.usedQuestions.includes(q)) {
                room.usedQuestions.push(q);
                return q;
            }
        } catch (e) { console.log("AI Error"); }
    }

    let available = prompts[room.settings.lang][type].filter(q => !room.usedQuestions.includes(q));
    if (available.length === 0) { room.usedQuestions = []; available = prompts[room.settings.lang][type]; }
    const q = available[Math.floor(Math.random() * available.length)];
    room.usedQuestions.push(q);
    return q;
}

// ГЕНЕРАТОР КОММЕНТАРИЕВ
async function getAIComment(q, a1, a2) {
    try {
        const result = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши короткую (5 слов) едкую реакцию ведущего на русском.`);
        return result.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return "Ну и кринж вы выдали!"; }
}

io.on('connection', (socket) => {
    // При заходе на главную шлем ТОП
    socket.emit('global-top-update', formatTop(getLeaderboard()));

    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { 
                host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], 
                gameStarted: false, allJokes: [], mode: 'classic', modId: null, usedQuestions: [],
                settings: { timer: 30, moderation: false, hellMode: false, bonusX2: true, eighteenPlus: false, lang: 'ru', voice: 'male' } 
            };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        
        room.players = room.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());
        const p = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0, finished: false };
        room.players.push(p);
        
        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode, settings: room.settings });
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('join-mod', (code) => {
        const r = rooms[code.toUpperCase()];
        if (r) { r.modId = socket.id; socket.join(code.toUpperCase()); socket.emit('mod-success'); }
    });

    socket.on('update-settings', ({ code, settings }) => {
        if (rooms[code]) { rooms[code].settings = settings; io.to(code).emit('settings-updated', settings); }
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) { room.gameStarted = true; startRound(code, 1); }
    });

    async function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum; room.currentPairIndex = 0; room.pairs = [];
        let shuf = [...room.players].sort(() => 0.5 - Math.random());
        
        const count = (roundNum === 3) ? 1 : shuf.length;
        for (let i = 0; i < count; i++) {
            let q = await getUniqueQuestion(room, roundNum === 3);
            room.pairs.push({ p1: shuf[i], p2: shuf[(i+1)%shuf.length], q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair) {
            io.to(code).emit('show-scores', { players: room.players, round: room.round, time: 10 });
            return;
        }
        io.to(code).emit('round-started', { round: room.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2?.name, time: room.settings.timer });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    function forceSubmit(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        if (!pair.ans1) pair.ans1 = "EMPTY"; if (pair.p2 && !pair.ans2) pair.ans2 = "EMPTY";
        showVoting(code, pair);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code];
        if (room.settings.moderation && room.modId) {
            io.to(room.modId).emit('mod-check', { name, answer, code });
        } else { processAnswer(code, name, answer); }
    });

    socket.on('mod-action', ({ code, name, answer, action }) => {
        processAnswer(code, name, (action === 'block' ? "ЗАБЛОКИРОВАНО" : answer));
    });

    function processAnswer(code, name, answer) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { clearTimeout(timers[code]); showVoting(code, pair); }
    }

    function showVoting(code, pair) {
        const isBothEmpty = (pair.ans1 === "EMPTY" && pair.ans2 === "EMPTY");
        io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, bothEmpty: isBothEmpty, p1_name: pair.p1.name, p2_name: pair.p2?.name, time: 20 });
        if(timers[code]) clearTimeout(timers[code]);
        if (!pair.p2 || isBothEmpty) timers[code] = setTimeout(() => finishPair(code), 7000);
        else timers[code] = setTimeout(() => finishPair(code), 22000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) { clearTimeout(timers[code]); finishPair(code); }
    });

    async function finishPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length, v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = room.round * 100;
        let p1Points = (pair.ans1 === "EMPTY") ? 0 : (!pair.p2 ? 100 : v1 * mult);
        let p2Points = (pair.ans2 === "EMPTY") ? 0 : (v2 * mult);
        
        pair.p1.score += p1Points; if (pair.p2) pair.p2.score += p2Points;
        if (pair.ans1 !== "EMPTY") room.allJokes.push({ text: pair.ans1, author: pair.p1.name, votes: v1, emoji: pair.p1.emoji });
        if (pair.p2 && pair.ans2 !== "EMPTY") room.allJokes.push({ text: pair.ans2, author: pair.p2.name, votes: v2, emoji: pair.p2.emoji });

        const comment = await getAIComment(pair.q, pair.ans1, pair.ans2 || "");
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, bothEmpty: (pair.ans1 === "EMPTY" && pair.ans2 === "EMPTY"), v1, v2, p1Points, p2Points, aiComment: comment });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }

    socket.on('next-after-scores', (code) => {
        const room = rooms[code];
        if (room.round < 3) startRound(code, room.round + 1);
        else {
            const sorted = room.players.sort((a,b)=>b.score-a.score);
            updateGlobalScore(sorted[0].name, 25, sorted[0].emoji);
            const best = [...room.allJokes].sort((a,b) => b.votes - a.votes).slice(0, 5);
            const worst = room.allJokes.filter(j => j.votes === 0).slice(0, 5);
            io.to(code).emit('final-results', { players: sorted, best, worst });
        }
    });

    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });

    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Greho-Smeh 2.0 AI Online'));
