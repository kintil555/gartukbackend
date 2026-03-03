/**
 * GameRoom — Cloudflare Durable Object
 * Round 1: setiap pemain MENULIS KATA SENDIRI (bukan dari sistem)
 * Round 2+: bergantian gambar & tebak
 */

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generatePlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.room = null;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const url = new URL(request.url);
    const roomCode = url.pathname.split('/').pop();
    const playerName = url.searchParams.get('name') || 'Pemain';
    const playerAvatar = parseInt(url.searchParams.get('avatar') || '1');

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const playerId = generatePlayerId();

    if (!this.room) {
      this.room = {
        code: roomCode,
        hostId: null,
        gameState: 'lobby',
        round: 0,
        totalRounds: 0,
        playerOrder: [],
        chains: {},
        currentTasks: {},
        pendingSubmissions: new Set()
      };
    }

    if (this.room.gameState !== 'lobby') {
      server.send(JSON.stringify({ type: 'error', message: 'Game sudah berjalan!' }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (this.sessions.size >= 8) {
      server.send(JSON.stringify({ type: 'error', message: 'Room sudah penuh (max 8 pemain)!' }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }
    const nameTaken = [...this.sessions.values()].some(s => s.name.toLowerCase() === playerName.toLowerCase());
    if (nameTaken) {
      server.send(JSON.stringify({ type: 'error', message: 'Nama sudah dipakai!' }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }

    this.sessions.set(playerId, { ws: server, name: playerName, avatar: playerAvatar, status: 'waiting' });
    if (!this.room.hostId) this.room.hostId = playerId;

    server.send(JSON.stringify({
      type: 'welcome',
      playerId,
      isHost: this.room.hostId === playerId,
      roomState: this.getPublicState()
    }));

    this.broadcast({ type: 'player_joined', name: playerName }, playerId);
    this.broadcastRoomUpdate();

    server.addEventListener('message', async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await this.handleMessage(playerId, msg);
      } catch (e) {}
    });

    server.addEventListener('close', () => this.handleDisconnect(playerId));
    server.addEventListener('error', () => this.handleDisconnect(playerId));

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(playerId, msg) {
    switch (msg.type) {
      case 'start_game':  this.handleStartGame(playerId); break;
      case 'submit_task': this.handleSubmit(playerId, msg.taskType, msg.content); break;
      case 'play_again':  this.handlePlayAgain(playerId); break;
    }
  }

  handleStartGame(playerId) {
    if (this.room.hostId !== playerId) {
      this.sendTo(playerId, { type: 'error', message: 'Hanya host yang bisa mulai!' });
      return;
    }
    if (this.sessions.size < 2) {
      this.sendTo(playerId, { type: 'error', message: 'Minimal 2 pemain!' });
      return;
    }
    if (this.room.gameState !== 'lobby') return;
    this.startWritingPhase();
  }

  // ── Fase awal: semua pemain tulis kata/kalimat mereka sendiri ──────────────
  startWritingPhase() {
    const playerIds = [...this.sessions.keys()];
    const shuffled = shuffle(playerIds);

    this.room.gameState = 'writing_phase';
    this.room.round = 0;
    this.room.totalRounds = playerIds.length * 2 - 1;
    this.room.playerOrder = shuffled;
    this.room.chains = {};
    this.room.currentTasks = {};
    this.room.pendingSubmissions = new Set(playerIds);

    shuffled.forEach(pid => {
      this.room.chains[pid] = [];
      this.room.currentTasks[pid] = { type: 'write_initial', chainOwnerId: pid };
    });

    this.broadcastAll({ type: 'game_started', roomState: this.getPublicState() });

    // Kirim tugas: tulis kata/kalimat bebas
    this.sessions.forEach((session, pid) => {
      session.status = 'writing';
      this.sendTo(pid, {
        type: 'your_task',
        taskType: 'write_initial',
        content: null,
        round: 0,
        totalRounds: this.room.totalRounds
      });
    });

    this.broadcastRoomUpdate();
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  handleSubmit(playerId, taskType, content) {
    if (!this.room.pendingSubmissions.has(playerId)) return;

    this.room.pendingSubmissions.delete(playerId);
    const session = this.sessions.get(playerId);
    const task = this.room.currentTasks[playerId];
    const chainOwnerId = task?.chainOwnerId;

    if (taskType === 'write_initial') {
      // Kata awal = dari pemain sendiri, masuk ke chain miliknya
      this.room.chains[playerId] = [{
        type: 'word',
        content,
        authorId: playerId,
        authorName: session?.name
      }];
    } else {
      if (chainOwnerId && this.room.chains[chainOwnerId]) {
        this.room.chains[chainOwnerId].push({
          type: taskType,
          content,
          authorId: playerId,
          authorName: session?.name
        });
      }
    }

    if (session) session.status = 'waiting';
    this.broadcastRoomUpdate();

    if (this.room.pendingSubmissions.size === 0) {
      if (this.room.gameState === 'writing_phase') {
        this.room.gameState = 'playing';
        this.room.round = 1;
        this.distributeNextRound();
      } else {
        this.room.round++;
        if (this.room.round > this.room.totalRounds) this.endGame();
        else this.distributeNextRound();
      }
    }
  }

  // ── Distribusi ronde: ganjil=gambar, genap=tebak ─────────────────────────
  distributeNextRound() {
    const round = this.room.round;
    const isDrawRound = round % 2 === 1;
    const taskType = isDrawRound ? 'draw' : 'guess';
    const order = this.room.playerOrder;

    this.room.pendingSubmissions = new Set([...this.sessions.keys()]);

    order.forEach((pid, idx) => {
      const prevIdx = (idx - 1 + order.length) % order.length;
      const chainOwnerId = order[prevIdx];
      const chain = this.room.chains[chainOwnerId];
      const lastEntry = chain[chain.length - 1];

      this.room.currentTasks[pid] = { type: taskType, content: lastEntry.content, contentType: lastEntry.type, chainOwnerId };

      const session = this.sessions.get(pid);
      if (session) session.status = taskType === 'draw' ? 'drawing' : 'guessing';

      this.sendTo(pid, {
        type: 'your_task',
        taskType,
        content: lastEntry.content,
        contentType: lastEntry.type,
        round: this.room.round,
        totalRounds: this.room.totalRounds
      });
    });

    this.broadcastRoomUpdate();
  }

  endGame() {
    this.room.gameState = 'results';
    this.sessions.forEach(s => s.status = 'done');

    const results = this.room.playerOrder.map(ownerId => ({
      ownerId,
      ownerName: this.sessions.get(ownerId)?.name || '?',
      ownerAvatar: this.sessions.get(ownerId)?.avatar || 1,
      chain: this.room.chains[ownerId] || []
    }));

    this.broadcastAll({ type: 'game_over', results, roomState: this.getPublicState() });
  }

  handlePlayAgain(playerId) {
    if (this.room.hostId !== playerId) return;
    this.room.gameState = 'lobby';
    this.room.round = 0;
    this.room.chains = {};
    this.room.currentTasks = {};
    this.room.pendingSubmissions = new Set();
    this.sessions.forEach(s => s.status = 'waiting');
    this.broadcastAll({ type: 'back_to_lobby', roomState: this.getPublicState() });
  }

  handleDisconnect(playerId) {
    const session = this.sessions.get(playerId);
    if (!session) return;
    const name = session.name;
    this.sessions.delete(playerId);

    if (this.sessions.size === 0) { this.room = null; return; }
    if (this.room.hostId === playerId) this.room.hostId = [...this.sessions.keys()][0];

    const inGame = this.room.gameState === 'playing' || this.room.gameState === 'writing_phase';
    if (inGame && this.room.pendingSubmissions?.has(playerId)) {
      this.room.pendingSubmissions.delete(playerId);
      if (this.room.pendingSubmissions.size === 0) {
        if (this.room.gameState === 'writing_phase') {
          this.room.gameState = 'playing';
          this.room.round = 1;
          this.distributeNextRound();
        } else {
          this.room.round++;
          if (this.room.round > this.room.totalRounds) this.endGame();
          else this.distributeNextRound();
        }
      }
    }

    this.broadcast({ type: 'player_left', name }, playerId);
    this.broadcastRoomUpdate();
  }

  getPublicState() {
    if (!this.room) return null;
    return {
      code: this.room.code,
      hostId: this.room.hostId,
      gameState: this.room.gameState,
      round: this.room.round,
      totalRounds: this.room.totalRounds,
      players: [...this.sessions.entries()].map(([id, s]) => ({
        id, name: s.name, avatar: s.avatar || 1, status: s.status, isHost: id === this.room.hostId
      }))
    };
  }

  sendTo(playerId, data) {
    const s = this.sessions.get(playerId);
    if (s?.ws?.readyState === WebSocket.OPEN) {
      try { s.ws.send(JSON.stringify(data)); } catch(e) {}
    }
  }

  broadcast(data, excludeId = null) {
    this.sessions.forEach((s, id) => {
      if (id !== excludeId && s.ws?.readyState === WebSocket.OPEN) {
        try { s.ws.send(JSON.stringify(data)); } catch(e) {}
      }
    });
  }

  broadcastAll(data) { this.broadcast(data, null); }
  broadcastRoomUpdate() { this.broadcastAll({ type: 'room_update', roomState: this.getPublicState() }); }
}
