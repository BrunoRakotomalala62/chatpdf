/* Test flux complet en HTTP direct (sans navigateur) */
const https = require('https');
const fs = require('fs');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function nanoid(len = 21) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
function req(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opt = { method, hostname: u.hostname, path: u.pathname + u.search, headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', origin: 'https://www.chatpdf.com', referer: 'https://www.chatpdf.com/fr', 'content-type': 'application/json', ...headers } };
    const r = https.request(opt, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const sourceId = 'src_' + nanoid();
  const chatId = 'cha_' + nanoid();
  const storagePath = `incoming_uploads/${today}/${sourceId}.pdf`;
  const pdf = fs.readFileSync('/tmp/doc_test.pdf');

  console.log('chatId:', chatId, '\nsourceId:', sourceId);

  // 1) Upload Firebase : multipart/related (metadata JSON + binaire PDF)
  const boundary = 'b' + nanoid(24);
  const meta = {
    sourceId, chatId, appVersion: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    userAgent: 'Mozilla/5.0', timeZone: 'Europe/Paris', language: 'fr', userId: nanoid(24), platform: 'Linux x86_64',
  };
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: binary\r\n\r\n`));
  parts.push(pdf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const fbUrl = `https://firebasestorage.googleapis.com/v0/b/autoclass-chatpdf/o?name=${encodeURIComponent(storagePath)}`;
  const fb = await req(fbUrl, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}`, 'content-length': body.length, 'x-firebase-storage-version': '2' }, body });
  console.log('FIREBASE status:', fb.status, fb.body.slice(0, 300));

  // 2) processUpload via bigstream
  const bsBody = JSON.stringify({ type: 'processUpload', chatId, sourceId, storagePath, doInitChat: true, filename: 'doc_test.pdf', userInfo: { localTimeHour: 9, fullName: '' } });
  console.log('== POST /bigstream ==');
  const bs = await req('https://webapi.chatpdf.com/bigstream', { method: 'POST', body: bsBody });
  console.log('status:', bs.status, 'ct:', bs.headers['content-type']);
  console.log(bs.body.slice(0, 2000));
})().catch(e => console.error('ERR', e));
