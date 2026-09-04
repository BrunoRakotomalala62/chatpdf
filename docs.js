/* Documentation de service (JSON simple + extrait OpenAPI) */
module.exports = {
  name: 'ChatPDF Scraper REST API',
  version: '1.0.0',
  description: 'Miroir REST non-officiel des fonctionnalités du site https://www.chatpdf.com/fr — le moteur réplique le flux interne (upload Firebase Storage + endpoints webapi.chatpdf.com) et le scraping extrait le contenu des pages produit. Usage éducatif/personnel : respectez les CGU du site et ses quotas.',
  baseUrl: 'http://localhost:8787',
  endpoints: [
    { method: 'GET', path: '/', desc: 'Catalogue des routes' },
    { method: 'GET', path: '/health', desc: 'État du service' },
    { method: 'GET', path: '/docs', desc: 'Cette documentation' },
    { method: 'GET', path: '/openapi.json', desc: 'Description OpenAPI' },
    { method: 'GET', path: '/site/home?lang=fr', desc: 'Contenu scrapé de la page d’accueil (titre, H1, paragraphes, liens, sections)' },
    { method: 'GET', path: '/site/pages?lang=fr', desc: 'Contenu scrapé de toutes les pages produit découvertes (ai-detector, pdf-resume, youtube, writer, scholar, cartes-memoire-ia, diaporama-ia…)', example: '/site/pages?lang=fr' },
    { method: 'GET', path: '/site/page?lang=fr&path=/youtube', desc: 'Contenu scrapé d’une page précise (ex: /pdf-resume, /ai-detector, /youtube, /writer…)' },
    { method: 'POST', path: '/pdfs/upload', desc: 'Upload d’un PDF (multipart, champ « file ») → analyse + message d’accueil + questions suggérées. Renvoie chatId + sourceId.', example: 'curl -F "file=@doc.pdf" http://localhost:8787/pdfs/upload' },
    { method: 'POST', path: '/chats/:chatId/messages', desc: 'Poser une question — body JSON {message}. Renvoie answer + references (page/source des citations [T..])', example: 'curl -H "content-type: application/json" -d \'{"message":"Quel est le capital ?"}\' http://localhost:8787/chats/cha_xxx/messages' },
    { method: 'POST', path: '/chats/:chatId/summarize', desc: 'Raccourci « résume ce document » (contexte complet conservé)' },
    { method: 'GET', path: '/chats/:chatId/messages', desc: 'Historique JSON complet de la conversation (contexte conservé par l’API)' },
    { method: 'GET', path: '/chats', desc: 'Liste des conversations' },
    { method: 'DELETE', path: '/chats/:chatId', desc: 'Supprime une conversation locale' },
    { method: 'GET', path: '/account/meta', desc: 'Offres tarifaires/quotas vus par le site (tRPC account.meta)' },
    { method: 'GET', path: '/sources/:sourceId/highlights', desc: 'Zones surlignées d’une source (tRPC source.getHighlights)' },
  ],
  notes: [
    'Le service anonyme du site applique des quotas quotidiens : en cas de dépassement, bigstream/stream répondent {"type":"unknownError"} → l’API renvoie HTTP 502 code CHAT_REJECTED/PROCESS_UPLOAD_REJECTED.',
    'L’historique des conversations est stocké localement (data/store.json) car le backend anonyme du site ne le conserve pas — c’est ce contexte qui est renvoyé à /stream à chaque question.',
    'La langue du message d’accueil suit la géolocalisation IP ; les réponses suivent la langue de la question.',
    'Aucune clé API requise : le flux réplique exactement celui du site (IDs chat_/src_ générés côté client, upload multipart/related vers firebasestorage.googleapis.com, NDJSON streamé sur webapi.chatpdf.com/bigstream et /stream).',
  ],
  openapi: {
    openapi: '3.0.0',
    info: { title: 'ChatPDF Scraper REST API', version: '1.0.0', description: 'Miroir non-officiel — voir /docs' },
    paths: {
      '/pdfs/upload': { post: { summary: 'Upload PDF + analyse', requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } } } }, responses: { '201': { description: 'Analyse lancée : {chatId, sourceId, greeting, suggestedQuestions}' }, '502': { description: 'Quota/erreur du site distant' } } } },
      '/chats/{chatId}/messages': { post: { summary: 'Poser une question', parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } } }, responses: { '200': { description: '{answer, references:[{marker,page,sourceId}]}' } } } },
      '/chats/{chatId}/messages': { get: { summary: 'Historique de conversation', parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Messages + références' } } } },
    },
  },
};
