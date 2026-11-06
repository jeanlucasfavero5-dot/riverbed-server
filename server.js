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

// Lista dos 5 jogos suportados no servidor
const SUPPORTED_GAMES = [
  'gravitas-arena',
  'zombie-house',
  'pulse-fighter',
  'riverbed-warfare',
  'supercar-circuit'
];

// Filas de espera para partida rápida (Matchmaking automático)
const matchQueues = {
  'gravitas-arena': [],
  'zombie-house': [],
  'pulse-fighter': [],
  'riverbed-warfare': [],
  'supercar-circuit': []
};

// Estrutura para armazenar salas ativas e jogadores
const gameRooms = {
  'gravitas-arena': {},
  'zombie-house': {},
  'pulse-fighter': {},
  'riverbed-warfare': {},
  'supercar-circuit': {}
};

app.get('/', (req, res) => {
  res.send({ status: 'Online', games: SUPPORTED_GAMES });
});

io.on('connection', (socket) => {
  console.log(`[Socket] Conectado: ${socket.id}`);

  // 1. MATCHMAKING AUTOMÁTICO (Procura 4 jogadores aleatórios)
  socket.on('find_match', ({ gameId, playerName }) => {
    if (!SUPPORTED_GAMES.includes(gameId)) {
      socket.emit('error_message', 'Jogo não reconhecido.');
      return;
    }

    socket.gameId = gameId;
    socket.playerName = playerName || 'Jogador';

    // Adiciona o jogador na fila do jogo correspondente
    matchQueues[gameId].push(socket);
    console.log(`[Matchmaking] ${socket.playerName} entrou na fila de ${gameId}. Total na fila: ${matchQueues[gameId].length}`);

    // Avisa o cliente que está procurando
    socket.emit('waiting_for_match', { message: 'Procurando oponentes...' });

    // Se a fila atingir 4 jogadores, cria uma sala automática para eles
    if (matchQueues[gameId].length >= 4) {
      const roomPlayers = matchQueues[gameId].splice(0, 4); // Pega exatamente 4 jogadores
      const roomId = `auto_${Date.now()}`; // Cria um ID único para a sala

      gameRooms[gameId][roomId] = {};

      roomPlayers.forEach((playerSocket) => {
        playerSocket.roomId = roomId;
        const fullRoomId = `${gameId}_${roomId}`;
        playerSocket.join(fullRoomId);

        gameRooms[gameId][roomId][playerSocket.id] = {
          id: playerSocket.id,
          name: playerSocket.playerName
        };
      });

      // Notifica os 4 jogadores que a partida foi encontrada e a sala foi criada
      io.to(`${gameId}_${roomId}`).emit('match_found', {
        roomId: roomId,
        players: gameRooms[gameId][roomId]
      });

      console.log(`[Matchmaking] Partida iniciada no jogo ${gameId} | Sala: ${roomId} com 4 jogadores.`);
    }
  });

  // 2. Cancelar busca na fila se o jogador sair do menu de busca
  socket.on('cancel_matchmaking', () => {
    if (socket.gameId && matchQueues[socket.gameId]) {
      matchQueues[socket.gameId] = matchQueues[socket.gameId].filter(s => s.id !== socket.id);
      console.log(`[Matchmaking] ${socket.playerName} saiu da fila.`);
    }
  });

  // 3. Entrar em sala manual por código (para jogar com amigos)
  socket.on('join_room', ({ gameId, roomId, playerName }) => {
    if (!SUPPORTED_GAMES.includes(gameId)) return;

    socket.gameId = gameId;
    socket.roomId = roomId;
    socket.playerName = playerName || 'Jogador';

    const fullRoomId = `${gameId}_${roomId}`;
    socket.join(fullRoomId);

    if (!gameRooms[gameId][roomId]) {
      gameRooms[gameId][roomId] = {};
    }

    gameRooms[gameId][roomId][socket.id] = {
      id: socket.id,
      name: socket.playerName
    };

    io.to(fullRoomId).emit('player_joined', {
      players: gameRooms[gameId][roomId],
      newPlayer: socket.id
    });
  });

  // 4. Ações de jogo em tempo real (movimentos, ataques, etc.)
  socket.on('game_action', (data) => {
    if (socket.gameId && socket.roomId) {
      const fullRoomId = `${socket.gameId}_${socket.roomId}`;
      socket.to(fullRoomId).emit('game_action', {
        playerId: socket.id,
        action: data
      });
    }
  });

  // 5. Desconexão
  socket.on('disconnect', () => {
    console.log(`[Socket] Desconectado: ${socket.id}`);
    
    // Remove da fila se estiver procurando partida
    if (socket.gameId && matchQueues[socket.gameId]) {
      matchQueues[socket.gameId] = matchQueues[socket.gameId].filter(s => s.id !== socket.id);
    }

    // Remove da sala ativa se estiver em jogo
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
