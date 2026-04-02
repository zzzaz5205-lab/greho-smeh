const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const questions = [
    "Самое странное название для туалетной бумаги?",
    "Что на самом деле шепчут кошки, когда мы спят?",
    "Лучший подарок для человека, у которого есть всё?",
    "Если бы у овощей была армия, кто был бы генералом?",
    "Почему vangavgav лысый?",
    "Придумай название для очень плохого фильма ужасов."
];

const rooms = {};

io.on('connection', (socket) => {
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { host: socket.id, players: [], round: 1, pairs: [], gameStarted: false };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const r = rooms[code?.toUpperCase()];
        if (r && !r.gameStarted) {
            const player = { 
                id: socket.id, 
                name, 
                score: 0, 
                color: `hsl(${Math.random() * 360}, 70%, 60%)`,
                shape: ['circle', 'square', 'triangle', 'pentagon'][Math.floor(Math.random() * 4)]
            };
            r.players.push(player);
            socket.join(code.toUpperCase());
            io.to(r.host).emit('player-joined', r.players);
            socket.emit('joined-success', player);
        }
    });

    socket.on('start-game', (code) => {
        const r = rooms[code];
        if (r && r.players.length >= 2) {
            r.gameStarted = true;
            startNewRound(code);
        }
    });

    function startNewRound(code) {
        const r = rooms[code];
        r.pairs = [];
        let shuffled = [...r.players].sort(() => 0.5 - Math.random());
        
        // Создаем пары (кто с кем соревнуется)
        for (let i = 0; i < shuffled.length; i++) {
            let p1 = shuffled[i];
            let p2 = shuffled[(i + 1) % shuffled.length];
            r.pairs.push({
                q: questions[Math.floor(Math.random() * questions.length)],
                p1, p2, ans1: null, ans2: null, votes: []
            });
        }
        io.to(code).emit('round-started', { round: r.round, pairs: r.pairs });
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const r = rooms[code];
        r.pairs.forEach(pair => {
            if (pair.p1.name === name) pair.ans1 = answer;
            if (pair.p2.name === name) pair.ans2 = answer;
        });
        
        // Проверяем, все ли ответили
        const allDone = r.pairs.every(p => p.ans1 && p.ans2);
        if (allDone) {
            io.to(code).emit('start-voting', r.pairs[0]);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
