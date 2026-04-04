const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 2e7, 
    cors: { origin: "*" } 
});

const API_KEY = "AIzaSyCibKfIWK9szQ0bzJi8ZJ3YNaHZ99F8x64"; 
const genAI = new GoogleGenerativeAI(API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

app.use(express.static(__dirname));

// Универсальный обработчик путей (Фикс Not Found)
function serve(res, file) {
    const p = path.join(__dirname, file);
    if (fs.existsSync(p)) res.sendFile(p);
    else res.status(404).send(`Файл ${file} не найден на GitHub!`);
}

app.get('/', (req, res) => serve(res, 'index.html'));
app.get('/host', (req, res) => serve(res, 'host.html'));
app.get('/player', (req, res) => serve(res, 'player.html'));

const prompts = {
    ru: {
        classic: [
            "Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "За что Дима Moderass любит Вангу?",
            "Худшая фраза хирурга перед сном.", "Самое странное название для туалетной бумаги.",
            "Почему Дима Moderass опять забанил пол-чата?", "Секретный ингредиент в супе Ванги.",
            "Как называется болезнь 'перфоратор головного мозга'?", "Способ потратить миллиард за 5 минут.",
            "Что инопланетяне думают о ТикТоке?", "Если бы чипсы умели кричать, какой бы это был звук?",
            "Самая бесполезная суперспособность.", "Название для рок-группы бухгалтеров.",
            "Что внутри черных дыр (версия Димы)?", "Оправдание для опоздания на работу на 4 часа.",
            "Почему пингвины не летают?", "Худшее место для первого свидания у Ванги.",
            "Название приложения, которое только тратит деньги.", "Что Дед Мороз делает летом?",
            "Девиз города, где запрещено улыбаться.", "Новый вид спорта для Олимпийских игр.",
            "Шоколадка со вкусом бекона и носков.", "Что ты скажешь себе из будущего в туалете?",
            "Куда бы пошли деревья, если бы умели ходить?", "Почему Дима Moderass всегда онлайн?",
            "Что в кармане у Ванги?", "Главный экспонат в музее кринжа.",
            "Что шепчут кошки в пустой угол?", "Худшее название для садика.",
            "Почему небо синее, а перфоратор нет?", "Дима Модерасс — президент мира. Твои действия?",
            "Оружие против лысых стримеров.", "Как выжить в подвале у Димы?",
            "Нелепое признание в любви на Твиче.", "Почему у Ванги кепка приклеена к голове?",
            "Что Ванга Фiйко делает, когда выключают свет?", "Худшая вещь, которую можно найти в бургере.",
            "Если бы у овощей была армия, кто был бы генералом?", "Почему коты смотрят в пустоту?",
            "Лучшее название для водки из огурцов.", "Что Дима делает, когда никто не видит?"
        ],
        final: [
            "3 причины не доверять Ванге Фiйко", "3 вещи под кроватью Димы",
            "3 признака, что сосед — это Ванга", "3 способа потратить маткапитал",
            "3 вещи, которые нельзя совать в перфоратор", "3 причины, почему лысина — это круто",
            "3 странных запроса в истории поиска Димы", "3 находки в заброшенном подвале",
            "3 причины, почему ИИ удалит Твич", "3 способа украсть кепку Ванги"
        ]
    }
};

const rooms = {};
let timers = {};

async function getAIQuestion(isFinal = false) {
    try {
        const prompt = `Ты ведущий игры "Грехо-Смех". Придумай один ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} на русском. Юмор: Jackbox style, мемный. Про Вангу или Диму. Только текст.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return prompts.ru.classic[0]; }
}

async function getAIComment(q, a1, a2) {
    try {
        const prompt = `Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши одну короткую (5 слов) едкую реакцию.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim().replace(/[*"']/g, "");
    } catch (e) { return "Ну и кринж!"; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 30 } };
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
            let q = (Math.random() < 0.8) ? await getAIQuestion(roundNum === 3) : prompts.ru.classic[Math.floor(Math.random()*prompts.ru.classic.length)];
            r.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        if (!pair) {
            io.to(code).emit('show-scores', { players: r.players, round: r.round, time: 15 });
            setTimeout(() => { if (r.round < 3) startRound(code, r.round + 1); }, 16000);
            return;
        }
        io.to(code).emit('round-started', { round: r.round, q: pair.q, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, time: 30 });
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code]; const pair = r?.pairs[r.currentPairIndex];
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) {
            io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, p1_name: pair.p1.name, p2_name: pair.p2 ? pair.p2.name : null, time: 20 });
            if (!pair.p2) setTimeout(() => finishPair(code), 10000);
        }
    });

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        if (!pair || pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (r.players.length - (pair.p2 ? 2 : 1))) finishPair(code);
    });

    async function finishPair(code) {
        const r = rooms[code]; const pair = r.pairs[r.currentPairIndex];
        if (!pair || pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length, v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = r.round * 100;
        let p1Points = !pair.p2 ? 100 : v1 * mult;
        let p2Points = v2 * mult;
        pair.p1.score += p1Points; if (pair.p2) pair.p2.score += p2Points;
        const comment = await getAIComment(pair.q, pair.ans1, pair.ans2 || "");
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, isSolo: !pair.p2, v1, v2, p1Points, p2Points, aiComment: comment });
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }
    
    socket.on('select-emoji', ({ code, name, emoji }) => {
        const p = rooms[code]?.players.find(pl => pl.name === name);
        if (p) { p.emoji = emoji; io.to(code).emit('player-list-update', rooms[code].players); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ready!'));
