/**
 * Coret-Coret Game — Cloudflare Worker Entry Point
 * Routes WebSocket connections to the GameRoom Durable Object
 */

export { GameRoom } from './gameRoom.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'ok', game: 'Coret-Coret' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // WebSocket endpoint: /ws/:roomCode
    const wsMatch = url.pathname.match(/^\/ws\/([A-Z0-9]{4})$/);
    if (wsMatch) {
      const roomCode = wsMatch[1];
      const isCreate = url.searchParams.get('create') === '1';

      // Check if room exists in KV
      const exists = await env.ROOMS_KV.get('room:' + roomCode);
      if (!exists && !isCreate) {
        // Room doesn't exist and not a create request — reject
        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();
        server.send(JSON.stringify({ type: 'error', message: 'Room tidak ditemukan! Cek kode room.' }));
        server.close(1008, 'Room not found');
        return new Response(null, { status: 101, webSocket: client });
      }

      const roomId = env.GAME_ROOM.idFromName(roomCode);
      const roomStub = env.GAME_ROOM.get(roomId);
      return roomStub.fetch(request);
    }

    // Create room: POST /create-room
    // Generates a code, stores it in KV, returns it to frontend
    if (url.pathname === '/create-room' && request.method === 'POST') {
      let code, attempts = 0;
      do {
        code = generateRoomCode();
        attempts++;
      } while (attempts < 10 && await env.ROOMS_KV.get('room:' + code));

      // Store in KV with 6 hour TTL (auto-cleanup)
      await env.ROOMS_KV.put('room:' + code, '1', { expirationTtl: 21600 });

      return new Response(JSON.stringify({ code }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
