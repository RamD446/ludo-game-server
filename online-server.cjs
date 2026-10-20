const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT ?? 3001);
const MATCHMAKING_TIMEOUT_MS = 5000;
const CHAT_COOLDOWN_MS = 1000;
const CHAT_PRESET_COUNTS = { message: 6, emoji: 8 };
const names = JSON.parse(fs.readFileSync(path.join(__dirname, 'player-names.json'), 'utf8'));
const rooms = new Map();
const guests = new Map();
const invitations = new Map();
const joinRequests = new Map();
const guestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = {
  LOCAL_2: { capacity: 2, colors: ['red', 'yellow'] },
  LOCAL_3: { capacity: 3, colors: ['red', 'green', 'yellow'] },
  LOCAL_4: { capacity: 4, colors: ['red', 'green', 'yellow', 'blue'] },
  TEAM_2V2: { capacity: 4, colors: ['red', 'green', 'yellow', 'blue'] }
};

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ online: true, rooms: rooms.size }));
    return;
  }
  response.writeHead(404);
  response.end('Not found');
});

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

function randomName(room) {
  const occupied = new Set(room.players.map(player => player.name));
  for (let attempt = 0; attempt < 30; attempt++) {
    const name = names[Math.floor(Math.random() * names.length)];
    if (!occupied.has(name)) return name;
  }
  return `Player ${Math.floor(Math.random() * 100000)}`;
}

function createCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    capacity: room.capacity,
    tokensPerPlayer: room.tokensPerPlayer,
    status: room.status,
    matchmaking: room.matchmaking,
    hostPlayerId: room.hostPlayerId,
    players: room.players.map(({ socketId, ...player }) => ({ ...player, connected: Boolean(socketId) })),
    game: room.game
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:state', publicRoom(room));
}

function publicInvitation(invitation) {
  const room = rooms.get(invitation.code);
  return { id: invitation.id, code: invitation.code, hostName: room?.players[0]?.name ?? 'Host', mode: room?.mode };
}

function removeInvitation(invitation) {
  invitations.delete(invitation.id);
  const target = guests.get(invitation.guestId);
  if (target) io.to(target).emit('invite:removed', invitation.id);
}

function removeRequest(request, reason) {
  joinRequests.delete(request.id);
  const requester = io.sockets.sockets.get(request.socketId);
  if (requester) {
    requester.data.pendingRequestId = null;
    requester.emit('room:decision', { id: request.id, accepted: false, error: reason });
  }
  const room = rooms.get(request.code);
  if (room?.hostSocketId) io.to(room.hostSocketId).emit('room:request-removed', request.id);
}

function closePending(room, reason) {
  for (const request of [...joinRequests.values()]) {
    if (request.code === room.code) removeRequest(request, reason);
  }
  for (const invitation of [...invitations.values()]) {
    if (invitation.code === room.code) removeInvitation(invitation);
  }
}

function addPlayer(room, socket, requestedName, requestedColor) {
  const availableColors = room.colors.filter(color => !room.players.some(player => player.color === color));
  const color = requestedColor ? availableColors.includes(requestedColor) ? requestedColor : null : availableColors[0];
  if (!color) return null;
  const index = room.players.length;
  const requestedDisplayName = typeof requestedName === 'string' ? requestedName.trim().slice(0, 20) : '';
  const name = requestedDisplayName && !room.players.some(player => player.name === requestedDisplayName)
    ? requestedDisplayName
    : randomName(room);
  const player = {
    id: randomUUID(),
    name,
    color,
    tokens: [],
    isAI: false,
    connected: true,
    socketId: socket.id,
    teamId: room.mode === 'TEAM_2V2' ? (color === 'red' || color === 'yellow' ? 'A' : 'B') : undefined
  };
  room.players.push(player);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  return player;
}

function startWhenFull(room) {
  if (room.status !== 'waiting' || room.players.length < room.capacity) return;
  if (room.matchmakingTimer) {
    clearTimeout(room.matchmakingTimer);
    room.matchmakingTimer = null;
  }
  room.status = 'playing';
  closePending(room, 'Room is full.');
  broadcastRoom(room);
}

