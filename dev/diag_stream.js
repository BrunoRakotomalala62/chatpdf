/* Diagnostique /stream : variantes de payload */
const https = require('https');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const nanoid = (len = 21) => { let s = ''; for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return s; };
function req(url, { method = 'POST', headers = {}, body, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, timeout, headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept-language': 'fr-FR,fr;q=0.9', origin: 'https://www.chatpdf.com', referer: 'https://www.chatpdf.com/fr', 'content-type': 'application/json', ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject);
    if (body) r.write(body); r.end();
  });
}

(async () => {
  // upload + processUpload (réutilise le code OK)
  const today = new Date().toISOString().slice(0, 10);
  const sourceId = 'src_' + nanoid(), chatId = 'cha_' + nanoid();
  const storagePath = `incoming_uploads/${today}/${sourceId}.pdf`;
  const fs = require('fs'); const pdf = fs.readFileSync('/tmp/doc_test.pdf');
  const boundary = 'b' + nanoid(24);
  const meta = { contentType: 'application/pdf', sourceId, chatId, appVersion: '5.0', userAgent: 'Mozilla/5.0', timeZone: 'Europe/Paris', language: 'fr', userId: nanoid(24), platform: 'Linux' };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`), pdf,
    Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const fb = await req(`https://firebasestorage.googleapis.com/v0/b/autoclass-chatpdf/o?name=${encodeURIComponent(storagePath)}`,
    { headers: { 'content-type': `multipart/related; boundary=${boundary}`, 'x-goog-upload-protocol': 'multipart' }, body });
  console.log('FB', fb.status, fb.body.slice(0, 80));
  const bsBody = JSON.stringify({ type: 'processUpload', chatId, sourceId, storagePath, doInitChat: false, filename: 'doc_test.pdf', userInfo: { localTimeHour: 9, fullName: '' } });
  const bs = await req('https://webapi.chatpdf.com/bigstream', { body: bsBody });
  console.log('BIGSTREAM status', bs.status, 'len', bs.body.length, 'head:', bs.body.slice(0, 120).replace(/\n/g, ' | '));

  // V1 : history vide (doInitChat:false donc pas de greeting), juste la question
  const variants = [
    { name: 'V1-history-vide', body: { type: 'chat', chatId, history: [], userInfo: { localTimeHour: 9, fullName: '' }, premiumModel: false } },
    { name: 'V2-sans-msgMega', body: { type: 'chat', chatId, history: [{ id: nanoid(10), author: 'u_', type: 'standard', msg: 'Bonjour, quel est le capital de la societe ?', time: Date.now() }], userInfo: { localTimeHour: 9, fullName: '' }, premiumModel: false } },
    { name: 'V3-navigateur-complet', body: { type: 'chat', chatId, history: [{ id: nanoid(10), author: 'u_', type: 'standard', msg: 'Bonjour, quel est le capital de la societe ?', time: Date.now() }], msgMega: { ai: { id: 'MY' + nanoid(8) }, user: { id: '' } }, experiments: { '12-2025-chat-model': 'gemini-2-5-flash-sep' }, userInfo: { localTimeHour: 9, fullName: '' }, premiumModel: false } },
  ];
  for (const v of variants) {
    const r = await req('https://webapi.chatpdf.com/stream', { body: JSON.stringify(v.body) });
    console.log(v.name, '=>', r.status, JSON.stringify(r.body.slice(0, 150)));
  }
})().catch(e => console.error('ERR', e.message));
