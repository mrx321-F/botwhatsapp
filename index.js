// Minimal WhatsApp off-hours bot using Baileys
// Objective: reply a single message during off-hours with 3s delay
// - Timezone: America/New_York (Florida)
// - Service hours: 08:00–19:00 local; off-hours otherwise
// - Dedupe per message id; cooldown per chat 10s after sending

const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const http = require('http');
const fs = require('fs');
const QRCode = require('qrcode');

const OFF_HOURS_MESSAGE = "⚠️ Fuera de Servicio. Nuestro horario de atención es de 8:00 AM a 6:00 PM. Por favor, escríbenos mañana a partir de las 8:00 AM.";
const LUNCH_MESSAGE = "⚠️ Fuera de Servicio por almuerzo. Nuestro horario se reanuda a las 2:00 PM (12:00 PM - 2:00 PM).";

// In-memory state for dedupe and cooldown
const processedMessageIds = new Set(); // msg.key.id
const cooldownUntil = new Map(); // remoteJid -> epoch ms
const respondingUntil = new Map(); // remoteJid -> epoch ms (lock during delay)
let preparedGroupsForDay = null; // { dayKey: 'YYYYMMDD-NY', jids: string[] }
let repliedGroupsReactiveForDay = null; // { dayKey: 'YYYYMMDD-NY', set: Set<string> }
let repliedGroupsForDay = null; // { dayKey: 'YYYYMMDD-NY', set: Set<string> } (broadcast tracking only)
let prepareTimer = null;
let sendTimer = null;
// Timing config
const DELAY_USER_MS = 60_000;      // 60s delay por usuario
const DELAY_GROUP_MS = 60_000;     // 60s delay por grupo (simulación humana)
const COOLDOWN_USER_MS = 10_000;   // 10s cooldown por usuario
const COOLDOWN_GROUP_MS = 15_000;  // 45s cooldown por grupo
let latestQRDataUrl = null; // data:image/png;base64,...
let currentSock = null; // reference to active socket for admin API
let whitelist = new Set(); // group jids allowed; empty => no restriction
let lastGroupsCache = { dayKey: null, list: [] }; // cache of { id, name }

function getHourInTimeZone(tz = 'America/New_York') {
  // robust hour extraction independent of server TZ
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit' });
  const hh = fmt.format(new Date());
  return parseInt(hh, 10);
}

function isOffHours() {
  // Service window: 08:00 <= time < 18:00 local (Florida)
  const h = getHourInTimeZone('America/New_York');
  return h < 8 || h >= 18;
}

