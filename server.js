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
const io = new Server(server, { 
    maxHttpBufferSize: 2e7, 
    cors: { origin: "*" } 
});

// --- КОНФИГУРАЦИЯ ИИ (GEMINI 3 FLASH PREVIEW) ---
const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

// --- КОНФИГУРАЦИЯ GOOGLE AUTH ---
const G_ID = process.env.G_CLIENT_ID || "920613280507-tle9fsn923dqdj5k7oro9ejc2dfsru4a.apps.googleusercontent.com";
const G_SEC = process.env.G_CLIENT_SECRET || "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";

app.use(session({ secret: 'vanga-perforator-mega-secret', resave: false, saveUninitialized: true }));
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

// --- МАРШРУТЫ АВТОРИЗАЦИИ ---
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/player.html'));
app.get('/api/me', (req, res) => res.json(req.user || null));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/index.html')); });

// --- ГЛОБАЛЬНЫЙ ЛИДЕРБОРД ---
const leaderboardPath = path.join(__dirname, 'leaderboard.json');
function getLeaderboard() {
    try { if (!fs.existsSync(leaderboardPath)) return {}; return JSON.parse(fs.readFileSync(leaderboardPath)); } catch (e) { return {}; }
}
function updateGlobalScore(googleId, name, points, emoji) {
    const board = getLeaderboard();
    if (!board[googleId]) board[googleId] = { name, score: 0, emoji: emoji || '👤' };
    board[googleId].score += points;
    board[googleId].name = name;
    if (emoji && emoji !== '❓') board[googleId].emoji = emoji;
    fs.writeFileSync(leaderboardPath, JSON.stringify(board));
    io.emit('global-top-update', Object.values(board).sort((a, b) => b.score - a.score).slice(0, 10));
}

// --- БАЗА ВОПРОСОВ (100+) ---
const prompts = {
    ru: {
        classic: [
            "Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "За что Дима Moderass любит Вангу?",
            "Худшая фраза хирурга перед сном?", "Самое странное название для туалетной бумаги?",
            "Почему Дима Moderass всегда онлайн?", "Секретный ингредиент в супе Ванги?",
            "Если бы у овощей была армия, кто был бы генералом?", "Что инопланетяне думают о ТикТоке?",
            "Самая бесполезная суперспособность.", "Название рок-группы бухгалтеров.",
            "Как выглядит ад для веганов?", "Главный страх лысого стримера.",
            "Что Ванга шепчет своему перфоратору?", "Самая нелепая причина для начала войны.",
            "Зачем Ванга купил перфоратор?", "Что Дима делает с забаненными людьми?",
            "Почему лысина Ванги светится в темноте?", "Что скрывает твоя зубная щетка?",
            "Что делает Ванга, когда выключают свет?", "Худшее оправдание, почему ты лысый.",
            "Зачем Ванге вторая кепка?", "Почему модераторы такие злые?",
            "Придумай девиз для этой игры.", "Почему Дима никогда не смеется?"
        ],
        final: [
            "3 причины не доверять Диме Модерассу", "3 признака, что ты лысеешь", 
            "3 вещи, которые Ванга прячет в подвале", "3 способа разозлить Диму",
            "3 причины, почему лысина — это удобно", "3 худших подарка для Ванги"
        ]
    }
};

const rooms = {};
let timers = {};

