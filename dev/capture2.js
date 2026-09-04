/* Capture v2 : mapping requestId -> url, corps de réponses stream + JSON */
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const OUT = '/tmp/netlog2.json';
const PDF = '/tmp/doc_test.pdf';
const QUESTION = 'Quel est le capital de la societe et ou se trouve le siege social ? Reponds en une phrase.';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=fr-FR'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
  const client = await page.createCDPSession();
  await client.send('Network.enable');

  const urlById = {};
  const events = [];
  const want = u => /webapi\.chatpdf\.com|firebasestorage|e\.chatpdf\.com/.test(u);
  client.on('Network.requestWillBeSent', e => {
    urlById[e.requestId] = e.request.url;
    if (want(e.request.url)) events.push({ t: 'req', url: e.request.url, method: e.request.method,
      headers: e.request.headers, postData: e.request.postData ? e.request.postData.slice(0, 3000) : undefined });
  });
  client.on('Network.responseReceived', e => {
    const u = e.response.url;
    if (want(u)) events.push({ t: 'res', url: u, status: e.response.status, mime: e.response.mimeType, headers: e.response.headers });
  });
  client.on('Network.loadingFinished', async e => {
    const u = urlById[e.requestId] || '';
    if (!want(u)) return;
    try {
      const resp = await client.send('Network.getResponseBody', { requestId: e.requestId });
      if (resp && resp.body) events.push({ t: 'body', url: u, base64: resp.base64Encoded, body: resp.body.slice(0, 60000) });
    } catch (err) {}
  });

  const logs = [];
  page.on('pageerror', e => logs.push('PAGEERROR: ' + String(e).slice(0, 400)));

  await page.goto('https://www.chatpdf.com/fr', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2000));
  // vérifier un éventuel captcha
  const hasCf = await page.evaluate(() => !!document.querySelector('#challenge-running, .cf-challenge, iframe[src*=challenges]'));
  console.log('CAPTCHA-CF?', hasCf);
  const input = await page.$('input[type=file]');
  if (!input) { console.log('NO FILE INPUT'); console.log(JSON.stringify(logs)); }
  else {
    await input.uploadFile(PDF);
    // attendre la fin du processing upload (la sidebar affiche le nom puis on peut chatter)
    await new Promise(r => setTimeout(r, 18000));
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 2500));
    console.log('STATE1:', JSON.stringify(txt.slice(0, 900)));
    const ta = await page.$('textarea');
    if (ta) {
      await ta.type(QUESTION, { delay: 12 });
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 35000));
      const chat = await page.evaluate(() => document.body.innerText.slice(0, 4000));
      console.log('STATE2:', JSON.stringify(chat.slice(-2200)));
      // récupérer éventuels éléments de citations
      const cites = await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => /page|p\./i.test((e.getAttribute && e.getAttribute('aria-label'))||'') ).length);
      console.log('CITES aria:', cites);
    }
  }
  await new Promise(r => setTimeout(r, 2000));
  fs.writeFileSync(OUT, JSON.stringify({ events, logs }, null, 1));
  await browser.close();
  console.log('saved', OUT, 'n_events=', events.length);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(1); });
