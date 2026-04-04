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
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.resolve(__dirname, 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.resolve(__dirname, 'player.html')));

const prompts = [
    "Почему vangavgav лысый?", "Что Ванга скрывает под кепкой?", "За что Дима Moderass любит Вангу?",
    "Худшая фраза хирурга перед операцией.", "Почему у пингвинов нет коленей?", "Странное название для туалетной бумаги."
];

const rooms = {};

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], gameStarted: false };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        
        room.players = room.players.filter(p => p.name !== name);
        const player = { 
            id: socket.id, 
            name, 
            char: { shape: 'cube', color: '#777', active: false }, 
            score: 0 
        };
        room.players.push(player);
        
        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode });
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('select-char', ({ code, name, char }) => {
        const room = rooms[code];
        const p = room?.players.find(pl => pl.name === name);
        if (p) { 
            p.char = { ...char, active: true }; 
            io.to(room.host).emit('player-list-update', room.players);
            socket.emit('char-confirmed');
        }
    });

    socket.on('start-game', (code) => {
        const r = rooms[code];
        if (r && r.players.length >= 2) {
            r.gameStarted = true;
            io.to(code).emit('round-started', { q: prompts[Math.floor(Math.random()*prompts.length)], p1_name: r.players[0].name, p2_name: r.players[1].name });
        }
    });

    socket.on('submit-answer', ({ code, name, answer }) => {
        io.to(code).emit('show-voting', { ans1: answer, ans2: "Второй игрок думает...", p1_name: name });
    });
});

server.listen(process.env.PORT || 3000);
