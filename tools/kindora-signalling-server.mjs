#!/usr/bin/env node
/**
 * Kindora WebRTC Mode C signalling server (HTTP long-poll).
 *
 * Zero npm dependencies — Node `http` only.
 *
 * Usage:
 *   node tools/kindora-signalling-server.mjs [--port 8787]
 *
 * Endpoints:
 *   POST /v1/rooms/:roomId/join          { role: 'offer'|'answer' }
 *   POST /v1/rooms/:roomId/messages      { from, kind, description?, candidate? }
 *   GET  /v1/rooms/:roomId/messages?after=N&waitMs=2500
 *
 * Rooms are in-memory and expire after 30 minutes of inactivity.
 * This is a development / self-hosted helper — not a Kindora-operated service.
 */

import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number.parseInt(
  process.argv.find((a, i) => process.argv[i - 1] === '--port') ?? '8787',
  10,
);
const ROOM_TTL_MS = 30 * 60 * 1000;

/** @type {Map<string, { messages: any[], touch: number, waiters: Array<(msgs:any[])=>void> }>} */
const rooms = new Map();

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { messages: [], touch: Date.now(), waiters: [] };
    rooms.set(id, room);
  }
  room.touch = Date.now();
  return room;
}

function gcRooms() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.touch > ROOM_TTL_MS) rooms.delete(id);
  }
}
setInterval(gcRooms, 60_000).unref?.();

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const match = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/(join|messages)$/);
  if (!match) {
    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true, rooms: rooms.size });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const roomId = decodeURIComponent(match[1]);
  const action = match[2];
  const room = getRoom(roomId);

  try {
    if (action === 'join' && req.method === 'POST') {
      await readJson(req);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (action === 'messages' && req.method === 'POST') {
      const body = await readJson(req);
      const id = room.messages.length;
      const msg = { id, ...body, ts: Date.now() };
      room.messages.push(msg);
      const waiters = room.waiters.splice(0);
      for (const w of waiters) w([msg]);
      sendJson(res, 200, { ok: true, id });
      return;
    }
    if (action === 'messages' && req.method === 'GET') {
      const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0;
      const waitMs = Math.min(
        10_000,
        Math.max(0, Number.parseInt(url.searchParams.get('waitMs') ?? '0', 10) || 0),
      );
      const pending = room.messages.filter((m) => m.id >= after);
      if (pending.length > 0 || waitMs === 0) {
        sendJson(res, 200, { messages: pending });
        return;
      }
      const timer = setTimeout(() => {
        const idx = room.waiters.indexOf(onMsg);
        if (idx >= 0) room.waiters.splice(idx, 1);
        sendJson(res, 200, { messages: [] });
      }, waitMs);
      const onMsg = (msgs) => {
        clearTimeout(timer);
        sendJson(res, 200, { messages: msgs.filter((m) => m.id >= after) });
      };
      room.waiters.push(onMsg);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (e) {
    sendJson(res, 400, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kindora signalling server listening on http://127.0.0.1:${PORT}`);
  console.log('Point Settings → WebRTC signalling URL at this address.');
});
