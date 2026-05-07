// server.js  — apicar-irjp en Render
// Bypass de Cloudflare con puppeteer-real-browser.
// Mantiene una página abierta en consultasecuador.com y dispara
// fetch() desde su contexto, así reutiliza el cf_clearance.

const express = require('express');
const cors    = require('cors');
const { connect } = require('puppeteer-real-browser');

const app = express();
app.use(cors());
app.use(express.json());

const TTL_MS       = 60 * 60 * 1000;          // 1h caché
const CONSULTA_URL = 'https://consultasecuador.com/';
const API_URL      = 'https://app3902.privynote.net/api/v1/transit/vehicle-owner';
const REGEX_PLACA  = /^([A-Z]{3}[0-9]{3,4}|[A-Z]{2}[0-9]{3}[A-Z]|[A-Z]{3}[0-9]{3}[A-Z])$/;

const cache = new Map();
let browser = null;
let page    = null;
let busy    = Promise.resolve(); // cadena para serializar peticiones

// ------------------------------------------------------------------
async function abrirBrowser() {
  if (browser && page && !page.isClosed()) return;

  console.log('[browser] arrancando...');
  const cnx = await connect({
    headless: true,
    turnstile: true,             // resuelve Cloudflare Turnstile automáticamente
    fingerprint: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // crítico en Render (poco /dev/shm)
      '--single-process',
      '--no-zygote'
    ]
  });
  browser = cnx.browser;
  page    = cnx.page;

  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(CONSULTA_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Espera a que el challenge se resuelva
  await new Promise(r => setTimeout(r, 6000));
  console.log('[browser] listo');
}

async function consultarUpstream(placa) {
  await abrirBrowser();

  // Hacemos el fetch DESDE la página: hereda cookies, TLS y origin
  const tirar = async () => page.evaluate(async (url, placa) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ placa })
    });
    return { status: r.status, body: await r.text() };
  }, API_URL, placa);

  let res = await tirar();

  // Si Cloudflare se reactivó, recargamos y reintentamos una vez
  if (res.status === 403 || res.status === 503) {
    console.log('[cf] challenge reactivado, recargando...');
    await page.goto(CONSULTA_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 6000));
    res = await tirar();
  }
  return res;
}

// ------------------------------------------------------------------
app.get('/api/propietario/:placa', async (req, res) => {
  const placa = (req.params.placa || '').toUpperCase().trim();

  if (!REGEX_PLACA.test(placa)) {
    return res.status(400).json({ success: false, error: 'Placa inválida' });
  }

  const hit = cache.get(placa);
  if (hit && Date.now() - hit.t < TTL_MS) {
    return res.json({ success: true, from_cache: true, placa, resultado: hit.data });
  }

  // Serializar: una sola petición a la vez sobre la misma página
  const job = busy.then(async () => {
    try {
      const r = await consultarUpstream(placa);
      if (r.status >= 200 && r.status < 300) {
        const json = JSON.parse(r.body);
        // Normalizar: el upstream devuelve {value, name} sin envolver
        const normal = json.data ? json : { data: json };
        cache.set(placa, { t: Date.now(), data: normal });
        return { ok: true, data: normal };
      }
      return { ok: false, status: r.status, body: r.body.slice(0, 250) };
    } catch (err) {
      // Si la página murió, forzamos reapertura en la próxima
      try { await browser?.close(); } catch {}
      browser = page = null;
      return { ok: false, error: err.message };
    }
  });
  busy = job.catch(() => {}); // mantiene la cadena viva

  const out = await job;
  if (out.ok) {
    res.json({ success: true, from_cache: false, placa, resultado: out.data });
  } else {
    res.status(502).json({
      success: false,
      error: out.error || `Upstream ${out.status}`,
      detalle: out.body
    });
  }
});

app.get('/health', (_, res) => res.json({
  ok: true,
  browser: !!(browser && page && !page.isClosed()),
  cache: cache.size
}));

// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API en :${PORT}`);
  try { await abrirBrowser(); }
  catch (e) { console.error('Fallo arranque browser:', e.message); }
});

process.on('SIGTERM', async () => { try { await browser?.close(); } catch {} process.exit(0); });
