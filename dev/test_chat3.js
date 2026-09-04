/* Test chat /stream en HTTP direct */
const https = require('https');
const fs = require('fs');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const nanoid = (len = 21) => { let s = ''; for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return s; };
function req(url, { method = 'GET', headers = {}, body, timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opt = { method, hostname: u.hostname, path: u.pathname + u.search, timeout, headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8', origin: 'https://www.chatpdf.com', referer: 'https://www.chatpdf.com/fr', 'content-type': 'application/json', ...headers } };
    const r = https.request(opt, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  // 1) recréer un chat complet : upload + processUpload
  const today = new Date().toISOString().slice(0, 10);
  const sourceId = 'src_' + nanoid();
  const chatId = 'cha_' + nanoid();
  const storagePath = `incoming_uploads/${today}/${sourceId}.pdf`;
  const pdf = fs.readFileSync('/tmp/doc_test.pdf');
  const boundary = 'b' + nanoid(24);
  const meta = { contentType: 'application/pdf', sourceId, chatId, appVersion: '5.0', userAgent: 'Mozilla/5.0', timeZone: 'Europe/Paris', language: 'fr', userId: nanoid(24), platform: 'Linux' };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: binary\r\n\r\n`), pdf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const fb = await req(`https://firebasestorage.googleapis.com/v0/b/autoclass-chatpdf/o?name=${encodeURIComponent(storagePath)}`,
    { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}`, 'content-length': body.length, 'x-goog-upload-protocol': 'multipart' }, body });
  console.log('FIREBASE', fb.status, fb.body.slice(0,400));

  const bsBody = JSON.stringify({ type: 'processUpload', chatId, sourceId, storagePath, doInitChat: true, filename: 'doc_test.pdf', userInfo: { localTimeHour: 9, fullName: '' } });
  const bs = await req('https://webapi.chatpdf.com/bigstream', { method: 'POST', body: bsBody });
  const lines = bs.body.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  const greeting = lines.filter(l => l.type === 'textPart').map(l => l.text).join('');
  console.log('GREETING:', greeting.slice(0, 200));
  const qs = [...greeting.matchAll(/<q>(.*?)<\/q>/g)].map(m => m[1]);
  console.log('SUGGESTED:', JSON.stringify(qs));

  // 2) poser une question
  const qId = nanoid(10), aId = nanoid(10);
  const history = [
    { id: aId, author: 'AI', type: 'standard', msg: greeting, time: Date.now() - 1000 },
    { id: qId, author: 'u_', type: 'standard', msg: 'Quel est le capital de la societe et ou est le siege social ? Reponds en une phrase.', time: Date.now() },
  ];
  const streamBody = JSON.stringify({ type: 'chat', chatId, history,
    msgMega: { ai: { id: 'MY' + nanoid(8) }, user: { id: qId } },
    experiments: { '12-2025-chat-model': 'gemini-2-5-flash-sep' }, userInfo: { localTimeHour: 9, fullName: '' }, premiumModel: false });
  console.log('== POST /stream ==');
  const st = await req('https://webapi.chatpdf.com/stream', { method: 'POST', body: streamBody });
  console.log('status:', st.status, 'ct:', st.headers['content-type'], 'len:', st.body.length);
  console.log(st.body.slice(0, 3000));
})().catch(e => console.error('ERR', e));