function isLunchBreak() {
  const h = getHourInTimeZone('America/New_York');
  return h >= 14 && h < 16;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function start() {
  const sessionsDir = process.env.SESSIONS_DIR || 'sessions-offhours';
  const { state, saveCreds } = await useMultiFileAuthState(sessionsDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ['OffHours Bot', 'Chrome', '1.0.0']
  });
  currentSock = sock;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // Generar DataURL del QR para servirlo por HTTP en /qr
      QRCode.toDataURL(qr)
        .then((dataUrl) => { latestQRDataUrl = dataUrl; })
        .catch((e) => { console.error('No se pudo generar QR DataURL:', e); latestQRDataUrl = null; });
    }
    if (connection === 'open') {
      console.log('✅ Conectado a WhatsApp');
      setupDailySchedules(sock);
    } else if (connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode === DisconnectReason.loggedOut ? false : true;
      console.log('Conexión cerrada. Reintentar:', shouldReconnect);
      if (shouldReconnect) start();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages && m.messages[0];
    if (!msg) return;

    const remoteJid = msg.key?.remoteJid || '';
    const fromMe = !!msg.key?.fromMe;
    const messageId = msg.key?.id;
    const isGroup = remoteJid.endsWith('@g.us');
    const isUser = remoteJid.endsWith('@s.whatsapp.net');
    const isBroadcast = remoteJid.endsWith('@broadcast');
    const isStatus = remoteJid === 'status@broadcast';

    // Handle only groups and direct user chats; ignore my own, broadcasts and status
    if (fromMe || (!isGroup && !isUser) || isBroadcast || isStatus) return;

    // Dedupe per message id (Baileys can upsert retries)
    if (messageId) {
      if (processedMessageIds.has(messageId)) return;
      processedMessageIds.add(messageId);
      // best-effort cleanup to prevent unbounded growth
      if (processedMessageIds.size > 5000) {
        // remove oldest 1000 roughly (recreate set)
        const arr = Array.from(processedMessageIds).slice(-4000);
        processedMessageIds.clear();
        arr.forEach((id) => processedMessageIds.add(id));
      }
    }

    // Extract plain text (conversation, extended, captions, buttons/list), including under ephemeral
    const text = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.imageMessage?.caption
      || msg.message?.videoMessage?.caption
      || msg.message?.buttonsResponseMessage?.selectedDisplayText
      || msg.message?.listResponseMessage?.title
      || msg.message?.ephemeralMessage?.message?.conversation
      || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text
      || msg.message?.ephemeralMessage?.message?.imageMessage?.caption
      || msg.message?.ephemeralMessage?.message?.videoMessage?.caption
      || '';

    if (!text || !String(text).trim()) {
      if (isGroup) console.log('[reactive] Ignorado por texto vacío en grupo:', remoteJid);
      return;
    }

    // If group whitelist is active, skip early when group is not allowed
    if (isGroup && whitelist.size > 0 && !whitelist.has(remoteJid)) {
      console.log('[reactive] Grupo no permitido por whitelist:', remoteJid);
      return;
    }

    // Only act during off-hours or lunch break
    const lunchNow = isLunchBreak();
    // Durante el almuerzo también respondemos a usuarios; fuera del almuerzo solo si es fuera de horario
    const offNow = isOffHours();
    if (isGroup) {
      const hh = getHourInTimeZone('America/New_York');
      const wl = whitelist.size > 0 ? whitelist.has(remoteJid) : true;
      console.log(`[reactive] flags JID=${remoteJid} hour=${hh} off=${offNow} lunch=${lunchNow} whitelisted=${wl}`);
    }
    if (!offNow && !lunchNow) {
      if (isGroup) console.log('[reactive] En horario, no se responde. JID:', remoteJid);
      return;
    }

    // One-per-group-per-day gating for groups (reactive only)
    if (isGroup) {
      ensureReactiveGroupsForToday();
      if (repliedGroupsReactiveForDay.set.has(remoteJid)) {
        console.log('[reactive] Grupo ya respondió hoy, omitiendo:', remoteJid);
        return;
      }
    }

    // Per-chat cooldown (usuarios 60s, grupos 5min)
    const now = Date.now();
    const until = cooldownUntil.get(remoteJid) || 0;
    if (now < until) {
      if (isGroup) console.log('[reactive] En cooldown hasta', new Date(until).toISOString(), 'JID:', remoteJid);
      return;
    }

    // Guard durante el delay: evita programar dos envíos en paralelo para el mismo chat
    const respUntil = respondingUntil.get(remoteJid) || 0;
    if (now < respUntil) {
      if (isGroup) console.log('[reactive] Ya hay un envío programado para este grupo. JID:', remoteJid, 'hasta', new Date(respUntil).toISOString());
      return;
    }
    const delayMs = isGroup ? DELAY_GROUP_MS : DELAY_USER_MS;
    respondingUntil.set(remoteJid, now + delayMs + 1000); // delay + margen

    try {
      await sleep(delayMs);
      const messageToSend = lunchNow ? LUNCH_MESSAGE : OFF_HOURS_MESSAGE;
      if (isGroup) console.log('[reactive] Enviando a grupo con delay(ms)=', delayMs, 'JID:', remoteJid);
      await sock.sendMessage(remoteJid, { text: messageToSend });
      const cd = isGroup ? COOLDOWN_GROUP_MS : COOLDOWN_USER_MS;
      cooldownUntil.set(remoteJid, Date.now() + cd);
      if (isGroup) {
        ensureReactiveGroupsForToday();
        repliedGroupsReactiveForDay.set.add(remoteJid);
      }
    } catch (e) {
      console.error('Error enviando mensaje:', e);
    } finally {
      // Libera el guard de delay
      respondingUntil.delete(remoteJid);
    }
  });
}

