const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));

const prompts = ["Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "За что Дима Moderass любит Вангу?", "Худшая фраза хирурга?"];
const rooms = {};
let timers = {};

async function getAIQuestion(isFinal = false) {
    try {
        const result = await aiModel.generateContent(`Придумай 1 ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} для игры на русском. Юмор: мемный.`);
        return result.response.text().trim();
    } catch (e) { return prompts[0]; }
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
        const c = code?.trim().toUpperCase();
        const r = rooms[c];
        if (!r) return socket.emit('error-join', 'Комната не найдена!');
        r.players = r.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());
        const p = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0 };
        r.players.push(p);
        socket.join(c);
        socket.emit('joined-success', { code: c });
        io.to(r.host).emit('player-list-update', r.players);
    });

    socket.on('start-game', (code) => {
        const r = rooms[code];
        if (r && r.players.length >= 2) { r.gameStarted = true; startRound(code, 1); }
    });

    async function startRound(code, roundNum) {
        const r = rooms[code];
        r.round = roundNum; r.currentPairIndex = 0;
        let shuf = [...r.players].sort(() => 0.5 - Math.random());
        r.pairs = [];
        for (let i = 0; i < shuf.length; i += 2) {
            let q = await getAIQuestion(roundNum === 3);
            r.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p) {
            // КОНЕЦ РАУНДА: Шлем счет и запускаем таймер на 15 сек для авто-перехода
            io.to(code).emit('show-scores', { players: r.players, round: r.round, time: 15 });
            if (timers[code]) clearTimeout(timers[code]);
            timers[code] = setTimeout(() => {
                if (r.round < 3) startRound(code, r.round + 1);
                else io.to(code).emit('final-results', { players: r.players.sort((a,b)=>b.score-a.score) });
            }, 16000);
            return;
        }
        io.to(code).emit('round-started', { round: r.round, q: p.q, p1_name: p.p1.name, p2_name: p.p2 ? p.p2.name : null, time: r.settings.timer });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (r.settings.timer + 1) * 1000);
    }

    function forceSubmit(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return;
        if (!p.ans1) p.ans1 = "..."; if (p.p2 && !p.ans2) p.ans2 = "...";
        showVoting(code, p);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code]; const p = r?.pairs[r.currentPairIndex];
        if (!p) return;
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (p.p1.name === name) p.ans1 = txt;
        if (p.p2 && p.p2.name === name) p.ans2 = txt;
        if (p.ans1 && (!p.p2 || p.ans2)) { clearTimeout(timers[code]); showVoting(code, p); }
    });

    function showVoting(code, p) {
        io.to(code).emit('show-voting', { ans1: p.ans1, ans2: p.ans2, isSolo: !p.p2, p1_name: p.p1.name, p2_name: p.p2 ? p.p2.name : null, time: 20 });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => finishPair(code), 22000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return;
        p.votes.push({ voter: socket.id, voteNum });
        if (p.votes.length >= (r.players.length - (p.p2 ? 2 : 1))) { clearTimeout(timers[code]); finishPair(code); }
    });

    function finishPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return; p.finished = true;
        let v1 = p.votes.filter(v => v.voteNum === 1).length, v2 = p.votes.filter(v => v.voteNum === 2).length;
        let mult = (r.round === 3) ? 200 : 100;
        p.p1.score += v1 * mult; if (p.p2) p.p2.score += v2 * mult;
        io.to(code).emit('voting-results', { p1: p.p1, p2: p.p2, isSolo: !p.p2, v1, v2 });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 5000);
    }

    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });
});
server.listen(process.env.PORT || 3000);
