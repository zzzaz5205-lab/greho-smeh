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

const prompts = [
    "Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "За что Дима Moderass любит Вангу?",
    "Худшая фраза хирурга перед сном.", "Почему у пингвинов нет коленей?", "Самое странное название для туалетной бумаги.",
    "Если бы у овощей была армия, кто был бы генералом?", "Девиз школы магии для ленивых.", "Худшее место для первого свидания.",
    "Придумай название для приложения, которое ничего не делает.", "Если бы чипсы умели кричать, какой бы это был звук?",
    "Самая бесполезная суперспособность.", "Название для рок-группы бухгалтеров.", "Что инопланетяне думают о ТикТоке?",
    "Что Дед Мороз делает летом на самом деле?", "Самый глупый способ потратить миллиард долларов.", "Секретный ингредиент в супе Ванги.",
    "Почему Дима Moderass всегда онлайн?", "Если бы деревья могли ходить, куда бы они пошли?", "Название шоколадки со вкусом бекона и рыбы.",
    "Что ты скажешь себе из будущего?", "Худший подарок на день рождения.", "Почему небо синее, а Ванга нет?",
    "Если бы у тебя был робот-слуга, что бы сломалось первым?", "Как называется болезнь, когда думаешь, что ты тостер?",
    "Девиз города, где запрещено улыбаться.", "Какой вид спорта нужно добавить в Олимпийские игры?",
    "Что на самом деле находится внутри черных дыр?", "Идеальное оправдание для опоздания на работу на 3 часа.", "Худший фильм ужасов всех времен."
];

const rooms = {};
let timers = {};

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
        
        r.players = r.players.filter(p => p.name !== name);
        // Изначально — серый квадрат-пустышка
        const p = { id: socket.id, name, char: { shape: 'cube', color: '#888', active: false }, score: 0 };
        r.players.push(p);
        
        socket.join(c);
        socket.emit('joined-success', { code: c });
        io.to(r.host).emit('player-list-update', r.players);
    });

    socket.on('select-char', ({ code, name, char }) => {
        const r = rooms[code];
        const p = r?.players.find(pl => pl.name === name);
        if (p) { 
            p.char = { ...char, active: true }; // Теперь персонаж "ожил"
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
        let shuf = [...r.players].sort(() => 0.5 - Math.random());
        r.pairs = [];
        for (let i = 0; i < shuf.length; i += 2) {
            let q = prompts[Math.floor(Math.random()*prompts.length)];
            r.pairs.push({ p1: shuf[i], p2: shuf[i+1] || null, q, ans1: null, ans2: null, votes: [], finished: false });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if (!p) return io.to(code).emit('show-scores', r.players);
        io.to(code).emit('round-started', { q: p.q, p1_name: p.p1.name, p2_name: p.p2 ? p.p2.name : null, time: 30 });
        
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), 32000);
    }

    function forceSubmit(code) {
        const p = rooms[code].pairs[rooms[code].currentPairIndex];
        if(p.finished) return;
        if(!p.ans1) p.ans1 = "..."; if(p.p2 && !p.ans2) p.ans2 = "...";
        showVoting(code, p);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const p = rooms[code].pairs[rooms[code].currentPairIndex];
        if (p.p1.name === name) p.ans1 = answer;
        if (p.p2 && p.p2.name === name) p.ans2 = answer;
        if (p.ans1 && (!p.p2 || p.ans2)) { clearTimeout(timers[code]); showVoting(code, p); }
    });

    function showVoting(code, p) {
        io.to(code).emit('show-voting', { ans1: p.ans1, ans2: p.ans2, p1: p.p1.name, p2: p.p2 ? p.p2.name : null, time: 15 });
        if(!p.p2) setTimeout(() => next(code), 5000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        p.votes.push(voteNum);
        if (p.votes.length >= (r.players.length - (p.p2 ? 2 : 1))) next(code);
    });

    function next(code) {
        const r = rooms[code]; const p = r.pairs[r.currentPairIndex];
        if(p.finished) return; p.finished = true;
        let v1 = p.votes.filter(v=>v===1).length, v2 = p.votes.filter(v=>v===2).length;
        p.p1.score += v1*100; if(p.p2) p.p2.score += v2*100;
        io.to(code).emit('voting-results', { v1, v2 });
        setTimeout(() => { r.currentPairIndex++; sendPair(code); }, 5000);
    }
});
server.listen(process.env.PORT || 3000);
