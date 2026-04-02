const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

const genAI = new GoogleGenerativeAI("AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64");
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));

const rooms = {};
let timers = {};

async function getAIQuestion(isFinal = false) {
    try {
        const prompt = `Придумай один ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} для игры Смехлыст. Юмор: мемный, абсурдный. Только текст.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) { return isFinal ? "3 причины не доверять Диме" : "Почему Ванга лысый?"; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 35 } };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const c = code?.trim().toUpperCase();
        const r = rooms[c];
        if (!r) return socket.emit('error-join', 'Комната не найдена!');
        
        // Фикс клонов: ищем по имени
        let p = r.players.find(player => player.name.toLowerCase() === name.toLowerCase());
        if (p) { p.id = socket.id; } 
        else {
            if (r.gameStarted) return socket.emit('error-join', 'Игра уже идет!');
            p = { id: socket.id, name, char: null, score: 0, lastPoints: 0 };
            r.players.push(p);
        }
        
        socket.join(c);
        socket.emit('joined-success', { code: c });
        io.to(r.host).emit('player-list-update', r.players);
    });

    socket.on('select-char', ({ code, name, char }) => {
        const r = rooms[code];
        const p = r?.players.find(pl => pl.name === name);
        if (p) { 
            p.char = char; 
            io.to(r.host).emit('player-list-update', r.players);
            socket.emit('char-confirmed');
        }
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
            for (let i = 0; i < shuf.length; i++) {
                let q = await getAIQuestion(false);
                r.pairs.push({ p1: shuf[i], p2: shuf[(i+1)%shuf.length], q, ans1: null, ans2: null, votes: [], finished: false });
            }
        } else {
            let q = await getAIQuestion(true);
            r.pairs.push({ isFinal: true, q, allAnswers: [], votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code];
        const pair = r.pairs[r.currentPairIndex];
        if (!pair) return io.to(code).emit('show-scores', { players: r.players, round: r.round });
        
        io.to(code).emit('round-started', { 
            round: r.round, q: pair.q, 
            p1_name: pair.p1?.name, p2_name: pair.p2?.name, 
            isFinal: pair.isFinal 
        });
        
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (r.settings.timer + 2) * 1000);
    }

    function forceSubmit(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if(!p || p.finished) return;
        if(!p.ans1) p.ans1 = "..."; if(!p.isFinal && !p.ans2) p.ans2 = "...";
        showVoting(code, p);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code]; const p = r?.pairs[r.currentPairIndex];
        if (!p) return;
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (p.p1?.name === name) p.ans1 = txt;
        if (p.p2?.name === name) p.ans2 = txt;
        if (p.ans1 && (!p.p2 || p.ans2)) { clearTimeout(timers[code]); showVoting(code, p); }
    });

    function showVoting(code, pair) {
        io.to(code).emit('show-voting', { 
            ans1: pair.ans1, ans2: pair.ans2, 
            isSolo: !pair.p2, p1_name: pair.p1?.name, p2_name: pair.p2?.name 
        });
        if(!pair.p2) setTimeout(() => finishPair(code), 6000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return;
        p.votes.push(voteNum);
        if (p.votes.length >= (r.players.length - (p.p2 ? 2 : 1))) finishPair(code);
    });

    function finishPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return; p.finished = true;
        let v1 = p.votes.filter(v=>v===1).length, v2 = p.votes.filter(v=>v===2).length;
        let mult = (r.round === 3) ? 300 : r.round * 100;
        if(p.p1) p.p1.score += v1 * mult; if(p.p2) p.p2.score += v2 * mult;
        
        io.to(code).emit('voting-results', { v1, v2, p1: p.p1?.name, p2: p.p2?.name });
        setTimeout(() => { if(rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 5000);
    }

    socket.on('next-after-scores', code => {
        if (rooms[code].round < 3) startRound(code, rooms[code].round + 1);
        else io.to(code).emit('final-results', { players: rooms[code].players.sort((a,b)=>b.score-a.score) });
    });
});

server.listen(process.env.PORT || 3000);
