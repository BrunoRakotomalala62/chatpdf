/* Scraping de contenu du site chatpdf.com — pages produit → JSON structuré */
const cheerio = require('cheerio');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Routes produit du site (miroir du menu "Outils" + home), par locale
const DEFAULT_PAGES = {
  en: ['/', '/ai-detector', '/ai-detector/check', '/pdf-resume', '/youtube', '/scholar', '/writer', '/flashcard', '/slides'],
};

function cleanText(t) {
  return t.replace(/\s+/g, ' ').trim();
}
function cleanLines(t) {
  return t.split('\n').map(s => s.trim()).filter(Boolean);
}

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'fr-FR,fr;q=0.9', 'accept': 'text/html' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return { html: await r.text(), finalUrl: r.url, status: r.status };
}

/** Extrait le JSON "flight" Next.js (RSC) pour obtenir le contenu exact rendu */
function extractFlightStrings(html) {
  const out = [];
  const re = /"(?:title|description|heading|text|label|body|subtitle|content)":"([^"\\]{8,})"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"'));
  return out;
}

/** Scrape une page (locale + chemin) → JSON */
async function scrapePage(locale, path) {
  const url = `https://www.chatpdf.com/${locale}${path === '/' ? '' : path}`;
  const { html, finalUrl, status } = await fetchHtml(url);
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,canvas,img,iframe,link').remove();

  const meta = {};
  $('meta').each((_, el) => {
    const name = $(el).attr('name') || $(el).attr('property');
    if (name) meta[name] = $(el).attr('content');
  });

  const headings = [];
  $('h1,h2,h3').each((_, el) => headings.push({ tag: el.tagName.toLowerCase(), text: cleanText($(el).text()) }));

  const paragraphs = [];
  $('p,li').each((_, el) => {
    const t = cleanText($(el).text());
    if (t.length > 12 && !paragraphs.includes(t)) paragraphs.push(t);
  });

  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || /^(\/|https?:|#|mailto:)/.test(href) === false) return;
    const text = cleanText($(el).text());
    if (text.length < 120) links.push({ href, text });
  });
  const seen = new Set();
  const uniqLinks = links.filter(l => { const k = l.href + l.text; if (seen.has(k)) return false; seen.add(k); return true; });

  const toolLinks = uniqLinks.filter(l => l.href.startsWith(`/${locale}/`) || (l.href.startsWith('/') && !l.href.includes('.')));

  return {
    url, finalUrl, status, title: $('title').first().text() || null, metaDescription: meta.description || null,
    h1: headings.filter(h => h.tag === 'h1').map(h => h.text), headings,
    paragraphs: paragraphs.slice(0, 60),
    links: uniqLinks.slice(0, 120),
    toolLinks,
    flight: extractFlightStrings(html).slice(0, 40),
    scrapedAt: new Date().toISOString(),
  };
}

/** Liste des pages d'une locale à partir de la page d'accueil (liens internes) */
async function discoverPages(locale) {
  const { html } = await fetchHtml(`https://www.chatpdf.com/${locale}`);
  const $ = cheerio.load(html);
  const pages = new Set(['/']);
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(new RegExp(`^/${locale}(/[a-z0-9-]*(/[a-z0-9-]*)?)?$`));
    if (m) pages.add(m[1] || '/');
  });
  return [...pages];
}

module.exports = { scrapePage, discoverPages, fetchHtml, DEFAULT_PAGES };
