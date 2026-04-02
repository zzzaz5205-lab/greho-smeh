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

const prompts = {
    ru: {
        classic: ["Почему Ванга лысый?", "Секретное оружие Димы Модерасса", "Худшее название для соков", "Что скрывает перфоратор?"],
        final: ["3 вещи, которые нельзя делать в прямом эфире", "3 причины не ходить на свидание с ИИ"]
    }
};

const rooms = {};
let timers = {};

async function getAIQuestion(isFinal = false) {
    try {
        const prompt = `Придумай ОДИН ${isFinal ? "вопрос на 3 ответа" : "смешной вопрос"} для игры Quiplash на русском. Стиль: абсурдный, дерзкий. Без лишних знаков.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) { return "Почему лысые люди такие подозрительные?"; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { 
                host: socket.id, players: [], round: 1, currentPairIndex: 0, 
                pairs: [], gameStarted: false, settings: { timer: 30, voice: 'male', bonusX2: true }
            };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const c = code?.trim().toUpperCase();
        const r = rooms[c];
        if (!r) return socket.emit('error-join', 'Комната не найдена!');
        
        r.players = r.players.filter(p => p.name !== name);
        const player = { id: socket.id, name, emoji: '🤡', score: 0, lastPoints: 0, answers: [] };
        r.players.push(player);
        
        socket.join(c);
        socket.emit('joined-success', { code: c, settings: r.settings });
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
        
        if (roundNum < 3) {
            // Раунды 1 и 2: Игроки делятся на пары (A-B, B-C, C-A)
            for (let i = 0; i < r.players.length; i++) {
                let p1 = r.players[i];
                let p2 = r.players[(i + 1) % r.players.length];
                let q = await getAIQuestion(false);
                r.pairs.push({ p1, p2, q, ans1: null, ans2: null, votes: [], finished: false });
            }
        } else {
            // Финальный раунд: Все на один вопрос
            let q = await getAIQuestion(true);
            r.pairs.push({ isFinal: true, q, allAnswers: [], finished: false });
        }
        sendRoundData(code);
    }

    function sendRoundData(code) {
        const r = rooms[code];
        io.to(code).emit('round-started', { round: r.round, settings: r.settings, pairs: r.pairs });
        
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (r.settings.timer + 2) * 1000);
    }

    function forceSubmit(code) {
        const r = rooms[code];
        if(!r || r.pairs[r.currentPairIndex].finished) return;
        io.to(code).emit('show-voting', { pair: r.pairs[r.currentPairIndex], round: r.round });
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code];
        r.players.find(p => p.name === name).answers = answer;
        // Логика проверки готовности всех игроков...
        // Для краткости: если все ответили, шлем show-voting
        io.to(code).emit('show-voting', { pair: r.pairs[0], round: r.round });
    });

    socket.on('cast-vote', ({ code, voteId }) => {
        // Начисление очков...
    });
});

server.listen(process.env.PORT || 3000);
