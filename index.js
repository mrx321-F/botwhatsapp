// Minimal WhatsApp off-hours bot using Baileys
// Objective: reply a single message during off-hours with 3s delay
// - Timezone: America/New_York (Florida)
// - Service hours: 08:00–19:00 local; off-hours otherwise
// - Dedupe per message id; cooldown per chat 10s after sending

const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const http = require('http');
const QRCode = require('qrcode');

const OFF_HOURS_MESSAGE = "⚠️ Fuera de Servicio. Nuestro horario de atención es de 7:00 AM a 7:00 PM. Por favor, escríbenos mañana a partir de las 8:00 AM.";
const LUNCH_MESSAGE = "⚠️ Fuera de Servicio por almuerzo. Nuestro horario se reanuda a las 2:00 PM (12:00 PM - 2:00 PM).";

// In-memory state for dedupe and cooldown
const processedMessageIds = new Set(); // msg.key.id
const cooldownUntil = new Map(); // remoteJid -> epoch ms
const respondingUntil = new Map(); // remoteJid -> epoch ms (lock during delay)
let preparedGroupsForDay = null; // { dayKey: 'YYYYMMDD-NY', jids: string[] }
let prepareTimer = null;
let sendTimer = null;
let latestQRDataUrl = null; // data:image/png;base64,...

function getHourInTimeZone(tz = 'America/New_York') {
  // robust hour extraction independent of server TZ
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit' });
  const hh = fmt.format(new Date());
  return parseInt(hh, 10);
}

function isOffHours() {
  // Service window: 08:00 <= time < 19:00 local (Florida)
  const h = getHourInTimeZone('America/New_York');
  return h < 8 || h >= 19;
}

function isLunchBreak() {
  const h = getHourInTimeZone('America/New_York');
  return h >= 12 && h < 14;
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

    // Extract plain text
    const text = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text
      || msg.message?.ephemeralMessage?.message?.conversation
      || '';

    if (!text) return;

    // Only act during off-hours or lunch break
    const lunchNow = isLunchBreak();
    // Lunch message applies to groups only; if lunch and not group, do nothing
    if (lunchNow && !isGroup) return;
    // Outside lunch: only act if off-hours
    if (!isOffHours() && !lunchNow) return;

    // Per-chat cooldown: 10 seconds after sending to this chat
    const now = Date.now();
    const until = cooldownUntil.get(remoteJid) || 0;
    if (now < until) return;

    // Guard durante el delay: evita programar dos envíos en paralelo para el mismo chat
    const respUntil = respondingUntil.get(remoteJid) || 0;
    if (now < respUntil) return;
    respondingUntil.set(remoteJid, now + 10000 + 500); // delay (10s) + margen

    try {
      await sleep(10000);
      const messageToSend = (lunchNow && isGroup) ? LUNCH_MESSAGE : OFF_HOURS_MESSAGE;
      await sock.sendMessage(remoteJid, { text: messageToSend });
      cooldownUntil.set(remoteJid, Date.now() + 10_000);
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
    try {
      await sock.sendMessage(jid, { text: OFF_HOURS_MESSAGE });
      await sleep(800); // pequeño espaciamiento para evitar rate limits
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
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('offhours-bot: OK. Visita /qr para mostrar el código QR.');
  })
  .listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));
