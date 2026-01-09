// index.js — Baileys + Web UI

require('dotenv').config();

const fs = require('fs');

const path = require('path');

const express = require('express');

const http = require('http');

const socketIo = require('socket.io');

const basicAuth = require('express-basic-auth');

const qrcode = require('qrcode');

const qrcodeTerminal = require('qrcode-terminal');

const P = require('pino');

const securexpress = require('securexpress');

const {

  default: makeWASocket,

  useMultiFileAuthState,

  fetchLatestBaileysVersion,

  DisconnectReason,

} = require('@whiskeysockets/baileys');

const { createStickerFromText } = require('./sticker');

const cron = require('node-cron');

const ngrok = require('@ngrok/ngrok');

const SCHEDULE_GROUP_JID = process.env.SCHEDULE_GROUP_JID || '';

const SCHEDULE_MSG = process.env.SCHEDULE_MSG || 'Halo semua — ini pengumuman otomatis setiap Sabtu 16:00.';

const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'Asia/Jakarta';
const CRON_EXPR = process.env.CRON_EXPR || '0 16 * * 6';

// whitelist groups: gunakan SCHEDULE_GROUP_JID sebagai satu-satunya grup yang diizinkan
const ALLOWED_GROUP_IDS = SCHEDULE_GROUP_JID ? [SCHEDULE_GROUP_JID] : [];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function safeSendMessage(jid, content, options = {}) {
  await delay(1000 + Math.random() * 3000)
  const s = global.sock;
  if (!s) throw new Error('Socket not ready');
  return s.sendMessage(jid, content, options);
}
global.safeSendMessage = safeSendMessage;


// helper cek allowed group
function isAllowedGroup(groupJid) {
  if (!ALLOWED_GROUP_IDS || ALLOWED_GROUP_IDS.length === 0) return false;
  return ALLOWED_GROUP_IDS.includes(groupJid);
}

const PORT = process.env.PORT || 3000;

const WEB_USER = process.env.WEB_USER || 'admin';

const WEB_PASS = process.env.WEB_PASS || 'password123';

const AUTH_DIR = process.env.AUTH_DIR || './auth_info';

const OWNER_PHONE = process.env.OWNER_PHONE || ''; // e.g. 6281234567890

if (!OWNER_PHONE) console.warn('WARNING: OWNER_PHONE not set in .env — bot triggers disabled until set.');

const ownerJid = OWNER_PHONE.includes('@') ? OWNER_PHONE : `${OWNER_PHONE}@s.whatsapp.net`;

const WELCOME_MESSAGE = process.env.WELCOME_MESSAGE || 'Selamat datang @{user}';

const OUT_MESSAGE = process.env.OUT_MESSAGE || 'Selamat tinggal @{user}';

const MENU_MESSAGE = process.env.MENU_MESSAGE || 'Menu belum diset.';

function envText(text) {
  return String(text || '').replace(/\\n/g, '\n');
}


// =====================
// CEK ADMIN GRUP
// =====================
async function isGroupAdmin(sock, groupJid, userJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    if (!metadata || !metadata.participants) return false;

    const participant = metadata.participants.find(
      p => (p.id || p.jid) === userJid
    );

    if (!participant) return false;

    return (
      participant.admin === 'admin' ||
      participant.admin === 'superadmin'
    );
  } catch (err) {
    console.error('isGroupAdmin error:', err);
    return false;
  }
}


// ngrok
ngrok.connect({ addr: PORT, authtoken_from_env: true })
	.then(listener => console.log(`Ingress established at: ${listener.url()}`));


// =====================
// NORMALIZE NOMOR → JID
// =====================
function toJid(number) {
  if (!number) return null;
  let n = String(number).replace(/\D/g, '');
  if (!n) return null;
  return `${n}@s.whatsapp.net`;
}


// =====================
// /tagall - HIDE TAG
// =====================