// ---------- Scheduling daily group broadcast (America/New_York) ----------
function getNYParts() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = fmt.formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return {
    y: parseInt(parts.year, 10),
    m: parseInt(parts.month, 10),
    d: parseInt(parts.day, 10),
    hh: parseInt(parts.hour, 10),
    mm: parseInt(parts.minute, 10),
    ss: parseInt(parts.second, 10)
  };
}

function nyDayKey() {
  const { y, m, d } = getNYParts();
  return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

function ensureRepliedGroupsForToday() {
  const dayKey = nyDayKey();
  if (!repliedGroupsForDay || repliedGroupsForDay.dayKey !== dayKey) {
    repliedGroupsForDay = { dayKey, set: new Set() };
  }
}

function ensureReactiveGroupsForToday() {
  const dayKey = nyDayKey();
  if (!repliedGroupsReactiveForDay || repliedGroupsReactiveForDay.dayKey !== dayKey) {
    repliedGroupsReactiveForDay = { dayKey, set: new Set() };
  }
}

function msUntilNY(targetHour, targetMinute) {
  const { hh, mm, ss } = getNYParts();
  const nowMins = hh * 60 + mm;
  const targetMins = targetHour * 60 + targetMinute;
  let deltaMins = (targetMins - nowMins);
  if (deltaMins < 0) deltaMins += 24 * 60;
  // Subtract current seconds to align at exact minute
  const ms = (deltaMins * 60 - ss) * 1000;
  return ms <= 0 ? 1000 : ms; // safety
}

async function prepareGroups(sock) {
  try {
    const dayKey = nyDayKey();
    const participating = await sock.groupFetchAllParticipating();
    const jids = Object.keys(participating || {});
    preparedGroupsForDay = { dayKey, jids };
    console.log(`Preparado envío fuera de servicio para ${jids.length} grupos (día ${dayKey}).`);
    // also refresh name cache for admin UI
    const list = jids.map((jid) => ({ id: jid, name: participating[jid]?.subject || jid }));
    lastGroupsCache = { dayKey, list };
  } catch (e) {
    console.error('Error preparando grupos:', e);
    preparedGroupsForDay = { dayKey: nyDayKey(), jids: [] };
  }
}

async function sendOffHoursToPreparedGroups(sock) {
  const dayKey = nyDayKey();
  if (!preparedGroupsForDay || preparedGroupsForDay.dayKey !== dayKey) {
    // If not prepared (e.g., restart between 18:00 and 18:15), try quick prepare now
    await prepareGroups(sock);
  }
  const jids = preparedGroupsForDay?.jids || [];
  console.log(`Enviando fuera de servicio a ${jids.length} grupos (día ${dayKey}).`);
  for (const jid of jids) {
    if (!jid.endsWith('@g.us')) continue;
    if (whitelist.size > 0 && !whitelist.has(jid)) {
      console.log('[broadcast] Grupo omitido por whitelist:', jid);
      continue;
    }
    try {
      await sock.sendMessage(jid, { text: OFF_HOURS_MESSAGE });
      // Marca como respondido por el día para evitar duplicados posteriores
      ensureRepliedGroupsForToday();
      repliedGroupsForDay.set.add(jid);
      // Pausa aleatoria de 1 a 5 minutos entre grupos
      const mins = Math.floor(Math.random() * 5) + 1; // 1..5
      const pauseMs = mins * 60_000;
      console.log(`Pausa de ${mins} minuto(s) antes del próximo grupo...`);
      await sleep(pauseMs);
    } catch (e) {
      console.error(`Error enviando a grupo ${jid}:`, e);
    }
  }
}

function setupDailySchedules(sock) {
  // Clear existing timers if any
  if (prepareTimer) clearTimeout(prepareTimer);
  if (sendTimer) clearTimeout(sendTimer);

  // Schedule prepare at 18:00 NY
  const msToPrepare = msUntilNY(18, 0);
  prepareTimer = setTimeout(async () => {
    await prepareGroups(sock);
    // After preparing, schedule sending at 18:15 NY for the same day
    const msToSend = msUntilNY(18, 15);
    sendTimer = setTimeout(async () => {
      await sendOffHoursToPreparedGroups(sock);
      // Reschedule next day after sending
      setupDailySchedules(sock);
    }, msToSend);
  }, msToPrepare);

  // If now is between 18:00 and 18:15 NY (restart scenario), prepare immediately and schedule send at 18:15
  const { hh, mm } = getNYParts();
  if (hh === 18 && mm < 15) {
    (async () => {
      await prepareGroups(sock);
      const msToSend = msUntilNY(18, 15);
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(async () => {
        await sendOffHoursToPreparedGroups(sock);
        setupDailySchedules(sock);
      }, msToSend);
    })();
  }
}

start().catch((e) => console.error('Fatal error:', e));

// Minimal HTTP server for Render Web Service y vista de QR
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    if (req.url === '/qr') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const hasQR = !!latestQRDataUrl;
      const body = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WhatsApp QR</title>
    <style>body{font-family:system-ui,Segoe UI,Arial;margin:24px} .card{max-width:460px;margin:auto;padding:16px;border:1px solid #ddd;border-radius:12px} img{width:100%;height:auto} .muted{color:#666}</style>
  </head>
  <body>
    <div class="card">
      <h1>Escanea el QR</h1>
      ${hasQR ? `<img alt="QR" src="${latestQRDataUrl}" />` : `<p class="muted">No hay un QR disponible todavía. Si ya escaneaste o la sesión está activa, este mensaje es normal. Mantén esta página abierta y recarga cuando se solicite un nuevo QR.</p>`}
      <p class="muted">Estado: ${hasQR ? 'QR listo' : 'Esperando QR'}</p>
    </div>
  </body>
</html>`;
      res.end(body);
      return;
    }
    // Admin UI static
    if (req.url === '/admin' || req.url === '/admin/') {
      try {
        const html = fs.readFileSync(__dirname + '/admin.html', 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('admin.html no encontrado');
      }
      return;
    }
    // API: listar grupos
    if (req.url === '/api/groups' && req.method === 'GET') {
      (async () => {
        try {
          const dayKey = nyDayKey();
          if (!lastGroupsCache.list.length || lastGroupsCache.dayKey !== dayKey) {
            if (currentSock) {
              const participating = await currentSock.groupFetchAllParticipating();
              const jids = Object.keys(participating || {});
              lastGroupsCache = { dayKey, list: jids.map((jid) => ({ id: jid, name: participating[jid]?.subject || jid })) };
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ groups: lastGroupsCache.list }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'failed_groups', details: String(e) }));
        }
      })();
      return;
    }
    // API: obtener whitelist
    if (req.url === '/api/whitelist' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jids: Array.from(whitelist) }));
      return;
    }
    // API: guardar whitelist
    if (req.url === '/api/whitelist' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          const jids = Array.isArray(data.jids) ? data.jids.filter((x) => typeof x === 'string' && x.endsWith('@g.us')) : [];
          whitelist = new Set(jids);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: whitelist.size }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad_json', details: String(e) }));
        }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('offhours-bot: OK. Visita /qr para QR o /admin para panel.');
  })
  .listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));
    