function leaveRoom(socket, disconnected = false) {
  const pending = joinRequests.get(socket.data.pendingRequestId);
  if (pending) removeRequest(pending, 'Join request cancelled.');
  const code = socket.data.roomCode;
  const playerId = socket.data.playerId;
  const room = rooms.get(code);
  if (!room) return;

  const player = room.players.find(candidate => candidate.id === playerId);
  if (!player) return;

  if (room.status === 'playing') {
    player.socketId = null;
    player.connected = false;
    player.isAI = true;
    player.name = `Robot ${player.name.replace(/^Robot\s+/i, '')}`;
    if (room.game) {
      const gamePlayer = room.game.players.find(candidate => candidate.id === player.id);
      if (gamePlayer) {
        gamePlayer.isAI = true;
        gamePlayer.name = player.name;
      }
    }
    if (room.hostPlayerId === player.id) {
      const nextHost = room.players.find(candidate => candidate.socketId && !candidate.isAI);
      room.hostPlayerId = nextHost?.id ?? null;
      room.hostSocketId = nextHost?.socketId ?? null;
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    broadcastRoom(room);
    if (room.game) io.to(room.code).emit('game:state', room.game);
    return;
  }

  room.players = room.players.filter(candidate => candidate.id !== player.id);
  if (room.hostPlayerId === player.id) closePending(room, 'Host left the room.');
  if (room.hostPlayerId === player.id) {
    room.hostPlayerId = room.players[0]?.id ?? null;
    room.hostSocketId = room.players[0]?.socketId ?? null;
  }
  socket.leave(room.code);
  socket.data.roomCode = null;
  socket.data.playerId = null;
  if (room.players.length === 0) rooms.delete(room.code);
  else broadcastRoom(room);
}

io.on('connection', socket => {
  socket.on('guest:register', (payload = {}, acknowledge = () => {}) => {
    if (!payload || typeof payload !== 'object') return acknowledge({ ok: false, error: 'Invalid guest registration.' });
    const guestId = payload.guestId;
    if (typeof guestId !== 'string' || !guestIdPattern.test(guestId)) {
      return acknowledge({ ok: false, error: 'Invalid guest ID.' });
    }
    const normalizedId = guestId.toLowerCase();
    const existing = guests.get(normalizedId);
    if (existing && existing !== socket.id) {
      return acknowledge({ ok: false, error: 'This guest ID is already connected on another device.' });
    }
    if (socket.data.guestId && socket.data.guestId !== normalizedId) guests.delete(socket.data.guestId);
    socket.data.guestId = normalizedId;
    socket.data.guestName = typeof payload.name === 'string' ? payload.name.trim().slice(0, 20) : '';
    guests.set(normalizedId, socket.id);
    acknowledge({ ok: true, invitations: [...invitations.values()].filter(invite => invite.guestId === normalizedId).map(publicInvitation) });
  });

  socket.on('room:create', (payload = {}, acknowledge = () => {}) => {
    if (!payload || typeof payload !== 'object') return acknowledge({ ok: false, error: 'Invalid room settings.' });
    if (!socket.data.guestId) return acknowledge({ ok: false, error: 'Register your guest ID first.' });
    if (socket.data.pendingRequestId) leaveRoom(socket);
    const config = MODES[payload.mode];
    if (!config) return acknowledge({ ok: false, error: 'Choose 2, 3, 4, or team play.' });
    const tokensPerPlayer = Number(payload.tokensPerPlayer ?? 4);
    if (!Number.isInteger(tokensPerPlayer) || tokensPerPlayer < 1 || tokensPerPlayer > 4) {
      return acknowledge({ ok: false, error: 'Choose between 1 and 4 tokens per player.' });
    }
    if (payload.color && !config.colors.includes(payload.color)) {
      return acknowledge({ ok: false, error: 'Choose a color available in this room.' });
    }
    if (socket.data.roomCode) leaveRoom(socket);

    const code = createCode();
    const room = {
      code,
      mode: payload.mode,
      capacity: config.capacity,
      colors: [...config.colors],
      tokensPerPlayer,
      status: 'waiting',
      matchmaking: false,
      hostSocketId: null,
      players: [],
      game: null
    };
    rooms.set(code, room);
    const player = addPlayer(room, socket, payload.name, payload.color);
    if (!player) {
      rooms.delete(code);
      return acknowledge({ ok: false, error: 'That color is not available.' });
    }
    room.hostPlayerId = player.id;
    room.hostSocketId = socket.id;
    broadcastRoom(room);
    acknowledge({ ok: true, room: publicRoom(room), playerId: player.id });
  });

  socket.on('room:join', (payload = {}, acknowledge = () => {}) => {
    if (!payload || typeof payload !== 'object') return acknowledge({ ok: false, error: 'Invalid join request.' });
    if (!socket.data.guestId) return acknowledge({ ok: false, error: 'Register your guest ID first.' });
    if (socket.data.pendingRequestId) return acknowledge({ ok: false, error: 'You already requested to join a room.' });
    const code = String(payload.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return acknowledge({ ok: false, error: 'Room code not found.' });
    if (room.status !== 'waiting') return acknowledge({ ok: false, error: 'This game has already started.' });
    if (room.players.length >= room.capacity) return acknowledge({ ok: false, error: 'This room is full.' });
    if (room.hostSocketId === socket.id) return acknowledge({ ok: false, error: 'You are already the host.' });
    if (socket.data.roomCode) leaveRoom(socket);
    const request = {
      id: randomUUID(), code, socketId: socket.id, guestId: socket.data.guestId,
      name: socket.data.guestName || 'Guest', color: payload.color
    };
    joinRequests.set(request.id, request);
    socket.data.pendingRequestId = request.id;
    io.to(room.hostSocketId).emit('room:request', { id: request.id, name: request.name, guestId: request.guestId });
    acknowledge({ ok: true, pending: true, requestId: request.id });
  });

  socket.on('room:respond', (payload = {}, acknowledge = () => {}) => {
    if (!payload || typeof payload !== 'object') return acknowledge({ ok: false, error: 'Invalid response.' });
    const room = rooms.get(socket.data.roomCode);
    const request = joinRequests.get(payload.requestId);
    if (!room || room.hostSocketId !== socket.id || !request || request.code !== room.code) {
      return acknowledge({ ok: false, error: 'Join request not found in your room.' });
    }
    if (payload.accept !== true) {
      removeRequest(request, 'Host declined your join request.');
      return acknowledge({ ok: true });
    }
    if (room.status !== 'waiting' || room.players.length >= room.capacity) {
      removeRequest(request, 'Room is full.');
      return acknowledge({ ok: false, error: 'Room is full.' });
    }
    const requester = io.sockets.sockets.get(request.socketId);
    if (!requester || requester.data.pendingRequestId !== request.id) {
      removeRequest(request, 'Guest disconnected.');
      return acknowledge({ ok: false, error: 'Guest disconnected.' });
    }
    const player = addPlayer(room, requester, request.name, request.color);
    if (!player) return acknowledge({ ok: false, error: 'That color is not available.' });
    joinRequests.delete(request.id);
    requester.data.pendingRequestId = null;
    socket.emit('room:request-removed', request.id);
    requester.emit('room:decision', { id: request.id, accepted: true, room: publicRoom(room), playerId: player.id });
    startWhenFull(room);
    if (room.status === 'waiting') broadcastRoom(room);
    acknowledge({ ok: true });
  });

  socket.on('room:invite', (payload = {}, acknowledge = () => {}) => {
    if (!payload || typeof payload !== 'object') return acknowledge({ ok: false, error: 'Invalid invitation.' });
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id || room.status !== 'waiting') {
      return acknowledge({ ok: false, error: 'Only the host of a waiting room can invite friends.' });
    }
    const guestId = payload.guestId;
    if (typeof guestId !== 'string' || !guestIdPattern.test(guestId)) {
      return acknowledge({ ok: false, error: 'Enter a full guest ID from your friend.' });
    }
    const normalizedId = guestId.toLowerCase();
    const target = guests.get(normalizedId);
    if (!target || target === socket.id) return acknowledge({ ok: false, error: 'Friend is not online in Play with Friends.' });
    if (io.sockets.sockets.get(target)?.data.roomCode) return acknowledge({ ok: false, error: 'Friend is already in a room.' });
    if (room.players.length >= room.capacity) return acknowledge({ ok: false, error: 'Room is full.' });
    if ([...invitations.values()].some(invite => invite.code === room.code && invite.guestId === normalizedId)) {
      return acknowledge({ ok: false, error: 'Invitation already sent to this guest.' });
    }
    const invitation = { id: randomUUID(), code: room.code, guestId: normalizedId };
    invitations.set(invitation.id, invitation);
    io.to(target).emit('invite:new', publicInvitation(invitation));
    acknowledge({ ok: true });
  });

  socket.on('invite:respond', (payload = {}, acknowledge = () => {}) => {
    if (!payload || typeof payload !== 'object') return acknowledge({ ok: false, error: 'Invalid response.' });
    const invitation = invitations.get(payload.inviteId);
    if (!invitation || invitation.guestId !== socket.data.guestId) {
      return acknowledge({ ok: false, error: 'Invitation not found for your guest ID.' });
    }
    const room = rooms.get(invitation.code);
    if (payload.accept !== true) {
      removeInvitation(invitation);
      return acknowledge({ ok: true });
    }
    if (!room || room.status !== 'waiting' || room.players.length >= room.capacity) {
      removeInvitation(invitation);
      return acknowledge({ ok: false, error: 'Room is no longer available.' });
    }
    if (socket.data.roomCode) leaveRoom(socket);
    const player = addPlayer(room, socket, socket.data.guestName);
    if (!player) return acknowledge({ ok: false, error: 'No seat is available.' });
    removeInvitation(invitation);
    acknowledge({ ok: true, room: publicRoom(room), playerId: player.id });
    startWhenFull(room);
    if (room.status === 'waiting') broadcastRoom(room);
  });

  socket.on('matchmaking:join', (payload = {}, acknowledge = () => {}) => {
    if (socket.data.roomCode) leaveRoom(socket);

    let room = [...rooms.values()].find(candidate =>
      candidate.matchmaking && candidate.status === 'waiting' && candidate.players.length < candidate.capacity
    );
    if (!room) {
      const mode = 'LOCAL_2';
      const config = MODES[mode];
      const code = createCode();
      room = {
        code,
        mode,
        capacity: config.capacity,
        colors: config.colors,
        tokensPerPlayer: 4,
        status: 'waiting',
        matchmaking: true,
        hostPlayerId: null,
        hostSocketId: null,
        players: [],
        game: null,
        matchmakingTimer: null
      };
      rooms.set(code, room);
    }

    const wasEmpty = room.players.length === 0;
    const player = addPlayer(room, socket, payload.name);
    if (wasEmpty) {
      room.hostPlayerId = player.id;
      room.hostSocketId = socket.id;
      room.matchmakingTimer = setTimeout(() => {
        room.matchmakingTimer = null;
        if (rooms.get(room.code) !== room || room.status !== 'waiting' || room.players.length >= room.capacity) return;

        room.players.push({
          id: randomUUID(),
          name: randomName(room),
          color: room.colors[room.players.length],
          tokens: [],
          isAI: true,
          connected: false,
          socketId: null
        });
        room.status = 'playing';
        broadcastRoom(room);
      }, MATCHMAKING_TIMEOUT_MS);
    }
    startWhenFull(room);
    broadcastRoom(room);
    acknowledge({ ok: true, room: publicRoom(room), playerId: player.id });
  });

  socket.on('game:publish', (game, acknowledge = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing' || room.hostSocketId !== socket.id || !game) {
      return acknowledge({ ok: false, error: 'Only the room host can sync game state.' });
    }
    room.game = game;
    io.to(room.code).except(socket.id).emit('game:state', game);
    acknowledge({ ok: true });
  });

  socket.on('game:action', (action = {}, acknowledge = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.find(candidate => candidate.socketId === socket.id);
    if (!room || room.status !== 'playing' || !player || player.isAI) {
      return acknowledge({ ok: false, error: 'You are not an active room player.' });
    }
    const active = room.game?.players?.[room.game.currentPlayerIndex];
    if (!active || active.id !== player.id) {
      return acknowledge({ ok: false, error: 'It is not your turn.' });
    }
    if (!room.hostSocketId) return acknowledge({ ok: false, error: 'No connected host is available.' });
    io.to(room.hostSocketId).emit('game:action', { ...action, playerId: player.id });
    acknowledge({ ok: true });
  });

  socket.on('game:chat', (payload = {}, acknowledge = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.find(candidate => candidate.socketId === socket.id && !candidate.isAI);
    if (!room || room.status !== 'playing' || !player) {
      return acknowledge({ ok: false, error: 'Join an active match to send chat.' });
    }
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(CHAT_PRESET_COUNTS, payload.type) ||
        !Number.isInteger(payload.index) || payload.index < 0 || payload.index >= CHAT_PRESET_COUNTS[payload.type]) {
      return acknowledge({ ok: false, error: 'Choose a preset message or emoji.' });
    }
    if (Date.now() - (socket.data.lastChatAt ?? 0) < CHAT_COOLDOWN_MS) {
      return acknowledge({ ok: false, error: 'Wait a moment before sending another message.' });
    }
    socket.data.lastChatAt = Date.now();
    socket.to(room.code).emit('game:chat', { playerId: player.id, type: payload.type, index: payload.index });
    acknowledge({ ok: true });
  });

  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => {
    leaveRoom(socket, true);
    if (socket.data.guestId && guests.get(socket.data.guestId) === socket.id) guests.delete(socket.data.guestId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Online room server listening on port ${server.address().port}`);
});