async function handleTagAll(sock, groupJid, senderJid, argsText, msg) {
  try {
    // hanya grup
    if (!groupJid || !groupJid.endsWith('@g.us')) return;

    // hanya admin grup
    const okAdmin = await isGroupAdmin(sock, groupJid, senderJid);
    if (!okAdmin) return;


    // teks HARUS sama persis dengan input user
    const textToSend = argsText;
    if (!textToSend || !textToSend.trim()) {
      await safeSendMessage(
        groupJid,
        { text: 'Gunakan: /tagall <pesan>' },
        { quoted: msg }
      );
      return;
    }

    const metadata = await sock.groupMetadata(groupJid);
    const participants = metadata?.participants || [];

    // ambil semua jid anggota grup
    const mentions = participants
      .map(p => p.id || p.jid)
      .filter(Boolean);

    // KIRIM HIDE TAG
    await safeSendMessage(groupJid, {
      text: textToSend, // TIDAK DIMODIFIKASI
      mentions           // mention tersembunyi
    });

  } catch (err) {
    console.error('handleTagAll error:', err);
  }
}



// /add <nomor> handler
async function addMemberToGroup(sock, groupJid, numberOrJid, msg, senderJid) {
  try {
    // whitelist check
    if (!isAllowedGroup(groupJid)) {
      console.log('Perintah /add tidak diizinkan di grup ini.');
      return;
    }

    if (!groupJid.endsWith('@g.us')) {
      console.log('Perintah /add hanya bisa digunakan di grup.');
      return;
    }

    // check sender admin
    const okAdmin = await isGroupAdmin(sock, groupJid, senderJid);
    if (!okAdmin) {
      await safeSendMessage(groupJid, { text: 'Hanya admin grup yang dapat menggunakan /add.' }, { quoted: msg }).catch(()=>{});
      return;
    }

  

    const jid = numberOrJid.includes('@') ? numberOrJid : toJid(numberOrJid);
    if (!jid) {
      await safeSendMessage(groupJid, { text: 'Nomor tidak valid.' }, { quoted: msg }).catch(()=>{});
      return;
    }

    try {
      await sock.groupParticipantsUpdate(groupJid, [jid], 'add');
      await safeSendMessage(groupJid, { text: `Berhasil menambahkan: @${jid.split('@')[0]}`, mentions: [jid] });
    } catch (e) {
      console.error('group add error', e);
      // fallback: kirim invite link jika add gagal
      try {
        const code = await sock.groupInviteCode(groupJid);
        const inviteUrl = `https://chat.whatsapp.com/${code}`;
        await safeSendMessage(groupJid, { text: `Gagal menambahkan secara langsung. Kirim undangan: ${inviteUrl}` }, { quoted: msg });
      } catch (e2) {
        await safeSendMessage(groupJid, { text: 'Gagal menambahkan anggota. Pastikan bot admin dan nomor valid.' }, { quoted: msg }).catch(()=>{});
      }
    }
  } catch (err) {
    console.error('addMemberToGroup error', err);
    await safeSendMessage(groupJid, { text: 'Terjadi kesalahan saat mencoba menambahkan anggota.' }, { quoted: msg }).catch(()=>{});
  }
}

// /kick <nomor|mention> handler
async function kickMemberFromGroup(sock, groupJid, targetInput, msg, senderJid) {
  try {
    // whitelist check
    if (!isAllowedGroup(groupJid)) {
      console.log('Perintah /kick tidak diizinkan di grup ini.');
      return;
    }

    if (!groupJid.endsWith('@g.us')) {
      console.log('Perintah /kick hanya bisa digunakan di grup.');
      return;
    }

    // check sender admin
    const okAdmin = await isGroupAdmin(sock, groupJid, senderJid);
    if (!okAdmin) {
      await safeSendMessage(groupJid, { text: 'Hanya admin grup yang dapat menggunakan /kick.' }, { quoted: msg }).catch(()=>{});
      return;
    }


    // if message contains mentionedJid, use them
    const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    let targets = [];

    if (mentioned && Array.isArray(mentioned) && mentioned.length) {
      targets = mentioned;
    } else {
      const t = (targetInput || '').trim().split(/\s+/)[0];
      if (!t) {
        await safeSendMessage(groupJid, { text: 'Sebutkan nomor/mention yang ingin dikick.' }, { quoted: msg }).catch(()=>{});
        return;
      }
      const jid = t.includes('@') ? t : toJid(t);
      targets = [jid];
    }

    try {
      await sock.groupParticipantsUpdate(groupJid, targets, 'remove');
      await safeSendMessage(groupJid, { text: `Berhasil mengeluarkan: ${targets.map(j => `@${j.split('@')[0]}`).join(', ')}`, mentions: targets });
    } catch (e) {
      console.error('group remove error', e);
      await safeSendMessage(groupJid, { text: 'Gagal mengeluarkan anggota. Pastikan bot admin dan target valid.' }, { quoted: msg }).catch(()=>{});
    }
  } catch (err) {
    console.error('kickMemberFromGroup error', err);
    await safeSendMessage(groupJid, { text: 'Terjadi kesalahan saat mencoba mengeluarkan anggota.' }, { quoted: msg }).catch(()=>{});
  }
}


