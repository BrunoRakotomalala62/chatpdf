/* Moteur ChatPDF — réplique le flux interne de chatpdf.com en HTTP pur :
 *   1) upload du PDF vers Firebase Storage (bucket autoclass-chatpdf)
 *   2) POST /bigstream  {type:"processUpload"}  → NDJSON (sourceCreated, analyzed, greeting…)
 *   3) POST /stream     {type:"chat"}           → NDJSON (chatHeader, textPart*)
 *   4) tRPC GET /trpc/v1/* pour les métadonnées (account.meta, source.getHighlights…)
 * Découvert par analyse des bundles Next.js + capture réseau du flux navigateur. */
const https = require('https');

const WEBAPI = 'https://webapi.chatpdf.com';
const FIREBASE_BUCKET = 'autoclass-chatpdf';
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MODEL_EXP = { '12-2025-chat-model': false }; // = modèle par défaut côté serveur (comme le navigateur)

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const nanoid = (len = 21) => { let s = ''; for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return s; };
/** Identité anonyme du site : anonId = "p" + 21 chars (stocké en localStorage cp_anon_id) ;
 *  le header atoken envoyé à webapi.chatpdf.com = anonId.slice(1) */
const makeAnonId = () => 'p' + nanoid(21);
let defaultAnonId = makeAnonId();
function apiHeaders({ anonId, language } = {}) {
  return { atoken: (anonId || defaultAnonId).slice(1), 'language-code': language || 'fr' };
}

function httpReq(url, { method = 'GET', headers = {}, body, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search, timeout,
      headers: (u.hostname === 'webapi.chatpdf.com'
        ? { 'user-agent': CHROME_UA, 'accept-language': 'fr-FR,fr;q=0.9', 'accept': '*/*',
            'origin': 'https://www.chatpdf.com', 'referer': 'https://www.chatpdf.com/',
            'content-type': 'application/json', ...apiHeaders(headers), ...headers }
        : { 'user-agent': CHROME_UA, 'accept': '*/*', 'origin': 'https://www.chatpdf.com',
            'referer': 'https://www.chatpdf.com/', ...headers }),
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseNdjson(text) {
  return text.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return { type: 'raw', raw: l }; } });
}
/** Transforme le NDJSON en { events, error } en s'arrêtant sur une erreur */
function drain(events) {
  const err = events.find(e => e.type === 'unknownError' || e.type === 'error');
  return { events, error: err ? (err.message || err.type) : null };
}

class ChatPdfError extends Error {
  constructor(message, code = 'CHATPDF_ERROR', details = null) { super(message); this.code = code; this.details = details; }
}

/** Étape 1 : upload du PDF (buffer) vers Firebase Storage, comme le fait le SDK web.
 *  Renvoie { sourceId, chatId, storagePath }. */
async function uploadToFirebase(pdfBuffer, { chatId, sourceId, anonId, language } = {}) {
  const chatId2 = chatId || 'cha_' + nanoid();
  const sourceId2 = sourceId || 'src_' + nanoid();
  const anonId2 = anonId || defaultAnonId;
  const today = new Date().toISOString().slice(0, 10);
  const storagePath = `incoming_uploads/${today}/${sourceId2}.pdf`;
  const boundary = nanoid(24);

  const meta = {
    contentType: 'application/pdf', sourceId: sourceId2, chatId: chatId2,
    appVersion: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    userAgent: CHROME_UA, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    language: language || 'fr-FR', userId: anonId2, platform: 'Linux x86_64',
  };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    pdfBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const url = `https://firebasestorage.googleapis.com/v0/b/${FIREBASE_BUCKET}/o?name=${encodeURIComponent(storagePath)}`;
  const res = await httpReq(url, { method: 'POST', timeout: 60000, headers: {
    'content-type': `multipart/related; boundary=${boundary}`, 'content-length': body.length,
    'x-goog-upload-protocol': 'multipart',
  }, body });
  if (res.status !== 200) throw new ChatPdfError(`Upload Firebase refusé (HTTP ${res.status})`, 'UPLOAD_FAILED', res.body.slice(0, 400));
  let stored;
  try { stored = JSON.parse(res.body); } catch { stored = null; }
  return { sourceId: sourceId2, chatId: chatId2, storagePath, stored, anonId: anonId2 };
}

/** Étape 2 : POST /bigstream type=processUpload → analyse du PDF + message de bienvenue.
 *  Renvoie { events, greeting, suggestedQuestions, title } */
