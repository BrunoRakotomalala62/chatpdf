/* API Express — ChatPDF Scraper (exporté pour Vercel serverless et usage local)
 * Fonctionnalités exposées en JSON :
 *   - contenu scrapé des pages du site chatpdf.com/fr (home + outils)
 *   - chat avec un PDF (upload → analyse → questions/réponses avec références de pages)
 *   - métadonnées (tarifs, quotas, highlights)
 * Démarrage local : node server.js  (qui require ce module et écoute)
 * Déploiement Vercel : vercel.json route toutes les requêtes vers ce fichier. */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');

const cp = require('./lib/chatpdf');
const scraper = require('./lib/scraper');
const store = require('./lib/store');

const app = express();
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60 Mo max côté API ; plateforme Vercel : ~4,5 Mo par requête
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    if (ok) cb(null, true); else cb(new cp.ChatPdfError('Seuls les fichiers PDF sont acceptés', 'BAD_FILE_TYPE'));
  },
});

const cache = new Map(); // cache scraping contenu site
const cacheTtl = 10 * 60 * 1000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < cacheTtl) return hit.v;
  const v = await fn();
  cache.set(key, { v, t: Date.now() });
  return v;
}

/* ============================================================ utilitaires */
function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(err => {
    const status = err instanceof cp.ChatPdfError ? 502 : 500;
    res.status(status).json({
      ok: false, error: { code: err.code || 'INTERNAL', message: err.message || String(err) },
      details: err.details || undefined, ts: new Date().toISOString(),
    });
  });
}
const strip = cp.stripMarkup;

function chatSummary(chatId) {
  const chat = store.getChat(chatId);
  if (!chat) return null;
  return {
    id: chat.id, filename: chat.filename, sourceId: chat.sourceId, title: chat.title,
    createdAt: chat.createdAt, messageCount: chat.messages.length,
    messages: chat.messages.map(m => ({
      id: m.id, author: m.author, type: m.type, msg: m.msg, suggestedQuestions: m.suggestedQuestions || undefined,
      references: m.references || undefined, time: m.time,
    })),
  };
}

/* ============================================================ routes */
app.get('/', (req, res) => {
  res.json({
    service: 'ChatPDF Scraper REST API', version: '1.0.0', docs: '/docs', health: '/health',
    note: 'Miroir non-officiel des fonctionnalités de https://www.chatpdf.com/fr — usage éducatif/personnel.',
    routes: {
      'site (contenu scrapé)': { 'GET /site/home': 'Page d’accueil', 'GET /site/pages': 'Toutes les pages produit', 'GET /site/page?path=': 'Une page (ex: /youtube)' },
      'chat pdf (flux réel)': {
        'POST /pdfs/upload': 'Téléverser un PDF (multipart field=file) → analyse + accueil',
        'POST /chats/:chatId/messages': 'Poser une question {message} → réponse + références pages',
        'GET /chats/:chatId/messages': 'Historique JSON de la conversation',
        'GET /chats': 'Liste des conversations', 'DELETE /chats/:chatId': 'Supprimer une conversation',
        'POST /chats/:chatId/summarize': 'Raccourci « résume ce document »',
      },
      'métadonnées': { 'GET /account/meta': 'Offres tarifaires / quota (tRPC account.meta)', 'GET /sources/:sourceId/highlights': 'Zones surlignées d’une source' },
    },
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString(), uptime: process.uptime() }));

/* ---------------- contenu scrapé du site ---------------- */
app.get('/site/home', wrap(async (req, res) => {
  const lang = String(req.query.lang || 'fr').toLowerCase();
  const data = await cached('home:' + lang, () => scraper.scrapePage(lang, '/'));
  res.json({ ok: true, lang, ...data });
}));

app.get('/site/pages', wrap(async (req, res) => {
  const lang = String(req.query.lang || 'fr').toLowerCase();
  const pages = await cached('pages:' + lang, async () => {
    const list = await scraper.discoverPages(lang);
    const out = [];
    for (const p of list) { try { out.push(await scraper.scrapePage(lang, p)); } catch (e) { out.push({ path: p, error: e.message }); } }
    return out;
  });
  res.json({ ok: true, lang, count: pages.length, pages });
}));

app.get('/site/page', wrap(async (req, res) => {
  const lang = String(req.query.lang || 'fr').toLowerCase();
  const p = String(req.query.path || '/');
  if (!/^\/[a-z0-9-]*(\/[a-z0-9-]*)?$/i.test(p)) return res.status(400).json({ ok: false, error: 'path invalide' });
  const data = await cached(`page:${lang}:${p}`, () => scraper.scrapePage(lang, p));
  res.json({ ok: true, lang, ...data });
}));

/* ---------------- upload PDF + analyse ---------------- */
app.post('/pdfs/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Champ multipart "file" manquant (PDF requis)' });
  const pdf = req.file.buffer;
  if (pdf.slice(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ ok: false, error: 'Fichier non-PDF (en-tête %PDF- absent)' });
  const filename = req.file.originalname || `document_${crypto.randomBytes(3).toString('hex')}.pdf`;
  const lang = (req.headers['accept-language'] || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  const anonId = cp.makeAnonId();

  const { sourceId, chatId, storagePath } = await cp.uploadToFirebase(pdf, { anonId, language: lang + '-FR' });
  const proc = await cp.processUpload({ chatId, sourceId, storagePath, filename, doInitChat: true, anonId, language: lang });
  const chat = store.createChat({
    chatId, sourceId, filename, greeting: proc.greeting, suggestedQuestions: proc.suggestedQuestions, title: proc.title,
    anonId, languageCode: lang,
  });
  res.status(201).json({
    ok: true, chatId, sourceId, filename,
    analyzed: proc.events.some(e => e.type === 'analyzed'),
    pages: null, // le nombre de pages n'est pas exposé par le flux anonyme
    greeting: strip(proc.greeting), suggestedQuestions: proc.suggestedQuestions,
    messageId: chat.messages[0] ? chat.messages[0].id : null,
    messagesUrl: `/chats/${chatId}/messages`,
    quotaNote: 'Compte anonyme du site : quotas quotidiens applicables (réponse "unknownError" = quota dépassé).',
  });
}));