/* Server & UI */

const app = express();

const server = http.createServer(app);

const io = socketIo(server, { cors: { origin: '*' } });

app.use(basicAuth({

  users: { [WEB_USER]: WEB_PASS },

  challenge: true,

  realm: 'Nisa Bot Web UI',

}));

app.use(express.static('public'));

app.use(securexpress({
  secretKey: '12345678901234567890123456789012',
  enableEncryption: false,
  enableDDoS: true,
  enableScrapingGuard: true,
  enablePerformanceBoost: true,
  enableTrafficQueue: true,
  enableCDNAwareness: true,
  enablePromoHeader: true
}));

server.listen(PORT, () => console.log(`Web UI: http://localhost:${PORT}`));

/* Persistence & chat store */

const STORAGE_FILE = path.join(__dirname, 'chats.json');

const MAX_MESSAGES_PER_CHAT = 200;

let chats = new Map();

function loadStorage() {

  if (fs.existsSync(STORAGE_FILE)) {

    try {

      const data = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf-8'));

      chats = new Map(data);

      console.log(`Loaded ${chats.size} chats`);

    } catch (e) {

      console.error('Failed to load storage:', e);

    }

  }

}

function saveStorage() {

  try {

    fs.writeFileSync(STORAGE_FILE, JSON.stringify(Array.from(chats.entries()), null, 2));

  } catch (e) {

    console.error('Failed to save storage:', e);

  }

}

loadStorage();

process.on('SIGINT', () => { saveStorage(); process.exit(); });

process.on('SIGTERM', () => { saveStorage(); process.exit(); });

/* Socket helpers */

function getChatList() {

  return Array.from(chats.entries())

    .map(([id, c]) => ({ id, name: c.name, lastMessage: c.lastMessage || 'Tidak ada pesan', unread: c.unread || 0 }))

    .sort((a, b) => b.unread - a.unread || a.name.localeCompare(b.name));

}

function broadcastChatList() { io.emit('chat_list', getChatList()); }

function emitNewMessage(chatId, message) { io.emit('new_message', { chatId, message }); }

/* WebSocket events */

io.on('connection', (socket) => {

  console.log('Web client connected', socket.id);

  socket.emit('chat_list', getChatList());

  socket.on('request_chat_list', () => socket.emit('chat_list', getChatList()));

  socket.on('select_chat', (chatId) => {

    if (chats.has(chatId)) {

      const chat = chats.get(chatId);

      chat.unread = 0;

      socket.emit('chat_messages', { chatId, messages: chat.messages, name: chat.name });

      broadcastChatList();

    }

  });

  socket.on('send_message', async ({ chatId, text }) => {

    if (!chatId || !text) return;

    try {

      if (global.sock) await global.safeSendMessage(chatId, { text });

      const message = { text, fromMe: true, time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) };

      const chat = chats.get(chatId) ?? { name: chatId, messages: [], lastMessage: '', unread: 0 };

      chat.messages.push(message);

      if (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages.shift();

      chat.lastMessage = text.substring(0, 60);

      chats.set(chatId, chat);

      emitNewMessage(chatId, message);

      broadcastChatList();

    } catch (e) {

      console.error('send_message error:', e);

      socket.emit('error', { message: 'Gagal mengirim pesan.' });

    }

  });

  socket.on('send_interactive_buttons', async ({ chatId, text, footer, buttons }) => {

    if (!chatId) return;

    try {

      if (!global.sock) throw new Error('Socket not ready');

      const templateButtons = (buttons.data || []).map((b) => ({

        buttonId: b.id || (b.text || 'btn').slice(0, 40),

        buttonText: { displayText: b.text || 'Button' },

        type: 1

      }));

      await global.safeSendMessage(chatId, { text: text || 'Pilih', templateButtons });

      const previewText = `[Interactive Buttons]\n${text}\n${(buttons.data || []).map(b => `- ${b.text || b.text}`).join('\n')}`;

      const message = { text: previewText, fromMe: true, time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) };

      const chat = chats.get(chatId) ?? { name: chatId, messages: [], lastMessage: '', unread: 0 };

      chat.messages.push(message);

      if (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages.shift();

      chat.lastMessage = text.substring(0, 60);

      chats.set(chatId, chat);

      emitNewMessage(chatId, message);

      broadcastChatList();

    } catch (err) {

      console.error('send_interactive_buttons error:', err);

    }

  });

});

