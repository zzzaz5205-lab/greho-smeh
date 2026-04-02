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

const rooms = {};
let timers = {};

// Генератор ИИ вопросов под тип раунда
async function getAIQuestion(isFinal = false) {
    try {
        const type = isFinal ? "список из 3 абсурдных вещей" : "смешной вопрос";
        const prompt = `Ты сценарист игры "Грехо-Смех". Придумай один ${type} на русском. Юмор: мемный, острый, Jackbox. Выдай ТОЛЬКО текст.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) { return isFinal ? "Назови 3 причины стать лысым" : "Почему Ванга смеется?"; }
}

async function getAIComment(q, a1, a2) {
    try {
        const result = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши одну короткую едкую реакцию (5 слов).`);
        return result.response.text().trim();
    } catch (e) { return "Это было сильно... сильно плохо."; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 45 } };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const c = code?.trim().toUpperCase();
        const r = rooms[c];
        if (!r) return socket.emit('error-join', 'Комната не найдена!');
        r.players = r.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());
        const player = { id: socket.id, name, char: ['red-angry','orange-evil','blue-sad','green-derpy','purple-smug'][r.players.length % 5], score: 0 };
        r.players.push(player);
        socket.join(c);
        socket.emit('joined-success', { code: c, char: player.char });
        io.to(r.host).emit('player-list-update', r.players);
    });

    socket.on('start-game', (code) => {
        const r = rooms[code];
        if (r && r.players.length >= 2) { r.gameStarted = true; startRound(code, 1); }
    });

    async function startRound(code, roundNum) {
        const r = rooms[code];
        r.round = roundNum; r.currentPairIndex = 0;
        r.pairs = [];
        let shuf = [...r.players].sort(() => 0.5 - Math.random());

        if (roundNum < 3) {
            // Раунды 1 и 2: Пары
            for (let i = 0; i < shuf.length; i++) {
                let q = await getAIQuestion(false);
                r.pairs.push({ p1: shuf[i], p2: shuf[(i+1)%shuf.length], q, ans1: null, ans2: null, votes: [], finished: false });
            }
        } else {
            // Раунд 3: Трихлыст (Все отвечают на один вопрос)
            let q = await getAIQuestion(true);
            for (let i = 0; i < shuf.length; i += 2) {
                r.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false, isFinal: true });
            }
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        if (!pair) {
            if (r.round < 3) return io.to(code).emit('show-scores', { players: r.players, round: r.round });
            else return io.to(code).emit('final-results', { players: r.players.sort((a,b)=>b.score-a.score) });
        }
        io.to(code).emit('round-started', { round: r.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2?.name });
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
        const r = rooms[code]; const p = r?.pairs[r.currentPairIndex];
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' • ') : answer;
        if (p.p1.name === name) p.ans1 = txt;
        if (p.p2 && p.p2.name === name) p.ans2 = txt;
        if (p.ans1 && (!p.p2 || p.ans2)) { clearTimeout(timers[code]); showVoting(code, p); }
    });

    function showVoting(code, p) {
        io.to(code).emit('show-voting', { ans1: p.ans1, ans2: p.ans2, isSolo: !p.p2, p1_name: p.p1.name, p2_name: p.p2?.name });
        if(!p.p2) setTimeout(() => finishPair(code), 6000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (p.finished) return;
        p.votes.push({ voter: socket.id, voteNum });
        const needed = r.players.length - (p.p2 ? 2 : 1);
        if (p.votes.length >= Math.max(needed, 1)) finishPair(code);
    });

    async function finishPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (p.finished) return; p.finished = true;
        let v1 = p.votes.filter(v => v.voteNum === 1).length;
        let v2 = p.votes.filter(v => v.voteNum === 2).length;
        let mult = r.round * 100; // R1: 100, R2: 200, R3: 300
        p.p1.score += v1 * mult; if(p.p2) p.p2.score += v2 * mult;
        const comm = await getAIComment(p.q, p.ans1, p.ans2 || "");
        io.to(code).emit('voting-results', { p1: p.p1, p2: p.p2, v1, v2, aiComment: comm });
        setTimeout(() => { r.currentPairIndex++; sendPair(code); }, 8000);
    }

    socket.on('next-round', (code) => { startRound(code, rooms[code].round + 1); });
});
server.listen(process.env.PORT || 3000);
