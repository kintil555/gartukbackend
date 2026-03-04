/**
 * GameRoom — Cloudflare Durable Object
 *
 * Mekanik persis seperti Gartic Phone:
 *
 * Setup:
 *   - N pemain → N chain
 *   - Total ronde = N (setiap pemain mengerjakan setiap chain tepat 1 kali)
 *
 * Rotasi chain per ronde:
 *   chainIndex = (playerIndex + roundNumber) % N
 *
 *   Round 0 (writing): player[i] mengerjakan chain[i]  → milik sendiri (nulis kata awal)
 *   Round 1 (draw):    player[i] mengerjakan chain[(i+1) % N]
 *   Round 2 (guess):   player[i] mengerjakan chain[(i+2) % N]
 *   Round 3 (draw):    player[i] mengerjakan chain[(i+3) % N]
 *   ...dst
 *
 *   Jadi player TIDAK PERNAH menerima chain miliknya sendiri setelah round 0.
 *
 * Task type per ronde:
 *   Round 0: write  (tulis kata awal)
 *   Round 1: draw   (gambar kata)
 *   Round 2: guess  (tebak dari gambar)
 *   Round 3: draw
 *   Round 4: guess
 *   ...alternating draw/guess
 *
 * States:
 *   lobby           → pemain kumpul
 *   writing_phase   → round 0, semua nulis kata
 *   album_settings  → semua selesai nulis, host atur settings
 *   playing         → round 1..N-1, gambar & tebak
 *   results         → selesai
 */

