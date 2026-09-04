/* Lanceur local — démarre l'API Express (définie dans app.js) sur le port 8787 */
const app = require('./app');
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`[chatpdf-api] écoute sur http://localhost:${PORT}  (docs: /docs)`));
