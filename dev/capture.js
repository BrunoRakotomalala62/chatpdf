/* Capture le trafic réseau réel de chatpdf.com (upload PDF + chat) */
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const OUT = process.argv[2] || '/tmp/netlog.json';
const PDF = '/tmp/sample_doc.pdf';
const QUESTION = process.argv[3] || 'Quel est le capital de la societe ? Reponds en une phrase.';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--lang=fr-FR', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

  const client = await page.createCDPSession();
  await client.send('Network.enable');
  const events = [];
  client.on('Network.requestWillBeSent', e => {
    if (/chatpdf\.com|chatgpt|openai|anthropic|googleapis|stripe|analytics|tralut/.test(e.request.url)) {
      events.push({
        t: 'req', ts: Date.now(),
        url: e.request.url,
        method: e.request.method,
        headers: e.request.headers,
        postData: e.request.postData ? e.request.postData.slice(0, 2000) : undefined,
      });
    }
  });
  client.on('Network.responseReceived', e => {
    if (/chatpdf\.com/.test(e.response.url)) {
      events.push({ t: 'res', ts: Date.now(), url: e.response.url, status: e.response.status, mime: e.response.mimeType });
    }
  });
  // réponse JSON utile
  client.on('Network.loadingFinished', async e => {
    try {
      const resp = await client.send('Network.getResponseBody', { requestId: e.requestId });
      if (resp && resp.body && resp.body.length < 200000 && /chatpdf\.com/.test(e.url || '')) {
        events.push({ t: 'body', url: e.url || '', body: resp.body.slice(0, 4000) });
      }
    } catch (err) { /* opaques (pdfs) */ }
  });

  const logs = [];
  page.on('console', m => logs.push(m.text().slice(0, 300)));
  page.on('pageerror', e => logs.push('PAGEERROR: ' + String(e).slice(0, 300)));

  console.log('== navigation ==');
  await page.goto('https://www.chatpdf.com/fr', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2500));
  // détection captcha / obstacle
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('BODYTEXT:', JSON.stringify(bodyText.slice(0, 600)));
  fs.writeFileSync('/tmp/step1_home.html', await page.content());

  const input = await page.$('input[type=file]');
  if (!input) { console.log('PAS DE INPUT FILE TROUVE'); console.log(logs.slice(0, 30).join('\n')); }
  else {
    console.log('== upload ==');
    await input.uploadFile(PDF);
    await new Promise(r => setTimeout(r, 12000));
    const after = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log('AFTER UPLOAD:', JSON.stringify(after.slice(0, 800)));
    fs.writeFileSync('/tmp/step2_after_upload.html', await page.content());
  }

  // tenter de poser une question dans la zone de chat
  const ta = await page.$('textarea');
  if (ta) {
    console.log('== question ==');
    await ta.type(QUESTION, { delay: 15 });
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 25000));
    const chat = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    console.log('CHAT AFTER:', JSON.stringify(chat.slice(-1800)));
    fs.writeFileSync('/tmp/step3_after_chat.html', await page.content());
  } else {
    console.log('PAS DE TEXTAREA');
    const hs = await page.evaluate(() => [...document.querySelectorAll('h1,h2,h3,button')].map(e => e.tagName + ':' + (e.innerText||'').slice(0,80)).slice(0, 40));
    console.log('HEADERS:', JSON.stringify(hs, null, 1));
  }
  await new Promise(r => setTimeout(r, 3000));

  fs.writeFileSync(OUT, JSON.stringify({ events, logs }, null, 1));
  await browser.close();
  console.log('== saved', OUT, 'events:', events.length);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
