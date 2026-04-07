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

// --- КОНФИГУРАЦИЯ ---
const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

const G_ID = process.env.G_CLIENT_ID || "920613280507-tle9fsn923dqdj5k7oro9ejc2dfsru4a.apps.googleusercontent.com";
const G_SEC = process.env.G_CLIENT_SECRET || "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";

app.use(session({ secret: 'vanga-perforator-secret', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(__dirname));

// --- GOOGLE OAUTH ---
passport.use(new GoogleStrategy({
    clientID: G_ID,
    clientSecret: G_SEC,
    callbackURL: "https://greho-smeh-x8hq.onrender.com/auth/google/callback"
}, (token, tokenSecret, profile, done) => done(null, profile)));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/player.html'));
app.get('/api/me', (req, res) => res.json(req.user || null));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/index.html')); });

// --- ГЛОБАЛЬНЫЙ ЛИДЕРБОРД ---
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

// --- БАЗА ВОПРОСОВ (110 ШТУК) ---
const prompts = {
    ru: {
        classic: [
            "Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "За что Дима Moderass любит Вангу?",
            "Худшая фраза хирурга перед сном?", "Самое странное название для туалетной бумаги?",
            "За что Дима Moderass забанил бы собственную маму?", "Секретный ингредиент в супе Ванги?",
            "Почему у пингвинов нет коленей?", "Если бы у овощей была армия, кто был бы генералом?",
            "Девиз школы магии для очень ленивых.", "Что инопланетяне на самом деле думают о ТикТоке?",
            "Если бы чипсы умели кричать, какой бы это был звук?", "Самая бесполезная суперспособность.",
            "Идеальное оправдание для опоздания на работу на 4 часа.", "Название рок-группы бухгалтеров.",
            "Что на самом деле находится внутри черных дыр?", "Странный ингредиент для пиццы, который станет хитом.",
            "Как называется болезнь, когда ты думаешь, что ты — тостер?", "Худшее место для первого свидания.",
            "Придумай название для приложения, которое ничего не делает.", "Что Дед Мороз делает летом?",
            "Самый глупый способ потратить миллиард долларов.", "Девиз города, где запрещены улыбки.",
            "Новый вид спорта для Олимпийских игр.", "Название шоколадки со вкусом бекона и рыбы.",
            "Что ты скажешь самому себе из будущего в туалете?", "Лучшая работа для ленивого привидения?",
            "Имя, которое нельзя давать ребенку ни в коем случае.", "Куда уходят деревья, когда никто не видит?",
            "Что Ванга шепчет своему перфоратору?", "Почему Дима Moderass всегда онлайн?",
            "Самая нелепая причина для начала войны.", "Что кошки на самом деле пишут в своих Твиттерах?",
            "Как выглядит ад для веганов?", "Главный страх лысого стримера.",
            "Если бы ты был запахом, то каким?", "Самая странная вещь в твоем кармане прямо сейчас.",
            "Придумай название для фильма ужасов про Диму Модерасса.", "Что будет, если Ванга отрастит волосы?",
            "Почему в космосе нет вай-фая?", "Худший подарок на свадьбу.",
            "Зачем люди едят кактусы?", "Что скрывается за последней страницей интернета?",
            "Как выжить в подвале у Димы?", "Самый неловкий звук в тишине.",
            "Придумай название для планеты, где живут только мемы.", "Что Ванга ест на завтрак?",
            "Почему Дима Moderass носит очки (на самом деле)?", "Худшая вещь, которую можно услышать от пилота самолета.",
            "Если бы ты мог говорить с мебелью, что бы тебе сказал стул?", "Самая тупая причина вызвать полицию.",
            "Как выглядит идеальный выходной Ванги?", "Что Дима делает с забаненными людьми?",
            "Придумай девиз для общества анонимных любителей майонеза.", "Почему лысина Ванги светится в темноте?",
            "Худшая надпись на футболке для свидания.", "Если бы у тебя был ручной дракон, как бы ты его назвал?",
            "Что находится в секретной папке на компе у Димы?", "Самая странная работа в мире.",
            "Зачем Ванга купил перфоратор?", "Что Дима Moderass думает о тебе прямо сейчас?",
            "Придумай название для водки со вкусом огурца.", "Как звучит смех Сатаны?",
            "Почему небо синее, а Ванга нет?", "Что ты сделаешь, если проснешься в теле Димы?",
            "Худший совет от бабушки.", "Самый кринжовый способ признаться в любви.",
            "Если бы интернет отключили навсегда, чем бы занялся Ванга?", "Что скрывает твоя зубная щетка?",
            "Почему Дима никогда не смеется над твоими шутками?", "Придумай название для магазина бесполезных вещей.",
            "Что делает Ванга, когда выключают свет?", "Самый быстрый способ разозлить модератора.",
            "Худшее оправдание, почему ты лысый.", "Если бы Ванга был супергероем, как бы его звали?",
            "Что Дима Moderass прячет под клавиатурой?", "Самый нелепый закон в мире.",
            "Зачем Ванге вторая кепка?", "Что будет, если Дима и Ванга поменяются телами?",
            "Худшая песня для караоке.", "Почему ты всё еще играешь в эту игру?",
            "Придумай название для страны, где правит Дима.", "Что Ванга делает с волосами, которые выпадают?",
            "Самая странная вещь, которую можно найти в холодильнике.", "Как объяснить инопланетянам, кто такой Ванга?",
            "Почему модераторы такие злые?", "Худшее место для сна.",
            "Придумай название для бренда одежды от Ванги.", "Что Дима Модерасс делает в 3 часа ночи?",
            "Самый глупый вопрос, который тебе задавали.", "Если бы Ванга был собакой, какой породы?",
            "Что скрывает подвал Димы на самом деле?", "Зачем перфоратору Ванги нужны глаза?",
            "Придумай девиз для этой игры.", "Почему эта игра лучше, чем работа?"
        ],
        final: [
            "3 причины не доверять Диме Модерассу", "3 признака, что ты лысеешь", 
            "3 вещи, которые Ванга прячет в подвале", "3 способа разозлить Диму за секунду",
            "3 причины, почему Ванга Фiйко — лучший", "3 вещи, которые нельзя делать с перфоратором",
            "3 самых странных запроса в истории поиска Димы", "3 причины, почему лысина — это удобно",
            "3 вещи, которые можно найти в кепке Ванги", "3 способа объяснить, почему ты лысый",
            "3 фразы, которые Дима говорит в зеркало", "3 худших подарка для Ванги",
            "3 признака, что твой сосед — Ванга", "3 способа выжить в чате Димы",
            "3 причины, почему эта игра — имба"
        ]
    }
};

const rooms = {};
let timers = {};

// ГЕНЕРАТОР ВОПРОСОВ ИИ
async function getUniqueQuestion(room, isFinal) {
    const type = isFinal ? "final" : "classic";
    room.usedQuestions = room.usedQuestions || [];
    
    if (Math.random() < 0.8) { // 80% шанс на ИИ
        try {
            const prompt = `Придумай один ${isFinal?"вопрос на 3 ответа":"смешной вопрос"} на русском. Мемный юмор про Вангу, Диму, лысину.`;
            const res = await aiModel.generateContent(prompt);
            let q = res.response.text().trim().replace(/[*"']/g, "");
            if (q && !room.usedQuestions.includes(q)) { room.usedQuestions.push(q); return q; }
        } catch (e) { }
    }

    let available = prompts.ru[type].filter(q => !room.usedQuestions.includes(q));
    if (available.length === 0) { room.usedQuestions = []; available = prompts.ru[type]; }
    const q = available[Math.floor(Math.random() * available.length)];
    room.usedQuestions.push(q);
    return q;
}

// ГЕНЕРАТОР КОММЕНТАРИЕВ
async function getAIComment(q, a1, a2) {
    try {
        const res = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши едкую реакцию (5 слов).`);
        return res.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return "Результаты на экране!"; }
}

io.on('connection', (socket) => {
    socket.emit('global-top-update', Object.values(getLeaderboard()).sort((a,b)=>b.score-a.score).slice(0,10));

    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, allJokes: [], usedQuestions: [], settings: { timer: 30, voice: 'male' } };
        } else rooms[code].host = socket.id;
        socket.join(code); socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name, googleId }) => {
        const c = code?.trim().toUpperCase();
        const r = rooms[c];
        if (!r) return socket.emit('error-join', 'Комната не найдена!');
        r.players = r.players.filter(p => p.name !== name);
        const p = { id: socket.id, name, googleId, emoji: '❓', score: 0, lastPoints: 0 };
        r.players.push(p);
        socket.join(c); socket.emit('joined-success', { code: c, gameStarted: r.gameStarted });
        io.to(r.host).emit('player-list-update', r.players);
    });

    socket.on('start-game', (code) => { 
        if (rooms[code]) { rooms[code].gameStarted = true; startRound(code, 1); }
    });

    async function startRound(code, num) {
        const r = rooms[code]; if(!r) return;
        r.round = num; r.currentPairIndex = 0; r.pairs = [];
        let shuf = [...r.players].sort(() => 0.5 - Math.random());
        for (let i = 0; i < (num === 3 ? 1 : shuf.length); i += 2) {
            let q = await getUniqueQuestion(r, num === 3);
            r.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p) {
            io.to(code).emit('show-scores', { players: r.players, round: r.round, time: 10 });
            setTimeout(() => { if (r.round < 3) startRound(code, r.round + 1); else finishGame(code); }, 11000);
            return;
        }
        io.to(code).emit('round-started', { round: r.round, q: p.q, p1_name: p.p1.name, p2_name: p.p2?.name, time: r.settings.timer });
    }

    function finishGame(code) {
        const r = rooms[code]; const sorted = r.players.sort((a,b)=>b.score-a.score);
        if(sorted[0].googleId) updateGlobalScore(sorted[0].googleId, sorted[0].name, 25, sorted[0].emoji);
        io.to(code).emit('final-results', { players: sorted, best: r.allJokes.sort((a,b)=>b.votes-a.votes).slice(0,5) });
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

server.listen(process.env.PORT || 3000);