/* Rate limiting */

const userMessageTimestamps = new Map();

function isRateLimited(senderJid) {
  const now = Date.now();
  const last = userMessageTimestamps.get(senderJid) || 0;
  if (now - last < 1500) return true; // kena limit
  userMessageTimestamps.set(senderJid, now);
  return false; // aman
}



/* Message handling — allow group + fromMe (owner is bot itself) */

function handleMessages(sock) {

  return async (m) => {

    try {

      const msg = m.messages && m.messages[0];

      if (!msg || !msg.message || (msg.key && msg.key.remoteJid === 'status@broadcast')) return;

      const remoteJid = msg.key.remoteJid; // chat id (group or individual)

      const fromMe = !!msg.key.fromMe;

      const senderJid = msg.key.participant || msg.participant || msg.key.remoteJid; // actual sender

      // extract body from common message shapes

      const messageBody =

        msg.message.conversation ||

        msg.message.extendedTextMessage?.text ||

        msg.message.imageMessage?.caption ||

        msg.message.buttonsResponseMessage?.selectedDisplayText ||

        msg.message.templateButtonReplyMessage?.selectedId ||

        msg.message.listResponseMessage?.singleSelectReply?.selectedDisplayText ||

        null;

      if (!messageBody) return;

      // debug log

      console.log('Incoming message:', { remoteJid, senderJid, fromMe, body: messageBody });

if (isRateLimited(senderJid)) return;

// normalisasi body — deklarasikan SEKALI dan gunakan terus
const body = String(messageBody).trim();



// =====================
// COMMAND /tagall
// =====================

if (body.toLowerCase().startsWith('/tagall')) {

  // hanya grup whitelist
  if (!isAllowedGroup(remoteJid)) {
    console.log('Perintah /tagall tidak diizinkan di grup ini.');
    return;
  }

  // ambil teks SETELAH "/tagall"
  const argsText = body.slice(7).replace(/^\s+/, '');

  await handleTagAll(
    sock,
    remoteJid,
    senderJid,
    argsText,
    msg
  );

  return;
}



if (
  body.toLowerCase().startsWith('/s ') ||
  body.toLowerCase().startsWith('/stiker ')
) {
  // optional: batasi hanya grup whitelist kalau perlu
    if (!isAllowedGroup(remoteJid)) return;

  const text = body.split(/\s+/).slice(1).join(' ').trim();
  if (!text) {
    await safeSendMessage(remoteJid, { text: 'Gunakan: /stiker <teks>\nContoh: /stiker BRO?!' }, { quoted: msg }).catch(()=>{});
    return;
  }

  try {
    // buat sticker webp
    const webp = await createStickerFromText(text, {
      maxChars: 12,      // atur pembungkusan
      fontSize: 72,      // ukuran font
      padding: 40,       // padding di sekeliling teks
      width: 512         // ukuran final (standard sticker size)
    });

    // kirim sebagai sticker (Baileys mendukung field sticker: Buffer)
    await safeSendMessage(remoteJid, { sticker: webp }, { quoted: msg });
  } catch (e) {
    console.error('createSticker error', e);
  }
  return;
}

if (body.toLowerCase().startsWith('/add ')) {
  if (!isAllowedGroup(remoteJid)) {
    try {
      console.log('Perintah /add tidak diizinkan di grup ini.');
    } catch (e) {}
    return;
  }
  const arg = body.slice('/add '.length).trim();
  await addMemberToGroup(sock, remoteJid, arg, msg, senderJid);
  return;
}

if (body.toLowerCase().trim() === '/ping') {
  if (!isAllowedGroup(remoteJid)) return;

  await safeSendMessage(
    remoteJid,
    { text: 'reply berhasil!' },
    { quoted: msg }
  );
}

if (body.toLowerCase().trim() === '/guild') {
  if (!isAllowedGroup(remoteJid)) return;

  const guildId = process.env.ID_GUILD;
  const guildLink = `https://ffshare.garena.com/?region=ID&lang=ind&action=locate_clan&clan_id=${guildId}&version=OB51`;

  await safeSendMessage(
    remoteJid,
    {
      text: `ID Guild: ${guildId}\nLink: ${guildLink}`
    },
    { quoted: msg }
  );
}

if (body.toLowerCase() === '/menu') {

  if (!remoteJid.endsWith('@g.us')) return;
  if (!isAllowedGroup(remoteJid)) return;

  await safeSendMessage(
    remoteJid,
    { text: envText(MENU_MESSAGE) },
    { quoted: msg }
  );

  return;
}




if (body.toLowerCase().trim() === 'cn') {
  if (!isAllowedGroup(remoteJid)) return;

  await safeSendMessage(
    remoteJid,
    { text: 'NAME AVL' },
    { quoted: msg }
  );
}


if (body.toLowerCase().startsWith('/kick ')) {
  if (!isAllowedGroup(remoteJid)) {
    try {
      console.log('Perintah /kick tidak diizinkan di grup ini.');
    } catch (e) {}
    return;
  }
  const arg = body.slice('/kick '.length).trim();
  await kickMemberFromGroup(sock, remoteJid, arg, msg, senderJid);
  return;
}

      // store for UI

      // determine chat name (group subject / pushName / vCard / jid local-part)
let chatName = remoteJid; // fallback
try {
  if (remoteJid && remoteJid.endsWith('@g.us')) {
    try {
      const metadata = await sock.groupMetadata(remoteJid);
      chatName = metadata?.subject || msg.pushName || remoteJid;
    } catch (e) {
      chatName = msg.pushName || remoteJid;
    }
  } else {
    chatName =
      msg.pushName ||
      (msg.message && msg.message.contactMessage && parseVCardDisplayName(msg.message.contactMessage.vcard)) ||
      (remoteJid ? remoteJid.split('@')[0] : remoteJid);
  }
} catch (e) {
  console.error('Error resolving chat name', e);
  chatName = msg.pushName || remoteJid;
}

// ensure chat object exists
let chat = chats.get(remoteJid);
if (!chat) {
  chat = { name: chatName, messages: [], lastMessage: '', unread: 0 };
  chats.set(remoteJid, chat);
} else {
  // update name if changed/newly resolved
  if (chat.name !== chatName) chat.name = chatName;
}

// create new message and push
const newMsg = {
  text: messageBody,
  fromMe,
  sender: senderJid?.split('@')[0] || 'unknown',
  time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
};


chat.messages.push(newMsg);
if (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages.shift();
chat.lastMessage = String(messageBody).substring(0, 60);

if (!fromMe) chat.unread = (chat.unread || 0) + 1;

// persist & UI update
chats.set(remoteJid, chat);
emitNewMessage(remoteJid, newMsg);
broadcastChatList();

    } catch (err) {
      console.error('handleMessages error:', err);
    }
  };
}



/* Connection update & start */

let reconnectTimeout = null;

let isReconnecting = false;

function updateConnection(sock) {

  return async (update) => {

    try {

      if (update.qr) {

        try {

          const dataUrl = await qrcode.toDataURL(update.qr);

          io.emit('qr', dataUrl);

          try { qrcodeTerminal.generate(update.qr, { small: true }); } catch {}

        } catch (e) { console.error('QR generate error', e); }

      }

      if (update.connection) {

        const { connection, lastDisconnect } = update;

        if (connection === 'close') {

          const reason = (lastDisconnect?.error)?.output?.statusCode;

          if (reason !== DisconnectReason.loggedOut) {

            if (!isReconnecting) {

              isReconnecting = true;

              console.log('Connection closed, reconnecting...');

              if (reconnectTimeout) clearTimeout(reconnectTimeout);

              reconnectTimeout = setTimeout(() => startSock(), 10000);

            }

          } else {

            console.log('Connection closed. You are logged out.');

          }

        } else if (connection === 'open') {

          console.log('Connected (Baileys)');

          isReconnecting = false;

          if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }

          io.emit('ready');

        }

      }

    } catch (e) {

      console.error('updateConnection error', e);

    }

  };

}

