// Minimal WhatsApp off-hours bot using Baileys
// Objective: reply a single message in group chats only during off-hours (7pm-7am)
// Delay: 3 seconds before sending the message

const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

const OFF_HOURS_MESSAGE = "⚠️ Fuera de Servicio. Nuestro horario de atención es de 7:00 AM a 7:00 PM. Por favor, escríbenos mañana a partir de las 8:00 AM.";

function isOffHours(date = new Date()) {
  const h = date.getHours();
  // off-hours: 15:00 -> 23:59 and 00:00 -> 06:59
  return h >= 15 || h < 7;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function start() {
  const sessionsDir = process.env.SESSIONS_DIR || 'sessions-offhours';
  const { state, saveCreds } = await useMultiFileAuthState(sessionsDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['OffHours Bot', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('Escanea el código QR para iniciar sesión');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ Conectado a WhatsApp');
    } else if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
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
    const isGroup = remoteJid.endsWith('@g.us');
    const isUser = remoteJid.endsWith('@s.whatsapp.net');
    const isBroadcast = remoteJid.endsWith('@broadcast');
    const isStatus = remoteJid === 'status@broadcast';

    // Handle only groups and direct user chats; ignore my own, broadcasts and status
    if (fromMe || (!isGroup && !isUser) || isBroadcast || isStatus) return;

    // Extract plain text
    const text = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text
      || msg.message?.ephemeralMessage?.message?.conversation
      || '';

    if (!text) return;

    // Only act during off-hours
    if (!isOffHours()) return;

    try {
      // Delay 3 seconds before sending
      await sleep(3000);
      await sock.sendMessage(remoteJid, { text: OFF_HOURS_MESSAGE });
    } catch (e) {
      console.error('Error enviando mensaje:', e);
    }
  });
}

start().catch((e) => console.error('Fatal error:', e));