/* ---------------- poser une question ---------------- */
app.post('/chats/:chatId/messages', wrap(async (req, res) => {
  const chat = store.getChat(req.params.chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'chat inconnu' });
  const message = String((req.body && (req.body.message ?? req.body.question)) || '').trim();
  if (!message) return res.status(400).json({ ok: false, error: 'Champ "message" requis' });
  if (message.length > 10000) return res.status(400).json({ ok: false, error: 'message trop long (10 000 car.)' });

  const history = store.toHistory(chat);
  const qId = cp.nanoid(10);
  const out = await cp.ask({
    chatId: chat.id,
    history: [...history, { id: qId, author: 'u_', type: 'standard', msg: message, time: Date.now() }],
    userMsgId: qId, anonId: chat.anonId || undefined, language: chat.languageCode || 'fr',
  });
  const now = Date.now();
  store.addMessage(chat.id, { id: qId, author: 'u_', type: 'standard', msg: message, time: now });
  const aiMsg = {
    id: out.aiMsgId, author: 'AI', type: out.msgType || 'standard',
    msg: strip(out.answer), references: out.references, time: now + 1,
  };
  store.addMessage(chat.id, aiMsg);
  res.json({ ok: true, chatId: chat.id, answer: strip(out.answer), references: out.references, messageId: aiMsg.id, historyUrl: `/chats/${chat.id}/messages` });
}));

/* ---------------- résumé (raccourci) ---------------- */
app.post('/chats/:chatId/summarize', wrap(async (req, res) => {
  const chat = store.getChat(req.params.chatId);
  if (!chat) return res.status(404).json({ ok: false, error: 'chat inconnu' });
  const history = store.toHistory(chat);
  const qId = cp.nanoid(10);
  const out = await cp.summarizeDocument({ chatId: chat.id, history, userMsgId: qId, anonId: chat.anonId || undefined, language: chat.languageCode || 'fr' });
  const now = Date.now();
  store.addMessage(chat.id, { id: qId, author: 'u_', type: 'standard', msg: 'Résume ce document de manière structurée et concise, en français.', time: now });
  const aiMsg = { id: out.aiMsgId, author: 'AI', type: 'standard', msg: strip(out.answer), references: out.references, time: now + 1 };
  store.addMessage(chat.id, aiMsg);
  res.json({ ok: true, chatId: chat.id, summary: strip(out.answer), references: out.references, messageId: aiMsg.id });
}));

/* ---------------- historique / listing ---------------- */
app.get('/chats/:chatId/messages', (req, res) => {
  const s = chatSummary(req.params.chatId);
  if (!s) return res.status(404).json({ ok: false, error: 'chat inconnu' });
  res.json({ ok: true, ...s });
});
app.get('/chats', (req, res) => res.json({ ok: true, count: store.listChats().length, chats: store.listChats() }));
app.delete('/chats/:chatId', (req, res) => {
  if (!store.deleteChat(req.params.chatId)) return res.status(404).json({ ok: false, error: 'chat inconnu' });
  res.json({ ok: true, deleted: req.params.chatId });
});

/* ---------------- métadonnées distantes ---------------- */
app.get('/account/meta', wrap(async (req, res) => {
  const meta = await cached('account.meta', cp.accountMeta);
  res.json({ ok: true, ...meta, note: 'Offres tarifaires et devise selon la géolocalisation IP (source: tRPC account.meta de chatpdf.com).' });
}));

app.get('/sources/:sourceId/highlights', wrap(async (req, res) => {
  const data = await cp.sourceHighlights(req.params.sourceId);
  res.json({ ok: true, sourceId: req.params.sourceId, ...data });
}));

/* ---------------- docs statiques ---------------- */
const DOCS = require('./docs');
app.get('/docs', (req, res) => res.json(DOCS));
app.get('/openapi.json', (req, res) => res.json(DOCS.openapi));

module.exports = app;
