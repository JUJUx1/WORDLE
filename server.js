const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ─── Word Bank ───────────────────────────────────────────────────────────────
let wordsByLength = {};

async function loadWords() {
  // Set WORDS_URL env var to your raw GitHub words.txt URL
  const url = process.env.WORDS_URL ||
    'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const words = text
      .split(/\r?\n/)
      .map(w => w.trim().toLowerCase())
      .filter(w => /^[a-z]{2,}$/.test(w));

    wordsByLength = {};
    for (const word of words) {
      const len = word.length;
      if (!wordsByLength[len]) wordsByLength[len] = [];
      wordsByLength[len].push(word);
    }
    const summary = Object.entries(wordsByLength)
      .sort((a, b) => a[0] - b[0])
      .map(([k, v]) => `${k}L:${v.length}`)
      .join(', ');
    console.log(`✓ Words loaded — ${summary}`);
  } catch (e) {
    console.error('⚠ Could not fetch words.txt, using fallback:', e.message);
    wordsByLength = {
      3: ['cat','dog','sun','run','hat','map','joy','fly','sky','hot'],
      4: ['word','game','play','find','dark','gold','time','bird','fire','wind'],
      5: ['crane','slate','brave','flame','ghost','pride','swift','truth','crypt','gloom'],
      6: ['planet','silver','glitch','flower','candle','friend','bridge','castle','mirror','basket'],
      7: ['surface','hundred','captain','diamond','mission','blanket','silence','chapter','monster','flutter'],
      8: ['complete','together','children','mountain','struggle','platform','absolute','calendar','hospital','language'],
      9: ['beautiful','challenge','important','adventure','knowledge','carefully','wonderful','developed','something','different'],
    };
  }
}

loadWords();

// ─── Room Management ─────────────────────────────────────────────────────────
const rooms = {};           // roomCode → roomObj
const publicQueues = {};    // wordLength → roomCode (open public room)

function generateCode(len = 6) {
  return Math.random().toString(36).substr(2, len).toUpperCase();
}

function getRandomWord(length) {
  const list = wordsByLength[length];
  if (!list || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function checkGuess(guess, word) {
  const result = new Array(word.length).fill('absent');
  const wordChars = word.split('');
  const used = new Array(word.length).fill(false);

  // Pass 1: exact matches
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === wordChars[i]) {
      result[i] = 'correct';
      used[i] = true;
    }
  }
  // Pass 2: present but wrong position
  for (let i = 0; i < guess.length; i++) {
    if (result[i] === 'correct') continue;
    for (let j = 0; j < word.length; j++) {
      if (!used[j] && guess[i] === wordChars[j]) {
        result[i] = 'present';
        used[j] = true;
        break;
      }
    }
  }
  return result;
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    type: room.type,
    wordLength: room.wordLength,
    maxPlayers: room.maxPlayers === Infinity ? 0 : room.maxPlayers,
    gameState: room.gameState,
    playerCount: room.players.length,
    countdown: room.countdown ?? null
  };
}

function playerList(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    attempts: p.attempts,
    solved: p.solved,
    finished: p.finished
  }));
}

