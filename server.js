const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// База оригинальных вопросов
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

// Простая фильтрация (заглушка)
const filterText = (text) => {
    const forbidden = ['мат1', 'мат2']; // Добавьте список слов
    let filtered = text;
    forbidden.forEach(word => {
        const reg = new RegExp(word, 'gi');
        filtered = filtered.replace(reg, '***');
    });
    return filtered;
};

// Заглушка для ИИ
const getAIQuestion = async () => {
    return new Promise((res) => {
        setTimeout(() => res("Бонусный вопрос от ИИ: О чем думает кирпич?"), 500);
    });
};

io.on('connection', (socket) => {
    // Создание комнаты
    socket.on('create-room', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[code] = {
            host: socket.id,
            players: [],
            gameState: 'LOBBY',
            round: 0,
            answers: {},
            votes: []
        };
        socket.join(code);
        socket.emit('room-created', code);
    });

    // Присоединение игрока
    socket.on('join-room', ({ code, name }) => {
        const room = rooms[code];
        if (room && room.gameState === 'LOBBY') {
            const player = { id: socket.id, name, score: 0 };
            room.players.push(player);
            socket.join(code);
            socket.emit('joined-success');
            io.to(room.host).emit('player-update', room.players);
        } else {
            socket.emit('error', 'Комната не найдена или игра уже началась');
        }
    });

    // Старт игры
    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) { // Для теста 2, просили 3
            nextRound(code);
        }
    });

    function nextRound(code) {
        const room = rooms[code];
        room.round++;
        room.gameState = 'ANSWERING';
        room.answers = {};
        room.votes = [];
        
        const question = questions[Math.floor(Math.random() * questions.length)];
        io.to(code).emit('round-start', { question, round: room.round });
    }

    // Получение ответа
    socket.on('submit-answer', ({ code, answer }) => {
        const room = rooms[code];
        if (room && room.gameState === 'ANSWERING') {
            room.answers[socket.id] = filterText(answer);
            
            if (Object.keys(room.answers).length === room.players.length) {
                room.gameState = 'VOTING';
                const answersList = room.players.map(p => ({
                    playerId: p.id,
                    text: room.answers[p.id]
                }));
                io.to(code).emit('start-voting', answersList);
            }
        }
    });

    // Голосование
    socket.on('cast-vote', ({ code, targetId }) => {
        const room = rooms[code];
        if (room && room.gameState === 'VOTING') {
            room.votes.push({ voter: socket.id, target: targetId });
            
            if (room.votes.length === room.players.length) {
                // Считаем очки
                room.votes.forEach(v => {
                    const player = room.players.find(p => p.id === v.target);
                    if (player) player.score += 100;
                });
                
                room.gameState = 'RESULTS';
                io.to(code).emit('results', room.players);
                
                // Через 5 секунд следующий раунд или финал
                setTimeout(() => {
                    if (room.round < 3) nextRound(code);
                    else {
                        room.gameState = 'FINAL';
                        io.to(code).emit('final-scores', room.players);
                    }
                }, 5000);
            }
        }
    });

    socket.on('disconnect', () => {
        // Здесь можно добавить логику удаления игроков из комнат
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
