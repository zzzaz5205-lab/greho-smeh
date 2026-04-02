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
app.get('/mod', (req, res) => res.sendFile(path.resolve(__dirname, 'mod.html')));

const rooms = {};
let timers = {};

async function getAIQuestion(isFinal = false) {
    try {
        const prompt = `Ты сценарист игры "Грехо-Смех". Придумай один ${isFinal ? "вопрос требующий 3 ответа" : "смешной вопрос"} на русском. Юмор: мемный, жесткий, Jackbox style. Без кавычек.`;
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) { return isFinal ? "3 причины не доверять Ванге" : "Почему Дима такой Дима?"; }
}

async function getAIComment(q, a1, a2) {
    try {
        const result = await aiModel.generateContent(`Вопрос: "${q}". Ответы: "${a1}" и "${a2}". Напиши 1 короткую едкую реакцию (5 слов).`);
        return result.response.text().trim();
    } catch (e) { return "Ну и кринж вы выдали!"; }
}

io.on('connection', (socket) => {
    socket.on('create-room', (oldCode) => {
        let code = (oldCode && rooms[oldCode]) ? oldCode : Math.random().toString(36).substring(2, 6).toUpperCase();
        if (!rooms[code]) {
            rooms[code] = { host: socket.id, players: [], round: 1, currentPairIndex: 0, pairs: [], gameStarted: false, settings: { timer: 30, voice: 'male' } };
        } else rooms[code].host = socket.id;
        socket.join(code);
        socket.emit('room-created', code);
    });

    socket.on('join-room', ({ code, name }) => {
        const cleanCode = code?.trim().toUpperCase();
        const room = rooms[cleanCode];
        if (!room) return socket.emit('error-join', 'Комната не найдена!');
        
        room.players = room.players.filter(p => p.name.toLowerCase() !== name.toLowerCase());
        const chars = ['red-angry', 'orange-evil', 'blue-sad', 'green-derpy', 'purple-smug'];
        const player = { id: socket.id, name, char: chars[room.players.length % chars.length], score: 0, lastPoints: 0 };
        room.players.push(player);
        
        socket.join(cleanCode);
        socket.emit('joined-success', { code: cleanCode, char: player.char });
        io.to(room.host).emit('player-list-update', room.players);
    });

    socket.on('start-game', (code) => {
        const room = rooms[code];
        if (room && room.players.length >= 2) { room.gameStarted = true; startRound(code, 1); }
    });

    async function startRound(code, roundNum) {
        const room = rooms[code];
        room.round = roundNum; room.currentPairIndex = 0;
        let shuffled = [...room.players].sort(() => 0.5 - Math.random());
        room.pairs = [];
        
        // В 3 раунде 1 общий вопрос, в 1-2 раундах - пары
        const isFinal = roundNum === 3;
        const count = isFinal ? 1 : shuffled.length;

        for (let i = 0; i < count; i++) {
            const q = await getAIQuestion(isFinal);
            room.pairs.push({ 
                p1: shuffled[i], p2: shuffled[(i+1)%shuffled.length], 
                q, ans1: null, ans2: null, votes: [], finished: false, isFinal 
            });
        }
        sendPair(code);
    }

    function sendPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (!pair) return io.to(code).emit('show-scores', { players: room.players, round: room.round });
        
        io.to(code).emit('round-started', { round: room.round, q: pair.q, p1_name: pair.p1?.name, p2_name: pair.p2?.name, settings: room.settings });
        
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => forceSubmit(code), (room.settings.timer + 2) * 1000);
    }

    function forceSubmit(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if(pair.finished) return;
        if(!pair.ans1) pair.ans1 = "Я тупил 30 секунд..."; 
        if(!pair.ans2) pair.ans2 = "Я тоже...";
        showVoting(code, pair);
    }

    socket.on('submit-answer', ({ code, name, answer }) => {
        const room = rooms[code]; const pair = room?.pairs[room.currentPairIndex];
        const txt = Array.isArray(answer) ? answer.filter(x => x).join(' | ') : answer;
        if (pair.p1.name === name) pair.ans1 = txt;
        if (pair.p2 && pair.p2.name === name) pair.ans2 = txt;
        if (pair.ans1 && (!pair.p2 || pair.ans2)) { clearTimeout(timers[code]); showVoting(code, pair); }
    });

    function showVoting(code, pair) {
        io.to(code).emit('show-voting', { ans1: pair.ans1, ans2: pair.ans2, isSolo: !pair.p2, p1_name: pair.p1.name, p2_name: pair.p2?.name });
        if(timers[code]) clearTimeout(timers[code]);
        timers[code] = setTimeout(() => finishPair(code), 22000);
    }

    socket.on('cast-vote', ({ code, voteNum }) => {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (pair.finished) return;
        pair.votes.push({ voter: socket.id, voteNum });
        if (pair.votes.length >= (room.players.length - (pair.p2 ? 2 : 1))) { clearTimeout(timers[code]); finishPair(code); }
    });

    async function finishPair(code) {
        const room = rooms[code]; const pair = room.pairs[room.currentPairIndex];
        if (pair.finished) return; pair.finished = true;
        let v1 = pair.votes.filter(v => v.voteNum === 1).length;
        let v2 = pair.votes.filter(v => v.voteNum === 2).length;
        let mult = (room.round === 3) ? 200 : 100;
        pair.p1.score += v1 * mult; if(pair.p2) pair.p2.score += v2 * mult;
        
        const comment = await getAIComment(pair.q, pair.ans1, pair.ans2 || "");
        io.to(code).emit('voting-results', { p1: pair.p1, p2: pair.p2, v1, v2, aiComment: comment });
        
        setTimeout(() => { if (rooms[code]) { rooms[code].currentPairIndex++; sendPair(code); } }, 8000);
    }

    socket.on('next-after-scores', (code) => {
        if (rooms[code].round < 3) startRound(code, rooms[code].round + 1);
        else io.to(code).emit('final-results', { players: rooms[code].players.sort((a,b)=>b.score-a.score) });
    });
});
server.listen(process.env.PORT || 3000);