function startGame(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.gameState !== 'waiting') return;

  const word = getRandomWord(room.wordLength);
  if (!word) {
    io.to(roomCode).emit('roomError', `No ${room.wordLength}-letter words available. Try another length.`);
    return;
  }

  room.word = word;
  room.gameState = 'playing';
  room.startedAt = Date.now();

  // Remove from public queue if applicable
  if (room.type === 'public' && publicQueues[room.wordLength] === roomCode) {
    delete publicQueues[room.wordLength];
  }

  // Clear any countdown timer
  if (room._countdownInterval) {
    clearInterval(room._countdownInterval);
    delete room._countdownInterval;
  }

  io.to(roomCode).emit('gameStart', { wordLength: room.wordLength });
  console.log(`[${roomCode}] Game started — word: "${word}" (${room.wordLength}L)`);
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.gameState = 'finished';

  const results = room.players
    .map(p => ({
      id: p.id,
      name: p.name,
      solved: p.solved,
      attempts: p.attempts,
      guesses: p.guesses
    }))
    .sort((a, b) => {
      if (a.solved !== b.solved) return b.solved - a.solved;
      return a.attempts - b.attempts;
    });

  io.to(roomCode).emit('gameEnd', { results, word: room.word });
  console.log(`[${roomCode}] Game ended — word: "${room.word}"`);

  // Clean up room after 2 minutes
  setTimeout(() => { delete rooms[roomCode]; }, 120000);
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Singleplayer ──
  socket.on('getWord', ({ wordLength }) => {
    const len = parseInt(wordLength, 10);
    const word = getRandomWord(len);
    if (!word) {
      socket.emit('roomError', `No ${len}-letter words available.`);
      return;
    }
    socket.emit('wordAssigned', { word });
  });

  socket.on('validateGuess', ({ guess, wordLength }) => {
    const len = parseInt(wordLength, 10);
    guess = guess.toLowerCase().trim();
    const list = wordsByLength[len] || [];
    if (!list.includes(guess)) {
      socket.emit('invalidWord');
    } else {
      socket.emit('wordValid');
    }
  });

  // ── Public Room ──
  socket.on('joinPublicRoom', ({ wordLength, playerName }) => {
    const len = parseInt(wordLength, 10);
    let roomCode = publicQueues[len];
    let room = roomCode ? rooms[roomCode] : null;

    if (!room || room.gameState !== 'waiting') {
      roomCode = generateCode();
      rooms[roomCode] = {
        code: roomCode,
        type: 'public',
        wordLength: len,
        maxPlayers: Infinity,
        players: [],
        word: null,
        gameState: 'waiting',
        host: socket.id,
        countdown: 30
      };
      publicQueues[len] = roomCode;
    }
    room = rooms[roomCode];

    // Don't allow re-joining
    if (room.players.find(p => p.id === socket.id)) return;

    room.players.push({
      id: socket.id,
      name: (playerName || `Player${room.players.length + 1}`).slice(0, 20),
      guesses: [],
      solved: false,
      attempts: 0,
      finished: false
    });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    socket.emit('roomJoined', {
      roomCode,
      room: sanitizeRoom(room),
      isHost: room.host === socket.id,
      myId: socket.id
    });
    io.to(roomCode).emit('playerList', playerList(room));

    // Start or refresh countdown
    if (!room._countdownInterval) {
      room.countdown = 30;
      room._countdownInterval = setInterval(() => {
        if (!rooms[roomCode] || rooms[roomCode].gameState !== 'waiting') {
          clearInterval(room._countdownInterval);
          return;
        }
        room.countdown--;
        io.to(roomCode).emit('countdown', room.countdown);
        if (room.countdown <= 0) {
          clearInterval(room._countdownInterval);
          startGame(roomCode);
        }
      }, 1000);
    }
  });

  // ── Private Room ──
  socket.on('createPrivateRoom', ({ wordLength, maxPlayers, playerName }) => {
    const len = parseInt(wordLength, 10);
    const max = parseInt(maxPlayers, 10) || 8;
    const roomCode = generateCode();

    rooms[roomCode] = {
      code: roomCode,
      type: 'private',
      wordLength: len,
      maxPlayers: max,
      players: [],
      word: null,
      gameState: 'waiting',
      host: socket.id
    };

    const room = rooms[roomCode];
    room.players.push({
      id: socket.id,
      name: (playerName || 'Host').slice(0, 20),
      guesses: [],
      solved: false,
      attempts: 0,
      finished: false
    });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    socket.emit('roomJoined', {
      roomCode,
      room: sanitizeRoom(room),
      isHost: true,
      myId: socket.id
    });
    io.to(roomCode).emit('playerList', playerList(room));
    console.log(`[${roomCode}] Private room created by ${socket.id} — ${len}L, max ${max}`);
  });

  socket.on('joinPrivateRoom', ({ roomCode, playerName }) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms[code];
    if (!room) { socket.emit('roomError', 'Room not found.'); return; }
    if (room.gameState !== 'waiting') { socket.emit('roomError', 'Game already in progress.'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('roomError', 'Room is full.'); return; }
    if (room.players.find(p => p.id === socket.id)) return;

    room.players.push({
      id: socket.id,
      name: (playerName || `Player${room.players.length + 1}`).slice(0, 20),
      guesses: [],
      solved: false,
      attempts: 0,
      finished: false
    });

    socket.join(code);
    socket.data.roomCode = code;

    socket.emit('roomJoined', {
      roomCode: code,
      room: sanitizeRoom(room),
      isHost: false,
      myId: socket.id
    });
    io.to(code).emit('playerList', playerList(room));
  });

  // ── Host: start game ──
  socket.on('startGame', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    if (room.host !== socket.id) { socket.emit('roomError', 'Only the host can start.'); return; }
    startGame(code);
  });

  // ── Multiplayer guess ──
  socket.on('guess', ({ guess }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.gameState !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.finished) return;

    guess = (guess || '').toLowerCase().trim();
    if (guess.length !== room.wordLength) { socket.emit('roomError', 'Wrong word length.'); return; }

    const list = wordsByLength[room.wordLength] || [];
    if (!list.includes(guess)) { socket.emit('invalidWord'); return; }

    const result = checkGuess(guess, room.word);
    const solved = result.every(r => r === 'correct');
    player.guesses.push({ guess, result });
    player.attempts++;

    if (solved) {
      player.solved = true;
      player.finished = true;
    } else if (player.attempts >= 6) {
      player.finished = true;
    }

    socket.emit('guessResult', {
      guess,
      result,
      solved,
      attempts: player.attempts,
      finished: player.finished,
      word: player.finished && !solved ? room.word : null
    });

    io.to(code).emit('playerUpdate', {
      id: socket.id,
      name: player.name,
      attempts: player.attempts,
      solved: player.solved,
      finished: player.finished
    });

    if (room.players.every(p => p.finished)) {
      endGame(code);
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    room.players = room.players.filter(p => p.id !== socket.id);
    console.log(`[-] ${socket.id} left [${code}]`);

    if (room.players.length === 0) {
      if (room._countdownInterval) clearInterval(room._countdownInterval);
      if (room.type === 'public' && publicQueues[room.wordLength] === code) {
        delete publicQueues[room.wordLength];
      }
      delete rooms[code];
      return;
    }

    if (room.host === socket.id) {
      room.host = room.players[0].id;
      io.to(code).emit('newHost', room.host);
    }

    io.to(code).emit('playerList', playerList(room));

    // If game ongoing and all remaining players finished
    if (room.gameState === 'playing' && room.players.every(p => p.finished)) {
      endGame(code);
    }
  });

  // ── Utility ──
  socket.on('getAvailableLengths', () => {
    const lengths = Object.keys(wordsByLength)
      .map(Number)
      .filter(n => n >= 3 && n <= 9)
      .sort((a, b) => a - b);
    socket.emit('availableLengths', lengths);
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Worduel server running ✓'));
app.get('/health', (req, res) => {
  const lengths = Object.keys(wordsByLength).map(Number).sort((a, b) => a - b);
  res.json({ status: 'ok', wordLengths: lengths, rooms: Object.keys(rooms).length });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Worduel server listening on :${PORT}`));
