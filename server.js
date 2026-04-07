const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

// КЛЮЧИ (GitHub не будет ругаться на process.env)
const G_ID = process.env.G_CLIENT_ID || "920613280507-tle9fsn923dqdj5k7oro9ejc2dfsru4a.apps.googleusercontent.com";
const G_SEC = process.env.G_CLIENT_SECRET || "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";

const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

app.use(session({ secret: 'vanga-secret-key', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(__dirname));

passport.use(new GoogleStrategy({
    clientID: G_ID,
    clientSecret: G_SEC,
    callbackURL: "https://greho-smeh-x8hq.onrender.com/auth/google/callback"
}, (token, tokenSecret, profile, done) => done(null, profile)));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/api/me', (req, res) => res.json(req.user || null));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// --- ГЛОБАЛЬНЫЙ ТОП ---
const leaderboardPath = path.join(__dirname, 'leaderboard.json');
function getLeaderboard() { try { return JSON.parse(fs.readFileSync(leaderboardPath)); } catch (e) { return {}; } }
function updateGlobalScore(gid, name, pts, emoji) {
    const board = getLeaderboard();
    if (!board[gid]) board[gid] = { name, score: 0, emoji: emoji || '👤' };
    board[gid].score += pts;
    board[gid].name = name;
    if (emoji && emoji !== '❓') board[gid].emoji = emoji;
    fs.writeFileSync(leaderboardPath, JSON.stringify(board));
    io.emit('global-top-update', Object.values(board).sort((a,b)=>b.score-a.score).slice(0,10));
}

// Маршруты
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));

const prompts = {
    ru: {
        classic: ["Почему Ванга лысый?", "Что Ванга скрывает под кепкой?", "За что Дима любит Вангу?"],
        final: ["3 причины не доверять Диме", "3 признака, что ты лысеешь"]
    }
};
const rooms = {};
let timers = {};

async function getUniqueQuestion(room, isFinal) {
    try {
        const res = await aiModel.generateContent(`Придумай 1 ${isFinal?"вопрос на 3 ответа":"смешной вопрос"} на русском. Мемный юмор.`);
        return res.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return prompts.ru.classic[0]; }
}

io.on('connection', (socket) => {
    socket.emit('global-top-update', Object.values(getLeaderboard()).sort((a,b)=>b.score-a.score).slice(0,10));

    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, allJokes: [], settings: { timer: 30, voice: 'male' } };
        } else rooms[code].host = socket.id;
        socket.join(code); socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name, googleId }) => {
        const c = code?.trim().toUpperCase();
        const r = rooms[c];
        if (!r) return socket.emit('error-join', 'Комната не найдена!');
        r.players = r.players.filter(p => p.name !== name);
        const p = { id: socket.id, name, googleId, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(p);
        socket.join(c); socket.emit('joined-success', { code: c });
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('start-game', (code) => { startRound(code, 1); });

    async function startRound(code, num) {
        const r = rooms[code]; if(!r) return;
        r.round = num; r.currentPairIndex = 0; r.pairs = [];
        let shuf = [...r.players].sort(() => 0.5 - Math.random());
        for (let i = 0; i < shuf.length; i += 2) {
            let q = await getUniqueQuestion(r, num === 3);
            r.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p) {
            io.to(code).emit('show-scores', { players: r.players, round: r.round, time: 10 });
            setTimeout(() => { 
                if (r.round < 3) startRound(code, r.round + 1); 
                else {
                    const sorted = r.players.sort((a,b)=>b.score-a.score);
                    const win = sorted[0];
                    if(win.googleId) updateGlobalScore(win.googleId, win.name, 25, win.emoji);
                    io.to(code).emit('final-results', { players: sorted, best: r.allJokes.sort((a,b)=>b.votes-a.votes).slice(0,5) });
                }
            }, 11000);
            return;
        }
        io.to(code).emit('round-started', { round: r.round, q: p.q, p1_name: p.p1.name, p2_name: p.p2?.name, time: r.settings.timer });
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code]; const p = r?.pairs[r.currentPairIndex];
        const txt = Array.isArray(answer) ? answer.join(' | ') : answer;
        if (p.p1.name === name) p.ans1 = txt;
        if (p.p2 && p.p2.name === name) p.ans2 = txt;
        if (p.ans1 && (!p.p2 || p.ans2)) io.to(code).emit('show-voting', { ans1: p.ans1, ans2: p.ans2, isSolo: !p.p2, p1_name: p.p1.name, p2_name: p.p2?.name, time: 20 });
    });

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p || p.finished) return;
        p.votes.push({ voter: socket.id, voteNum });
        if (p.votes.length >= (r.players.length - (p.p2 ? 2 : 1))) {
            p.finished = true;
            let v1 = p.votes.filter(v => v.voteNum === 1).length, v2 = p.votes.filter(v => v.voteNum === 2).length;
            let p1p = !p.p2 ? 100 : v1 * 100, p2p = v2 * 100;
            p.p1.score += p1p; if(p.p2) p.p2.score += p2p;
            if(p.ans1 !== "EMPTY") r.allJokes.push({ text: p.ans1, author: p.p1.name, votes: v1, emoji: p.p1.emoji });
            io.to(code).emit('voting-results', { p1: p.p1, p2: p.p2, isSolo: !p.p2, v1, v2, p1Points: p1p, p2Points: p2p });
            setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
        }
    });

    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });
    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ready'));
