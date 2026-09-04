/* Store simple : persistance JSON des conversations créées via l'API.
 * Le backend ChatPDF anonyme ne conserve pas l'historique : c'est notre API qui
 * garde le contexte (messages, sources, références) pour rejouer /stream. */
const fs = require('fs');
const path = require('path');
const { nanoid } = require('./chatpdf');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { chats: {} }; }
}
let db = load();
let dirty = false;
let memoryOnly = false; // passe en mémoire pure si le FS est en lecture seule (Vercel serverless)
function save() {
  if (memoryOnly) { dirty = false; return; }
  try {
    dirty = false;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    memoryOnly = true;
    dirty = false;
  }
}
function persist() { if (dirty) save(); }
setInterval(persist, 3000).unref();
process.on('exit', persist);

function createChat({ chatId, sourceId, filename, greeting, suggestedQuestions, title }) {
  const id = chatId || 'cha_' + nanoid();
  const chat = {
    id, createdAt: new Date().toISOString(),
    sourceId, filename, title: title || filename || null,
    aiMessageId: null,
    messages: [],
  };
  if (greeting) {
    chat.messages.push({ id: nanoid(10), author: 'AI', type: 'greeting', msg: greeting, suggestedQuestions, time: Date.now() });
  }
  db.chats[id] = chat;
  dirty = true;
  return chat;
}

function getChat(chatId) { return db.chats[chatId] || null; }
function listChats() {
  return Object.values(db.chats).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map(c => ({
    id: c.id, filename: c.filename, title: c.title, sourceId: c.sourceId, createdAt: c.createdAt, messageCount: c.messages.length,
  }));
}
function addMessage(chatId, msg) {
  const c = db.chats[chatId];
  if (!c) return null;
  c.messages.push(msg);
  dirty = true;
  return msg;
}
function deleteChat(chatId) { const ok = delete db.chats[chatId]; if (ok) dirty = true; return ok; }

/** Transforme les messages stockés en `history` attendu par POST /stream */
function toHistory(chat) {
  return chat.messages.map(m => ({
    id: m.id, author: m.author === 'AI' ? 'AI' : 'u_', type: m.type || 'standard',
    msg: m.msg, time: m.time,
  }));
}

module.exports = { createChat, getChat, listChats, addMessage, deleteChat, toHistory };