async function processUpload({ chatId, sourceId, storagePath, filename, doInitChat = true, anonId, language }) {
  const body = JSON.stringify({
    type: 'processUpload', chatId, sourceId, storagePath, doInitChat,
    filename, userInfo: { localTimeHour: new Date().getHours(), fullName: '' },
  });
  const res = await httpReq(`${WEBAPI}/bigstream`, { method: 'POST', body, timeout: 120000, anonId, language });
  if (res.status !== 200) throw new ChatPdfError(`bigstream HTTP ${res.status}`, 'BIGSTREAM_HTTP', res.body.slice(0, 300));
  const { events, error } = drain(parseNdjson(res.body));
  if (error) throw new ChatPdfError(error, 'PROCESS_UPLOAD_REJECTED', events);
  const greeting = events.filter(e => e.type === 'textPart').map(e => e.text).join('');
  const suggestedQuestions = [...greeting.matchAll(/<q>(.*?)<\/q>/g)].map(m => m[1]);
  const titleEvt = events.find(e => e.type === 'chatTitle');
  return { events, greeting, suggestedQuestions, title: titleEvt ? titleEvt.title : null };
}

/** Pose une question (nouveau message utilisateur) — POST /stream type=chat.
 *  history : messages précédents [{id, author:'AI'|'u_', type:'standard', msg, time}]
 *  Renvoie { answer, references, raw } */
async function ask({ chatId, history, aiMsgId, userMsgId, msgType = 'standard', anonId, language }) {
  const aiId = aiMsgId || nanoid(10);
  const userId = userMsgId || nanoid(10);
  const body = JSON.stringify({
    type: 'chat', chatId, history,
    msgMega: { ai: { id: aiId }, user: { id: userId } },
    experiments: MODEL_EXP, userInfo: { localTimeHour: new Date().getHours(), fullName: '' }, premiumModel: false,
  });
  const res = await httpReq(`${WEBAPI}/stream`, { method: 'POST', body, timeout: 180000, anonId, language });
  if (res.status !== 200) throw new ChatPdfError(`stream HTTP ${res.status}`, 'STREAM_HTTP', res.body.slice(0, 300));
  const { events, error } = drain(parseNdjson(res.body));
  if (error) throw new ChatPdfError(error, 'CHAT_REJECTED', events);

  let answer = '', chunks = [], areas = [], msgTypeOut = msgType;
  for (const e of events) {
    if (e.type === 'textPart') answer += e.text;
    else if (e.type === 'chatHeader') { if (e.chunks) chunks = e.chunks; if (e.areas) areas = e.areas; if (e.msgType) msgTypeOut = e.msgType; }
  }
  const references = parseReferences(answer, chunks, areas);
  return { answer, references, events, aiMsgId: aiId, userMsgId: userId, msgType: msgTypeOut };
}

/** Les citations [T1]… → références structurées {marker, page, sourceId} */
function parseReferences(text, chunks, areas) {
  const refs = [];
  const re = /\[T(\d+)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10);
    const chunk = chunks && chunks[n - 1];
    const area = areas && areas.find(a => a.chunk === (chunk ? chunk.i : n - 1));
    refs.push({
      marker: m[0], number: n, sourceId: (chunk && chunk.s) || (area && area.sourceId) || null,
      page: area ? area.page + 1 : null,   // page 0-indexée côté serveur → 1 pour l'affichage
    });
  }
  return refs;
}

/** Nettoyage : texte sans balises <q> ni marqueurs de citation */
function stripMarkup(text) {
  return text.replace(/<q>(.*?)<\/q>/g, '$1').replace(/\[T\d+\]/g, '').trim();
}

/** tRPC account.meta → pays, offres tarifaires, identifiant anonyme */
async function accountMeta() {
  const input = encodeURIComponent('{"0":{"sync":false}}');
  const res = await httpReq(`${WEBAPI}/trpc/v1/account.meta?batch=1&input=${input}`);
  if (res.status !== 200) throw new ChatPdfError(`account.meta HTTP ${res.status}`, 'TRPC_HTTP');
  const arr = JSON.parse(res.body);
  return arr[0].result.data;
}

/** tRPC source.getHighlights → zones surlignées d'une source */
async function sourceHighlights(sourceId) {
  const input = encodeURIComponent(`{"0":{"sourceId":"${sourceId}"}}`);
  const res = await httpReq(`${WEBAPI}/trpc/v1/source.getHighlights?batch=1&input=${input}`);
  if (res.status !== 200) throw new ChatPdfError(`getHighlights HTTP ${res.status}`, 'TRPC_HTTP');
  const arr = JSON.parse(res.body);
  return arr[0].result.data;
}

/** Résumé du document : le site le fait en demandant un résumé ; on l'expose comme raccourci */
async function summarizeDocument({ chatId, history, userMsgId, anonId, language }) {
  const msg = 'Résume ce document de manière structurée et concise, en français.';
  const qId = userMsgId || nanoid(10);
  return ask({ chatId, history: [...history, { id: qId, author: 'u_', type: 'standard', msg, time: Date.now() }], userMsgId: qId, anonId, language });
}

module.exports = { uploadToFirebase, processUpload, ask, summarizeDocument, accountMeta, sourceHighlights, parseReferences, stripMarkup, nanoid, makeAnonId, ChatPdfError };
