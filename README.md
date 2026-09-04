# ChatPDF Scraper REST API

Miroir **REST non-officiel** des fonctionnalités du site [https://www.chatpdf.com/fr](https://www.chatpdf.com/fr).
Le moteur réplique en HTTP pur le flux interne réellement utilisé par le site (découvert par analyse des bundles Next.js et capture réseau du flux navigateur) et le scraping extrait le contenu de chaque page produit. Toutes les réponses sont en **JSON**.

> ⚠️ Usage éducatif / personnel. Respectez les CGU de ChatPDF et ses quotas anonymes. Aucune clé API n'est requise.

---

## Démarrage rapide

```bash
npm install          # express, multer, cheerio (puppeteer-core : dev uniquement)
node server.js       # écoute sur http://localhost:8787 (env PORT pour changer)
```

**Déploiement Vercel** (config `vercel.json` incluse — une seule fonction serverless `app.js`) :

```bash
vercel --prod        # ou : importez le dépôt GitHub dans Vercel
```

> ⚠️ Limites plateforme : Vercel plafonne le corps des requêtes des fonctions serverless
> (~4,5 Mo) → l'upload de PDF volumineux y échouera ; le filesystem est éphémère
> (lecture seule) → l'historique des conversations passe en **mémoire** (perdu à chaque
> redémarrage d'instance). En local, tout est persisté dans `data/store.json`.

Test rapide :

```bash
curl http://localhost:8787/health
curl "http://localhost:8787/site/page?lang=fr&path=/youtube"
```

## 1. Contenu scrapé du site (toutes les pages → JSON)

Le site expose (locale `fr`) les outils : **chat PDF, résumé PDF, détecteur d'IA, rédacteur IA, chat YouTube, Scholar/recherche, flashcards, diaporamas**. Chaque page est scrapée et restructurée en JSON (titre, meta, H1/H2, paragraphes, liens internes).

| Méthode | Route | Description |
|---|---|---|
| GET | `/site/home?lang=fr` | Page d'accueil scrapée |
| GET | `/site/pages?lang=fr` | **Toutes** les pages produit découvertes (home + outils) |
| GET | `/site/page?lang=fr&path=/youtube` | Une page précise (`/pdf-resume`, `/ai-detector`, `/ai-detector/check`, `/writer`, `/scholar`, `/cartas`, …) |

Réponse type (`/site/page?path=/youtube`) :

```json
{ "ok": true, "lang": "fr", "url": "https://www.chatpdf.com/fr/youtube", "title": "Chat with YouTube",
  "h1": ["Discute avec YouTube"], "headings": [{"tag":"h2","text":"..."}],
  "paragraphs": ["Colle simplement une URL YouTube…"], "links": [{"href":"/fr","text":"ChatPDF"}],
  "toolLinks": [...], "scrapedAt": "..." }
```

## 2. Fonctionnalité principale : discuter avec un PDF

Le flux interne répliqué (aucun navigateur requis) :
1. **Upload** : le PDF est envoyé en `multipart/related` vers Firebase Storage (`autoclass-chatpdf`) avec des IDs `chat_`/`src_` générés côté client — exactement comme le fait le site.
2. **Analyse** : `POST https://webapi.chatpdf.com/bigstream` (`{"type":"processUpload"}`) — flux NDJSON `sourceCreated → analyzed → chatHeader → textPart…`.
3. **Chat** : `POST https://webapi.chatpdf.com/stream` (`{"type":"chat"}`) — flux NDJSON avec `textPart` (tokens) + `chatHeader` (zones → **numéros de page** des citations `[T1]…`).

| Méthode | Route | Description |
|---|---|---|
| POST | `/pdfs/upload` | Multipart champ `file` (PDF ≤ 60 Mo) → `{chatId, sourceId, greeting, suggestedQuestions}` |
| POST | `/chats/:chatId/messages` | Body `{"message":"…"}` → `{answer, references:[{marker,page,sourceId}]}` |
| POST | `/chats/:chatId/summarize` | Raccourci « résume ce document » |
| GET | `/chats/:chatId/messages` | Historique complet (contexte conservé par l'API) |
| GET | `/chats` | Liste des conversations |
| DELETE | `/chats/:chatId` | Supprime une conversation |

### Exemple complet

```bash
# 1. upload
curl -F "file=@rapport.pdf" http://localhost:8787/pdfs/upload
# → { "ok": true, "chatId": "cha_Xx…", "sourceId": "src_Yy…", "greeting": "…",
#     "suggestedQuestions": ["Résume ce rapport", …] }

# 2. question (contexte conservé automatiquement)
curl -H "content-type: application/json" \
     -d '{"message":"Quel est le capital de la société ?"}' \
     http://localhost:8787/chats/cha_Xx…/messages
# → { "ok": true, "answer": "Le capital est de 100 000 euros [T1].",
#     "references": [{"marker":"[T1]","number":1,"sourceId":"src_Yy…","page":1}] }

# 3. historique
curl http://localhost:8787/chats/cha_Xx…/messages
```

### Exemple réel (déploiement Vercel testé)

```bash
# 1. upload → analyse + accueil (français) + questions suggérées
curl -H "accept-language: fr-FR" -F "file=@rapport.pdf" https://chatpdf-wine.vercel.app/pdfs/upload
# → { "ok": true, "chatId": "cha_BK222…", "sourceId": "src_5IkI…",
#     "greeting": "Salut, content de te revoir ! Ce rapport annuel présente un aperçu de la société Exemple SAS. …",
#     "suggestedQuestions": ["Résume ce rapport", …] }

# 2. question → réponse + référence de page
curl -H "content-type: application/json" \
     -d '{"message":"Quel est le capital de la societe, ou se trouve le siege social ? Reponds en 2 phrases."}' \
     https://chatpdf-wine.vercel.app/chats/cha_BK222…/messages
# → { "ok": true,
#     "answer": "La société Exemple SAS a un capital social de 100 000 euros, et son siège social est situé à Paris, France. Elle emploie 45 personnes réparties dans trois bureaux : Paris, Lyon et Bordeaux .",
#     "references": [{ "marker": "[T1]", "number": 1, "sourceId": "src_5IkI…", "page": 1 }] }

# 3. résumé structuré
curl -X POST https://chatpdf-wine.vercel.app/chats/cha_BK222…/summarize
```

> **Note technique** : les appels à `webapi.chatpdf.com` exigent deux en-têtes que le site envoie via son
> identité anonyme (`cp_anon_id` en localStorage, format `p` + 21 caractères) :
> `atoken: <id sans le p>` et `language-code: fr`. Sans eux, `/stream` répond
> `{"type":"unknownError"}` même quand l'upload passe. L'API génère une identité par conversation
> (`anonId` stocké dans le chat) et la réutilise pour chaque question — c'est ce qui débloque le chat.

## 3. Métadonnées distantes

| Méthode | Route | Source |
|---|---|---|
| GET | `/account/meta` | tRPC `account.meta` — offres tarifaires, devise, pays IP |
| GET | `/sources/:sourceId/highlights` | tRPC `source.getHighlights` — zones surlignées |

## Erreurs & limites connues

- **Quota anonyme** : le service gratuit du site applique des quotas quotidiens par IP. En dépassement, le site répond `{"type":"unknownError"}` → l'API renvoie `HTTP 502` avec `code: CHAT_REJECTED | PROCESS_UPLOAD_REJECTED | UPLOAD_FAILED`. Attendez la fenêtre de réinitialisation (typiquement ≤ 1 h) ou changez d'IP.
- **Historique** : le backend anonyme ne stocke rien → l'API persiste les conversations dans `data/store.json` (c'est ce contexte qui est renvoyé à chaque question).
- Le nombre de pages et l'extraction PDF du flux anonyme ne sont pas exposés par le site.
- Langue du message d'accueil : selon géolocalisation IP du site ; les réponses suivent la langue de vos questions.

## Architecture / fichiers

```
chatpdf/
├── vercel.json        # déploiement Vercel (fonction serverless app.js)
├── app.js             # API Express (exportée — utilisée par Vercel)
├── server.js          # lanceur local : node server.js (port 8787)
├── docs.js            # documentation + extrait OpenAPI (/docs, /openapi.json)
├── lib/
│   ├── chatpdf.js     # moteur : upload Firebase + bigstream/stream (NDJSON) + tRPC
│   ├── scraper.js     # scraping des pages du site (cheerio + flux RSC)
│   └── store.js       # persistance JSON (mémoire pure sur Vercel, fichier en local)
├── data/store.json    # conversations locales (créé au fil de l'eau)
└── dev/               # outils de reverse-engineering (captures réseau, tests)
```

## Reverse-engineering (comment ça a été trouvé)

1. Les bundles Next.js de `chatpdf.com` révèlent `webapi.chatpdf.com`, `e.chatpdf.com` et le bucket `autoclass-chatpdf`.
2. Capture réseau (puppeteer + CDP `Network.*`) du flux réel : upload → `bigstream` → `stream`.
3. Relecture du chunk `7251-*.js` : le multipart d'upload Firebase exige le header `X-Goog-Upload-Protocol: multipart` et `Content-Type: application/pdf` sur la partie média — sans quoi le fichier stocké est corrompu (`size` = JSON seul).
4. Validation : upload + analyse + réponse avec références de pages fonctionnent en HTTP pur (test_*.js).
