const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Lista dos jogos suportados no servidor
const SUPPORTED_GAMES = [
  'gravitas-arena',
  'zombie-house',
  'pulse-fighter',
  'riverbed-warfare',
  'supercar-circuit'
];

// Estrutura para armazenar salas e jogadores de cada jogo
const gameRooms = {
  'gravitas-arena': {},
  'zombie-house': {},
  'pulse-fighter': {},
  'riverbed-warfare': {},
  'supercar-circuit': {}
};

// Rota para checar status do servidor
app.get('/', (req, res) => {
  res.send({ status: 'Online', games: SUPPORTED_GAMES });
});

io.on('connection', (socket) => {
  console.log(`[Socket] Conectado: ${socket.id}`);

  // Evento para o cliente registrar/entrar em um jogo específico
  socket.on('join_game', ({ gameId, roomId, playerName }) => {
    if (!SUPPORTED_GAMES.includes(gameId)) {
      socket.emit('error_message', 'Jogo não reconhecido no servidor.');
      return;
    }

    socket.gameId = gameId;
    socket.roomId = roomId || 'default';
    socket.playerName = playerName || 'Jogador';

    const fullRoomId = `${gameId}_${socket.roomId}`;
    socket.join(fullRoomId);

    if (!gameRooms[gameId][socket.roomId]) {
      gameRooms[gameId][socket.roomId] = {};
    }

    gameRooms[gameId][socket.roomId][socket.id] = {
      id: socket.id,
      name: socket.playerName,
      joinedAt: Date.now()
    };

    console.log(`[${gameId}] ${socket.playerName} entra na sala ${socket.roomId}`);

    // Notifica todos na sala que o jogador entrou
    io.to(fullRoomId).emit('player_joined', {
      players: gameRooms[gameId][socket.roomId],
      newPlayer: socket.id
    });
  });

  // Evento genérico para envio/sincronização de dados de jogo
  socket.on('game_action', (data) => {
    if (socket.gameId && socket.roomId) {
      const fullRoomId = `${socket.gameId}_${socket.roomId}`;
      socket.to(fullRoomId).emit('game_action', {
        playerId: socket.id,
        action: data
      });
    }
  });

  // Desconexão do jogador
  socket.on('disconnect', () => {
    console.log(`[Socket] Desconectado: ${socket.id}`);
    if (socket.gameId && socket.roomId && gameRooms[socket.gameId]?.[socket.roomId]) {
      delete gameRooms[socket.gameId][socket.roomId][socket.id];
      const fullRoomId = `${socket.gameId}_${socket.roomId}`;
      io.to(fullRoomId).emit('player_left', { playerId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