function generatePlayerId() {
  return Math.random().toString(36).slice(2, 10);
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // playerId → { ws, name, avatar, status }
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
        // playerOrder: array of playerIds, urutan tetap sepanjang game
        playerOrder: [],
        // chains: array paralel dengan playerOrder
        // chains[i] = { ownerId, ownerName, steps: [{type, content, authorId, authorName}] }
        chains: [],
        // roundNumber: 0 = writing, 1..N-1 = draw/guess
        roundNumber: 0,
        totalRounds: 0,
        // pending: Set of playerIds yang belum submit ronde ini
        pending: new Set(),
        settings: { time: 90 }
      };
    }

    // Validasi join
    if (this.room.gameState !== 'lobby') {
      server.send(JSON.stringify({ type: 'error', message: 'Game sudah berjalan!' }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (this.sessions.size >= 8) {
      server.send(JSON.stringify({ type: 'error', message: 'Room penuh (max 8)!' }));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }
    const nameTaken = [...this.sessions.values()].some(
      s => s.name.toLowerCase() === playerName.toLowerCase()
    );
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
      try { await this.handleMessage(playerId, JSON.parse(event.data)); } catch(e) {}
    });
    server.addEventListener('close', () => this.handleDisconnect(playerId));
    server.addEventListener('error', () => this.handleDisconnect(playerId));

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─────────────────────────────────────────────────────────────────
  // Message routing
  // ─────────────────────────────────────────────────────────────────
  async handleMessage(playerId, msg) {
    switch (msg.type) {
      case 'start_game':    this.handleStartGame(playerId); break;
      case 'start_rounds':  this.handleStartRounds(playerId, msg.settings); break;
      case 'submit_task':   this.handleSubmit(playerId, msg.taskType, msg.content); break;
      case 'play_again':    this.handlePlayAgain(playerId); break;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 1. START GAME → Writing Phase (Round 0)
  // ─────────────────────────────────────────────────────────────────
  handleStartGame(playerId) {
    if (this.room.hostId !== playerId)
      return this.sendTo(playerId, { type: 'error', message: 'Hanya host yang bisa mulai!' });
    if (this.sessions.size < 2)
      return this.sendTo(playerId, { type: 'error', message: 'Minimal 2 pemain!' });
    if (this.room.gameState !== 'lobby') return;

    const playerIds = [...this.sessions.keys()];
    // Shuffle sekali, urutan ini TETAP sepanjang game
    for (let i = playerIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
    }

    const N = playerIds.length;
    this.room.playerOrder = playerIds;
    this.room.totalRounds = N; // round 0..N-1
    this.room.roundNumber = 0;

    // Inisialisasi N chain, satu per pemain
    this.room.chains = playerIds.map(pid => ({
      ownerId: pid,
      ownerName: this.sessions.get(pid)?.name || '?',
      ownerAvatar: this.sessions.get(pid)?.avatar || 1,
      steps: []
    }));

    this.room.gameState = 'writing_phase';
    this.room.pending = new Set(playerIds);

    this.broadcastAll({ type: 'game_started', roomState: this.getPublicState() });

    // Round 0: player[i] nulis kata untuk chain[i] (milik sendiri)
    playerIds.forEach((pid, playerIdx) => {
      const session = this.sessions.get(pid);
      if (session) session.status = 'writing';
      this.sendTo(pid, {
        type: 'your_task',
        taskType: 'write_initial',
        content: null,
        chainOwnerName: this.sessions.get(pid)?.name,
        round: 0,
        totalRounds: N - 1  // display: round 1 of N-1 meaningful rounds
      });
    });

    this.broadcastRoomUpdate();
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. Setelah semua nulis → Album Settings
  // ─────────────────────────────────────────────────────────────────
  enterAlbumSettings() {
    this.room.gameState = 'album_settings';
    this.sessions.forEach(s => s.status = 'waiting');
    this.broadcastRoomUpdate();

    this.sendTo(this.room.hostId, {
      type: 'show_album_settings',
      roomState: this.getPublicState()
    });

    this.sessions.forEach((_, pid) => {
      if (pid !== this.room.hostId) {
        this.sendTo(pid, {
          type: 'waiting_host_settings',
          roomState: this.getPublicState()
        });
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. Host klik START di album settings → Round 1 dst
  // ─────────────────────────────────────────────────────────────────
  handleStartRounds(playerId, settings) {
    if (this.room.hostId !== playerId) return;
    if (this.room.gameState !== 'album_settings') return;

    if (settings) this.room.settings = { ...this.room.settings, ...settings };

    this.room.gameState = 'playing';
    this.room.roundNumber = 1;

    this.broadcastAll({
      type: 'rounds_starting',
      settings: this.room.settings,
      roomState: this.getPublicState()
    });

    this.distributeRound();
  }

  // ─────────────────────────────────────────────────────────────────
  // CORE: Distribusi tugas berdasarkan rotasi Gartic
  // ─────────────────────────────────────────────────────────────────
  distributeRound() {
    const round = this.room.roundNumber;
    const order = this.room.playerOrder;
    const N = order.length;

    // Task type: round 1 = draw, round 2 = guess, round 3 = draw, ...
    const taskType = round % 2 === 1 ? 'draw' : 'guess';

    this.room.pending = new Set(order);

    order.forEach((pid, playerIdx) => {
      // Rotasi Gartic: player[i] mengerjakan chain[(i + round) % N]
      const chainIdx = (playerIdx + round) % N;
      const chain = this.room.chains[chainIdx];
      const lastStep = chain.steps[chain.steps.length - 1];

      const session = this.sessions.get(pid);
      if (session) session.status = taskType === 'draw' ? 'drawing' : 'guessing';

      this.sendTo(pid, {
        type: 'your_task',
        taskType,
        content: lastStep.content,
        contentType: lastStep.type,
        chainIdx,
        chainOwnerName: chain.ownerName,
        round: round,
        totalRounds: N - 1
      });
    });

    this.broadcastRoomUpdate();
  }

  // ─────────────────────────────────────────────────────────────────
  // Submit tugas
  // ─────────────────────────────────────────────────────────────────
  handleSubmit(playerId, taskType, content) {
    if (!this.room.pending.has(playerId)) return;

    this.room.pending.delete(playerId);
    const session = this.sessions.get(playerId);
    const order = this.room.playerOrder;
    const N = order.length;
    const round = this.room.roundNumber;
    const playerIdx = order.indexOf(playerId);

    if (taskType === 'write_initial') {
      // Round 0: simpan kata awal ke chain milik sendiri (chainIdx = playerIdx)
      const chainIdx = playerIdx; // round 0: (playerIdx + 0) % N = playerIdx
      this.room.chains[chainIdx].steps.push({
        type: 'word',
        content,
        authorId: playerId,
        authorName: session?.name || '?'
      });
    } else {
      // Round 1+: simpan ke chain yang sedang dikerjakan
      const chainIdx = (playerIdx + round) % N;
      this.room.chains[chainIdx].steps.push({
        type: taskType,
        content,
        authorId: playerId,
        authorName: session?.name || '?'
      });
    }

    if (session) session.status = 'waiting';
    this.broadcastRoomUpdate();

    // Semua sudah submit ronde ini?
    if (this.room.pending.size === 0) {
      if (this.room.gameState === 'writing_phase') {
        this.enterAlbumSettings();
      } else {
        const nextRound = this.room.roundNumber + 1;
        if (nextRound >= N) {
          // Semua ronde selesai (round 0..N-1)
          this.endGame();
        } else {
          this.room.roundNumber = nextRound;
          this.distributeRound();
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // End game
  // ─────────────────────────────────────────────────────────────────
  endGame() {
    this.room.gameState = 'results';
    this.sessions.forEach(s => s.status = 'done');

    // Hasil: setiap chain dengan semua stepnya
    const results = this.room.chains.map(chain => ({
      ownerId: chain.ownerId,
      ownerName: chain.ownerName,
      ownerAvatar: chain.ownerAvatar,
      chain: chain.steps
    }));

    this.broadcastAll({ type: 'game_over', results, roomState: this.getPublicState() });
  }

  // ─────────────────────────────────────────────────────────────────
  // Play again
  // ─────────────────────────────────────────────────────────────────
  handlePlayAgain(playerId) {
    if (this.room.hostId !== playerId) return;
    this.room.gameState = 'lobby';
    this.room.roundNumber = 0;
    this.room.chains = [];
    this.room.playerOrder = [];
    this.room.pending = new Set();
    this.sessions.forEach(s => s.status = 'waiting');
    this.broadcastAll({ type: 'back_to_lobby', roomState: this.getPublicState() });
  }

  // ─────────────────────────────────────────────────────────────────
  // Disconnect handling
  // ─────────────────────────────────────────────────────────────────
  handleDisconnect(playerId) {
    const session = this.sessions.get(playerId);
    if (!session) return;
    const name = session.name;
    this.sessions.delete(playerId);

    if (this.sessions.size === 0) { this.room = null; return; }

    if (this.room.hostId === playerId) {
      this.room.hostId = [...this.sessions.keys()][0];
      if (this.room.gameState === 'album_settings') {
        this.sendTo(this.room.hostId, {
          type: 'show_album_settings',
          roomState: this.getPublicState()
        });
      }
    }

    // Kalau game sedang berjalan dan player ini belum submit, anggap sudah
    const inGame = ['playing', 'writing_phase'].includes(this.room.gameState);
    if (inGame && this.room.pending.has(playerId)) {
      // Isi dengan konten kosong supaya chain tidak rusak
      const order = this.room.playerOrder;
      const N = order.length;
      const round = this.room.roundNumber;
      const playerIdx = order.indexOf(playerId);

      if (playerIdx !== -1) {
        const chainIdx = round === 0 ? playerIdx : (playerIdx + round) % N;
        const taskType = round === 0 ? 'word' : (round % 2 === 1 ? 'draw' : 'guess');
        this.room.chains[chainIdx]?.steps.push({
          type: taskType,
          content: taskType === 'draw' ? '' : '(pemain keluar)',
          authorId: playerId,
          authorName: name + ' (keluar)'
        });
      }

      this.room.pending.delete(playerId);

      if (this.room.pending.size === 0) {
        if (this.room.gameState === 'writing_phase') {
          this.enterAlbumSettings();
        } else {
          const nextRound = this.room.roundNumber + 1;
          if (nextRound >= N) this.endGame();
          else { this.room.roundNumber = nextRound; this.distributeRound(); }
        }
      }
    }

    this.broadcast({ type: 'player_left', name }, playerId);
    this.broadcastRoomUpdate();
  }

  // ─────────────────────────────────────────────────────────────────
  // Public state (dikirim ke semua client)
  // ─────────────────────────────────────────────────────────────────
  getPublicState() {
    if (!this.room) return null;
    return {
      code: this.room.code,
      hostId: this.room.hostId,
      gameState: this.room.gameState,
      round: this.room.roundNumber,
      totalRounds: Math.max(0, this.room.totalRounds - 1),
      settings: this.room.settings,
      players: [...this.sessions.entries()].map(([id, s]) => ({
        id,
        name: s.name,
        avatar: s.avatar || 1,
        status: s.status,
        isHost: id === this.room.hostId
      }))
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────
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
  broadcastRoomUpdate() {
    this.broadcastAll({ type: 'room_update', roomState: this.getPublicState() });
  }
}
