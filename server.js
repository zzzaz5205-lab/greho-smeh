const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e7, cors: { origin: "*" } });

app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));

const prompts = ["Почему Ванга лысый?", "Секрет Димы Модерасса", "Худшая фраза хирурга"];
const rooms = {};

// ГЕОМЕТРИЧЕСКИЕ НАСТРОЙКИ
const shapes = ['cube', 'circle', 'poly'];
const colors = ['#FF5252', '#448AFF', '#4CAF50', '#FFEB3B', '#E040FB', '#FF9800', '#ec407a', '#26c6da'];

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { 
                host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false,
                settings: { timer: 30, voice: 'male' }
            };
        } else { rooms[code].host = socket.id; }
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');

        // Очистка от клонов
        room.players = room.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());

        const player = { 
            id: socket.id, 
            name: name, 
            shape: shapes[room.players.length % shapes.length], // Даем фигуру
            color: colors[room.players.length % colors.length], // Даем цвет
            score: 0 
        };
        room.players.push(player);

        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode }); // Шлем только строку кода!
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) {
            room.gameStarted = true;
            // Здесь будет логика раундов
            io.to(code).emit('round-started', { q: prompts[0], p1_name: room.players[0].name, p2_name: room.players[1].name });
        }
    });
});

server.listen(process.env.PORT || 3000);