// ГЕНЕРАТОРЫ ИИ (GEMINI 3)
async function getAIQuestion(room, isFinal) {
    if (Math.random() < 0.8) {
        try {
            const type = isFinal ? "список из 3 вещей" : "смешной вопрос";
            const res = await aiModel.generateContent(`Ты ведущий игры Грехо-Смех. Придумай один ${type} на русском. Юмор: едкий, мемный. Про Вангу, Диму или лысину.`);
            let q = res.response.text().trim().replace(/[*"']/g, "");
            if (q) return q;
        } catch (e) { console.log("AI Error"); }
    }
    const list = isFinal ? prompts.ru.final : prompts.ru.classic;
    return list[Math.floor(Math.random() * list.length)];
}

async function getAIComment(q, a1, a2) {
    try {
        const res = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши одну короткую (5 слов) едкую реакцию на русском.`);
        return res.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return "Ну и кринж вы выдали!"; }
}

// --- ЛОГИКА СОКЕТОВ ---
io.on('connection', (socket) => {
    socket.emit('global-top-update', Object.values(getLeaderboard()).sort((a,b)=>b.score-a.score).slice(0,10));

    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, allJokes: [], settings: { timer: 30, voice: 'male', moderation: false } };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name, googleId }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');

        room.players = room.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());
        const p = { id: socket.id, name, googleId, emoji: '❓', score: 0, lastPoints: 0 };
        room.players.push(p);

        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode, gameStarted: room.gameStarted });
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('update-settings', ({ code, settings, mode }) => {
        if (rooms[code]) { rooms[code].settings = settings; io.to(code).emit('settings-updated', settings); }
    });

    socket.on('join-mod', (code) => {
        const r = rooms[code.toUpperCase()];
        if (r) { r.modId = socket.id; socket.join(code.toUpperCase()); socket.emit('mod-success'); }
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) { 
            room.gameStarted = true; 
            io.to(code).emit('game-started-signal');
            startRound(code, 1); 
        }
    });

    async function startRound(code, num) {
        const r = rooms[code];
        r.round = num; r.currentPairIndex = 0; r.pairs = [];
        let shuf = [...r.players].sort(() => 0.5 - Math.random());
        const count = (num === 3) ? 1 : shuf.length;
        for (let i = 0; i < count; i++) {
            let q = await getAIQuestion(r, num === 3);
            r.pairs.push({ p1: shuf[i], p2: shuf[(i+1)%shuf.length], q, ans1: null, ans2: null, votes: [], finished: false, isSolo: (shuf.length < 2) });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        if (!pair) {
            io.to(code).emit('show-scores', { players: r.players, round: r.round, time: 10 });
            setTimeout(() => { if (r.round < 3) startRound(code, r.round + 1); else finishGame(code); }, 11000);
            return;
        }
        io.to(code).emit('round-started', { round: r.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2?.name, time: r.settings.timer });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (r.settings.timer + 1) * 1000);
    }

    function forceSubmit(code) {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        if (!pair || pair.finished) return;
        if (!pair.ans1) pair.ans1 = "EMPTY"; if (pair.p2 && !pair.ans2) pair.ans2 = "EMPTY";
        showVoting(code, pair);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code];
        if (r.settings.moderation && r.modId) {
            io.to(r.modId).emit('mod-check', { name, answer, code });
        } else { processAnswer(code, name, answer); }
    });

    socket.on('mod-action', ({ code, name, answer, action }) => {
        processAnswer(code, name, (action === 'block' ? "ЗАБЛОКИРОВАНО" : answer));
    });

    function processAnswer(code, name, answer) {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { clearTimeout(timers[code]); showVoting(code, pair); }
    }

    function showVoting(code, pair) {
        const isBothEmpty = (pair.ans1 === "EMPTY" && pair.ans2 === "EMPTY");
        io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, bothEmpty: isBothEmpty, p1_name: pair.p1.name, p2_name: pair.p2?.name, time: 20 });
        if(timers[code]) clearTimeout(timers[code]);
        if (!pair.p2 || isBothEmpty) timers[code] = setTimeout(() => finishPair(code), 6000);
        else timers[code] = setTimeout(() => finishPair(code), 22000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (r.players.length - (pair.p2 ? 2 : 1))) { clearTimeout(timers[code]); finishPair(code); }
    });

    async function finishPair(code) {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        if (!pair || pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length, v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = r.round * 100;
        let p1p = !pair.p2 ? 100 : v1 * mult, p2p = v2 * mult;
        pair.p1.score += p1p; if (pair.p2) pair.p2.score += p2p;
        if (pair.ans1 !== "EMPTY") r.allJokes.push({ text: pair.ans1, author: pair.p1.name, votes: v1, emoji: pair.p1.emoji });
        const comment = await getAIComment(pair.q, pair.ans1, pair.ans2 || "");
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2, p1Points: p1p, p2Points: p2p, aiComment: comment });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }

    function finishGame(code) {
        const r = rooms[code]; const sorted = r.players.sort((a,b)=>b.score-a.score);
        if(sorted[0].googleId) updateGlobalScore(sorted[0].googleId, sorted[0].name, 25, sorted[0].emoji);
        io.to(code).emit('final-results', { players: sorted, best: r.allJokes.sort((a,b)=>b.votes-a.votes).slice(0,5) });
    }

    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });

    socket.on('finish-credits', (code) => { io.to(code).emit('go-to-menu'); delete rooms[code]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Greho-Smeh 2.0 SPA Server Ready'));
