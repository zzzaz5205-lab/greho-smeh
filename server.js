const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

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
    "Что Дед Мороз делает летом на самом деле?"
];

function generateCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
    // Создание комнаты хостом
    socket.on('create-room', () => {
        const code = generateCode();
        rooms[code] = {
            host: socket.id,
            players: [],
            gameState: 'LOBBY',
            round: 0,
            pairs: [],
            answers: {},
            currentPairIndex: 0
        };
        socket.join(code);
        socket.emit('room-created', code);
    });

    // Вход игрока
    socket.on('join-room', ({ code, name }) => {
        const room = rooms[code];
        if (room && room.gameState === 'LOBBY') {
            const player = { id: socket.id, name, score: 0 };
            room.players.push(player);
            socket.join(code);
            socket.emit('joined-success', { name });
            io.to(room.host).emit('update-players', room.players);
        } else {
            socket.emit('error-msg', 'Комната не найдена или игра уже идет');
        }
    });

    // Начало игры
    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 3) {
            startRound(code);
        } else {
            socket.emit('error-msg', 'Нужно минимум 3 игрока');
        }
    });

    function startRound(code) {
        const room = rooms[code];
        room.round++;
        room.gameState = 'ANSWERING';
        room.answers = {};
        
        // Логика Quiplash: каждый игрок получает 2 вопроса, каждый вопрос делят 2 игрока
        // Упрощенная версия для примера: создаем цепочку пар
        room.pairs = [];
        const n = room.players.length;
        for (let i = 0; i < n; i++) {
            const q = questions[Math.floor(Math.random() * questions.length)];
            room.pairs.push({
                question: q,
                p1: room.players[i],
                p2: room.players[(i + 1) % n],
                results: []
            });
        }

        io.to(code).emit('round-started', { 
            round: room.round, 
            pairs: room.pairs.map(p => ({ question: p.question, p1: p.p1.id, p2: p.p2.id }))
        });
    }

    socket.on('submit-answer', ({ code, question, answer }) => {
        const room = rooms[code];
        if (!room.answers[question]) room.answers[question] = [];
        room.answers[question].push({ playerId: socket.id, text: answer });

        // Если все ответили на все вопросы
        const totalExpected = room.players.length * 2;
        let count = 0;
        Object.values(room.answers).forEach(a => count += a.length);

        if (count >= totalExpected) {
            showNextVotingPair(code);
        }
    });

    function showNextVotingPair(code) {
        const room = rooms[code];
        if (room.currentPairIndex < room.pairs.length) {
            const pair = room.pairs[room.currentPairIndex];
            const pairAnswers = room.answers[pair.question].filter(a => 
                a.playerId === pair.p1.id || a.playerId === pair.p2.id
            );
            
            room.gameState = 'VOTING';
            io.to(code).emit('start-voting', {
                question: pair.question,
                answers: pairAnswers,
                p1: pair.p1.id,
                p2: pair.p2.id
            });
            room.currentPairIndex++;
        } else {
            room.currentPairIndex = 0;
            io.to(code).emit('round-results', room.players);
            // Авто-старт следующего раунда или финал
            setTimeout(() => {
                if (room.round < 2) startRound(code);
                else io.to(code).emit('game-over', room.players);
            }, 7000);
        }
    }

    socket.on('cast-vote', ({ code, targetPlayerId }) => {
        const room = rooms[code];
        const player = room.players.find(p => p.id === targetPlayerId);
        if (player) player.score += 100;

        // Проверка завершения голосования (все кроме двоих участников)
        const roomVotes = room.pairs[room.currentPairIndex - 1].results;
        roomVotes.push(socket.id);
        
        if (roomVotes.length >= room.players.length - 2) {
            setTimeout(() => showNextVotingPair(code), 3000);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