async function startSock() {

  try {

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({

      version,

      auth: state,

      logger: P({ level: 'silent' }),

      printQRInTerminal: false,

      browser: ['nisa-bot', 'Web', '1.0.0'],

      syncFullHistory: false,

     markOnlineOnConnect: false,

     downloadHistory: false,

     emitOwnEvents: false,

     fireInitQueries: false,
 
     generateHighQualityLinkPreview: false,
     
     shouldIgnoreJid: jid => jid === 'status@broadcast',

     //⚙️ Koneksi lebih stabil
     connectTimeoutMs: 60_000,
     defaultQueryTimeoutMs: 60_000,
     keepAliveIntervalMs: 25_000
    });

    global.sock = sock;

    sock.ev.on('messages.upsert', handleMessages(sock));

    sock.ev.on('connection.update', updateConnection(sock));

    sock.ev.on('creds.update', saveCreds);

    console.log('Baileys socket started');
     
     
     
     
     //glw info
     
     // helper: kirim pesan terjadwal ke grup dan update UI/store
async function sendScheduledMessage(groupJid, text) {
  if (!groupJid) {
    console.warn('Scheduled group JID not configured.');
    return;
  }

  // pastikan socket tersedia dan siap
  const s = global.sock || sock;
  if (!s) {
    console.warn('WhatsApp socket not ready — scheduled message skipped.');
    return;
  }

  try {
    // kirim pesan (coba kirim sebagai plain text)
    await s.sendMessage(groupJid, { text });

    // tambahkan ke store lokal (mirip pesan keluar)
    const msgObj = {
      text,
      fromMe: true,
      time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    };

    let chat = chats.get(groupJid);
    if (!chat) {
      chat = { name: groupJid, messages: [], lastMessage: '', unread: 0 };
    }
    chat.messages.push(msgObj);
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages.shift();
    chat.lastMessage = String(text).substring(0, 60);
    chats.set(groupJid, chat);

    emitNewMessage(groupJid, msgObj);
    broadcastChatList();

    console.log(`Scheduled message sent to ${groupJid} at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('Failed to send scheduled message:', err);
  }
}

// schedule job (cron expression default sabtu 16:00)
// Jika ingin hanya mulai setelah connect, Anda bisa memindahkan pemanggilan cron.schedule
// ke dalam updateConnection ketika connection === 'open'
cron.schedule(CRON_EXPR, () => {
  console.log('Cron triggered:', CRON_EXPR, 'tz=', SCHEDULE_TZ);
  sendScheduledMessage(SCHEDULE_GROUP_JID, SCHEDULE_MSG);
}, {
  timezone: SCHEDULE_TZ
});
     
     
     
     //grup welcome
     
     // GANTI DENGAN ID GRUP TARGET
const targetGroup = SCHEDULE_GROUP_JID;

sock.ev.on('group-participants.update', async (anu) => {
    try {
        // cek grup
        if (anu.id !== targetGroup) return

        let metadata = await sock.groupMetadata(anu.id)

        // cek bot admin
        let botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net'
        
        for (let user of anu.participants) {

            // WELCOME
      if (anu.action === 'add') {

  const text = envText(WELCOME_MESSAGE).replace(
    /\@\{user\}/g,
    `@${user.split('@')[0]}`
  );

  await safeSendMessage(anu.id, {
    text,
    mentions: [user]
  });
}

            // OUT
            if (anu.action === 'remove') {

  const text = envText(OUT_MESSAGE).replace(
    /\@\{user\}/g,
    `@${user.split('@')[0]}`
  );

  await safeSendMessage(anu.id, {
    text,
    mentions: [user]
  });
}
        }
    } catch (e) {
        console.log(e)
    }
})

     
     
  } catch (err) {

    console.error('startSock error:', err);

    setTimeout(startSock, 10000);

  }

}

startSock();