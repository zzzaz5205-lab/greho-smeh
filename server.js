const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const session = require('express-session');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4e7, cors: { origin: "*" } });

// --- НАСТРОЙКИ TWITCH (ЗАМЕНИ НА СВОИ) ---
const TWITCH_CLIENT_ID = 'ТВОЙ_CLIENT_ID';
const TWITCH_CLIENT_SECRET = 'ТВОЙ_CLIENT_SECRET';
const REDIRECT_URI = 'https://greho-smeh-x8hq.onrender.com/auth/twitch/callback';

app.use(session({
    secret: 'vanga-secret-key',
    resave: false,
    saveUninitialized: true
}));

const genAI = new GoogleGenerativeAI("AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64");
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.use(express.static(__dirname));

// --- TWITCH АВТОРИЗАЦИЯ ---
app.get('/auth/twitch', (req, res) => {
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=user:read:email`;
    res.redirect(url);
});

app.get('/auth/twitch/callback', async (req, res) => {
    const code = req.query.code;
    try {
        const tokenRes = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&code=${code}&grant_type=authorization_code&redirect_uri=${REDIRECT_URI}`);
        const userRes = await axios.get('https://api.twitch.tv/helix/users', {
            headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${tokenRes.data.access_token}` }
        });
        req.session.twitchUser = userRes.data.data[0];
        res.redirect('/');
    } catch (e) { res.send("Ошибка Twitch"); }
});

app.get('/api/me', (req, res) => res.json(req.session.twitchUser || null));

// --- ГЛОБАЛЬНЫЙ ТОП ---
const leaderboardPath = path.join(__dirname, 'leaderboard.json');
function getLeaderboard() {
    try { return JSON.parse(fs.readFileSync(leaderboardPath)); } catch (e) { return {}; }
}

function updateGlobalScore(name, points, emoji) {
    const board = getLeaderboard();
    if (!board[name]) board[name] = { score: 0, emoji: emoji || '👤' };
    board[name].score += points;
    fs.writeFileSync(leaderboardPath, JSON.stringify(board));
    io.emit('global-top-update', Object.entries(board).sort((a,b)=>b[1].score - a[1].score).slice(0, 10));
}

// Маршруты для Render
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));
app.get('/mod', (req, res) => res.sendFile(path.resolve(__dirname, 'mod.html')));

const prompts = {
    ru: {
        classic: ["Почему Ванга лысый?", "Секрет Димы Модерасса", "Худшая фраза хирурга?"],
        final: ["3 причины не доверять Диме", "3 вещи в подвале Ванги"]
    }
};

const rooms = {};
let timers = {};

async function getUniqueQuestion(room, isFinal = false) {
    try {
        const type = isFinal ? "final" : "classic";
        const prompt = `Придумай один ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} на русском. Юмор: Jackbox, мемный. Про Вангу или Диму. Только текст.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return "Почему лысина блестит?"; }
}

io.on('connection', (socket) => {
    socket.emit('global-top-update', Object.entries(getLeaderboard()).sort((a,b)=>b[1].score - a[1].score).slice(0, 10));

    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, allJokes: [], settings: { timer: 30, voice: 'male', moderation: false } };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name, isTwitch }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        room.players = room.players.filter(p => p.name !== name);
        const p = { id: socket.id, name, emoji: '❓', score: 0, lastPoints: 0, isTwitch: !!isTwitch };
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
        for (let i = 0; i < (roundNum === 3 ? 1 : shuf.length); i += 2) {
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
                    if (sorted[0].isTwitch) updateGlobalScore(sorted[0].name, 25, sorted[0].emoji);
                    io.to(code).emit('final-results', { players: sorted, best: room.allJokes.sort((a,b)=>b.votes-a.votes).slice(0,5) });
                }
            }, 11000);
            return;
        }
        io.to(code).emit('round-started', { round: room.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2?.name, time: room.settings.timer });
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (room.settings.moderation) {
            io.to(room.host).emit('mod-check', { name, answer: txt, code });
        } else { processAns(code, name, txt); }
    });

    socket.on('mod-action', ({ code, name, answer, action }) => {
        processAns(code, name, action === 'block' ? "ЗАБЛОКИРОВАНО" : answer);
    });

    function processAns(code, name, answer) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (pair.p1.name === name) pair.ans1 = answer;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = answer;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, p1_name: pair.p1.name, p2_name: pair.p2?.name, time: 20 });
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (pair.finished) return;
        pair.votes.push(voteNum);
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) finishPair(code);
    });

    function finishPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair || pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v === 1).length, v2 = pair.votes.filter(v => v === 2).length;
        let p1Points = !pair.p2 ? 100 : v1 * 100;
        let p2Points = v2 * 100;
        pair.p1.score += p1Points; if (pair.p2) pair.p2.score += p2Points;
        room.allJokes.push({ text: pair.ans1, author: pair.p1.name, votes: v1, emoji: pair.p1.emoji });
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2, p1Points, p2Points });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }
    
    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });
    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

server.listen(process.env.PORT || 3000);
