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
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));
app.get('/mod', (req, res) => res.sendFile(path.resolve(__dirname, 'mod.html')));

const rooms = {};
let timers = {};

async function getAIQuestion(isFinal = false) {
    try {
        const prompt = `Придумай ОДИН ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} для игры Quiplash на русском. Юмор: абсурдный, мемный. Без кавычек.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) { return isFinal ? "3 признака, что Дима — робот" : "Почему Ванга лысый?"; }
}

async function getAIComment(q, a1, a2) {
    try {
        const result = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши короткий едкий комментарий на русском (5 слов).`);
        return result.response.text().trim();
    } catch (e) { return "Ну и бред!"; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 35, voice: 'male', moderation: false }, modId: null };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const c = code?.trim().toUpperCase();
        const r = rooms[c];
        if (!r) return socket.emit('error-join', 'Комната не найдена!');
        r.players = r.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());
        const p = { id: socket.id, name, char: { shape: 'square', color: '#ff0000' }, score: 0, lastPoints: 0, ready: false };
        r.players.push(p);
        socket.join(c);
        socket.emit('joined-success', { code: c, settings: r.settings });
        io.to(r.host).emit('player-list-update', r.players);
    });

    socket.on('select-char', ({ code, name, char }) => {
        const r = rooms[code];
        const p = r?.players.find(pl => pl.name === name);
        if (p) { p.char = char; io.to(r.host).emit('player-list-update', r.players); }
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
        const count = (roundNum === 3) ? 1 : shuf.length;
        for (let i = 0; i < count; i++) {
            let q = await getAIQuestion(roundNum === 3);
            r.pairs.push({ p1: shuf[i], p2: shuf[(i+1)%shuf.length], q, ans1: null, ans2: null, votes: [], finished: false, isFinal: roundNum === 3 });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p) return io.to(code).emit('show-scores', { players: r.players, round: r.round });
        io.to(code).emit('round-started', { round: r.round, q: p.q, p1_name: p.p1?.name, p2_name: p.p2?.name, settings: r.settings, isFinal: p.isFinal });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (r.settings.timer + 2) * 1000);
    }

    function forceSubmit(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if(p.finished) return;
        if(!p.ans1) p.ans1 = "..."; if(p.p2 && !p.ans2) p.ans2 = "...";
        showVoting(code, p);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (r.settings.moderation && r.modId) {
            io.to(r.modId).emit('mod-check', { playerId: socket.id, playerName: name, text: txt });
        } else { applyAns(code, p, name, txt); }
    });

    socket.on('mod-action', ({ code, playerName, text, action }) => {
        applyAns(code, rooms[code].pairs[rooms[code].currentPairIndex], playerName, action === 'block' ? "ЗАБЛОКИРОВАНО" : text);
    });

    function applyAns(code, pair, name, txt) {
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { clearTimeout(timers[code]); showVoting(code, pair); }
    }

    function showVoting(code, pair) {
        io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, p1: pair.p1, p2: pair.p2, q: pair.q });
        if(!pair.p2) setTimeout(() => finishPair(code), 6000);
        else timers[code] = setTimeout(() => finishPair(code), 20000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (p.finished) return;
        p.votes.push({ voter: socket.id, voteNum });
        if (p.votes.length >= (r.players.length - (p.p2 ? 2 : 1))) { clearTimeout(timers[code]); finishPair(code); }
    });

    async function finishPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (p.finished) return; p.finished = true;
        let v1 = p.votes.filter(v=>v.voteNum===1).length, v2 = p.votes.filter(v=>v.voteNum===2).length;
        let mult = (r.round === 3) ? 200 : 100;
        p.p1.score += v1 * mult; if (p.p2) p.p2.score += v2 * mult;
        const comm = await getAIComment(p.q, p.ans1, p.ans2 || "");
        io.to(code).emit('voting-results', { p1: p.p1, p2: p.p2, v1, v2, aiComment: comm, isSolo: !p.p2 });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }

    socket.on('next-after-scores', (code) => {
        if (rooms[code].round < 3) startRound(code, rooms[code].round + 1);
        else io.to(code).emit('final-results', { players: rooms[code].players.sort((a,b)=>b.score-a.score) });
    });

    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});
server.listen(process.env.PORT || 3000);
