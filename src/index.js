/**
 * Coret-Coret Game — Cloudflare Worker Entry Point
 * Routes WebSocket connections to the GameRoom Durable Object
 */

export { GameRoom } from './gameRoom.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'ok', game: 'Coret-Coret' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // WebSocket endpoint: /ws/:roomCode
    // e.g. /ws/AB3X
    const wsMatch = url.pathname.match(/^\/ws\/([A-Z0-9]{4})$/);
    if (wsMatch) {
      const roomCode = wsMatch[1];
      const roomId = env.GAME_ROOM.idFromName(roomCode);
      const roomStub = env.GAME_ROOM.get(roomId);
      return roomStub.fetch(request);
    }

    // Create room endpoint: POST /create-room
    if (url.pathname === '/create-room' && request.method === 'POST') {
      const code = generateRoomCode();
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
