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
const aiModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));
app.get('/mod', (req, res) => res.sendFile(path.resolve(__dirname, 'mod.html')));

const prompts = ["Почему vangavgav лысый?", "Что скрывает Ванга?", "За что Дима любит Вангу?"];
const rooms = {};
let timers = {};

async function getAIQuestion(isFinal = false) {
    try {
        const prompt = `Ты сценарист игры "Грехо-Смех". Придумай один ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} на русском. Юмор: Jackbox, мемный. Про Вангу или Диму. Только текст.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return "Почему лысина Ванги так блестит?"; }
}

async function getAIComment(q, a1, a2) {
    try {
        const result = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши короткую едкую реакцию (5 слов).`);
        return result.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return "Ну и кринж вы выдали!"; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 30 } };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
        io.to(code).emit('player-list-update', rooms[code].players);
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
            let q = (Math.random() < 0.8) ? await getAIQuestion(roundNum === 3) : prompts[0];
            r.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        if (!pair) {
            io.to(code).emit('show-scores', { players: r.players, round: r.round, time: 15 });
            if (timers[code]) clearTimeout(timers[code]);
            timers[code] = setTimeout(() => {
                if (r.round < 3) startRound(code, r.round + 1);
                else io.to(code).emit('final-results', { players: r.players.sort((a,b)=>b.score-a.score) });
            }, 16000);
            return;
        }
        io.to(code).emit('round-started', { round: r.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, time: 30 });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), 32000);
    }

    function forceSubmit(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return;
        if (!p.ans1) p.ans1 = "EMPTY"; if (p.p2 && !p.ans2) p.ans2 = "EMPTY";
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

    function showVoting(code, pair) {
        io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, time: 20 });
        if (!pair.p2) {
            if (timers[code]) clearTimeout(timers[code]);
            timers[code] = setTimeout(() => { if (rooms[code]) finishPair(code); }, 8000);
        } else {
            if (timers[code]) clearTimeout(timers[code]);
            timers[code] = setTimeout(() => { if (rooms[code]) finishPair(code); }, 22000);
        }
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return;
        p.votes.push({ voter: socket.id, voteNum });
        if (p.votes.length >= (r.players.length - (p.p2 ? 2 : 1))) { clearTimeout(timers[code]); finishPair(code); }
    });

    async function finishPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return; p.finished = true;
        let v1 = p.votes.filter(v => v.voteNum === 1).length, v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = r.round * 100;
        let p1Points = !p.p2 ? 100 : v1 * mult, p2Points = v2 * mult;
        p.p1.score += p1Points; if (p.p2) p.p2.score += p2Points;
        const comment = await getAIComment(p.q, p.ans1, p.ans2 || "");
        io.to(code).emit('voting-results', { p1: p.p1, p2: p.p2, isSolo: !p.p2, v1, v2, p1Points, p2Points, aiComment: comment });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }
    
    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });

    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ready on ' + PORT));
