const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // Добавили системный модуль путей

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка: Сервер ищет файлы и в корне, и в папке public (на всякий случай)
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// ПРЯМОЙ МАРШРУТ: Если человек зашел по ссылке, принудительно шлем ему index.html
app.get('/', (req, res) => {
    // Сначала пробуем найти в корне, если нет — в папке public
    res.sendFile(path.join(__dirname, 'index.html'), (err) => {
        if (err) {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        }
    });
});

const questions = [
    "Самое странное название для туалетной бумаги?",
    "Что на самом деле шепчут кошки, когда мы спим?",
    "Лучший подарок для человека, у которого есть всё?",
    "Если бы у овощей была армия, кто был бы генералом?",
    "Девиз школы магии для ленивых.",
    "Худшая фраза, которую можно услышать от хирурга перед сном.",
    "Придумай название для очень плохого фильма ужасов.",
    "Что инопланетяне на самом деле думают о ТикТоке?",
    "Если бы чипсы умели кричать, какой бы это был звук?",
    "Самая бесполезная суперспособность — это возможность...",
    "Идеальное оправдание для опоздания на работу на 3 часа?",
    "Если бы ты открыл музей плохих привычек, какой бы там был главный экспонат?",
    "Название для рок-группы, состоящей из бухгалтеров.",
    "Что на самом деле находится внутри черных дыр?",
    "Странный ингредиент для пиццы, который станет хитом.",
    "Как называется болезнь, когда ты постоянно думаешь, что ты — тостер?",
    "Если бы собаки могли голосовать, за что бы они боролись?",
    "Худшее место для первого свидания?",
    "Придумай название для приложения, которое ничего не делает.",
    "Что Дед Мороз делает летом на самом деле?",
    "Самый глупый способ потратить миллиард долларов?",
    "Если бы у тебя был робот-слуга, какая была бы его первая поломка?",
    "Как звучит девиз города, в котором запрещены улыбки?",
    "Какой новый вид спорта нужно добавить в Олимпийские игры?",
    "Название для шоколадки со вкусом бекона и рыбы.",
    "Что ты скажешь, если встретишь самого себя из будущего?",
    "Почему у пингвинов нет коленей? (Твой вариант)",
    "Лучшая работа для ленивого привидения?",
    "Какое имя нельзя давать ребенку ни в коем случае?",
    "Если бы деревья могли ходить, куда бы они все пошли?"
];

const rooms = {};

io.on('connection', (socket) => {
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = { host: socket.id, players: [], spectators: [], gameStarted: false, pairs: [], currentPairIndex: 0, round: 1, bestAnswers: [] };
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name, emoji }) => {
        const room = rooms[code];
        if (room) {
            socket.join(code);
            if (room.gameStarted) {
                room.spectators.push({ id: socket.id, name });
                socket.emit('joined-spectator');
            } else {
                room.players.push({ id: socket.id, name, emoji, score: 0 });
                io.to(room.host).emit('player-joined', { name, emoji });
                socket.emit('joined-success');
            }
        }
    });

    socket.on('start-game', (code) => {
        if (rooms[code]) { 
            rooms[code].gameStarted = true; 
            setupRound(code, 1); 
        }
    });

    function setupRound(code, roundNum) {
        const room = rooms[code];
        if(!room) return;
        room.round = roundNum;
        room.currentPairIndex = 0;
        room.pairs = [];
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        for (let i = 0; i < shuffled.length; i += 2) {
            room.pairs.push({
                p1: shuffled[i], p2: shuffled[i+1] || null,
                q: questions[Math.floor(Math.random() * questions.length)],
                ans1: [], ans2: [], votes: []
            });
        }
        startNextPair(code);
    }

    function startNextPair(code) {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (!pair) {
            if (room.round < 3) setupRound(code, room.round + 1);
            else finishGame(code);
            return;
        }
        io.to(code).emit('round-started', { 
            round: room.round, 
            q: pair.q, 
            p1_id: pair.p1.id, 
            p2_id: pair.p2 ? pair.p2.id : null 
        });
    }

    socket.on('submit-answer', ({ code, name, answers }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.p1.name === name) pair.ans1 = answers;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = answers;
        if (pair.ans1.length > 0 && (!pair.p2 || pair.ans2.length > 0)) {
            if (!pair.p2) {
                pair.p1.score += 300;
                setTimeout(() => { room.currentPairIndex++; startNextPair(code); }, 2000);
            } else {
                io.to(code).emit('show-voting', { round: room.round, q: pair.q, ans1: pair.ans1, ans2: pair.ans2 });
            }
        }
    });

    socket.on('cast-vote', ({ code, voteNum, voterName }) => {
        const room = rooms[code];
        const pair = room.pairs[room.currentPairIndex];
        if (pair.votes.find(v => v.voter === voterName)) return;
        pair.votes.push({ voter: voterName, voteNum });
        if (pair.votes.length >= 1) { 
            const m = room.round * 100;
            let v1 = pair.votes.filter(v => v.voteNum === 1).length;
            let v2 = pair.votes.filter(v => v.voteNum === 2).length;
            pair.p1.score += v1 * m; pair.p2.score += v2 * m;
            room.bestAnswers.push({ text: pair.ans1.join(", "), author: pair.p1.emoji + " " + pair.p1.name, votes: v1 });
            room.bestAnswers.push({ text: pair.ans2.join(", "), author: pair.p2.emoji + " " + pair.p2.name, votes: v2 });
            io.to(code).emit('voting-results', { 
                p1_name: pair.p1.name, p1_emoji: pair.p1.emoji, 
                p2_name: pair.p2.name, p2_emoji: pair.p2.emoji, v1, v2 
            });
            setTimeout(() => { room.currentPairIndex++; startNextPair(code); }, 4000);
        }
    });

    function finishGame(code) {
        const room = rooms[code];
        room.players.sort((a, b) => b.score - a.score);
        room.bestAnswers.sort((a, b) => b.votes - a.votes);
        io.to(code).emit('final-results', { players: room.players, topAnswers: room.bestAnswers.slice(0, 5) });
    }

    socket.on('kick-all', (code) => {
        io.to(code).emit('go-to-menu');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Игра запущена на порту ${PORT}`); });
