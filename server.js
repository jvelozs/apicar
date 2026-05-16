// server.js — Proxy con bypass Cloudflare para VPS Windows
// Mantiene una página abierta en consultasecuador.com y dispara el
// fetch() desde su contexto para reutilizar el cf_clearance.

const express = require('express');
const cors    = require('cors');
const { connect } = require('puppeteer-real-browser');

// ============== CONFIG ==============
const PORT          = process.env.PORT || 3000;
const TTL_MS        = 60 * 60 * 1000;   // 1h caché
const CONSULTA_URL  = 'https://consultasecuador.com/';
const API_URL       = 'https://app3902.privynote.net/api/v1/transit/vehicle-owner';
const REGEX_PLACA   = /^([A-Z]{3}[0-9]{3,4}|[A-Z]{2}[0-9]{3}[A-Z]|[A-Z]{3}[0-9]{3}[A-Z])$/;
// Refresca la página cada 20 min para evitar que cf_clearance caduque
const REFRESH_MS    = 20 * 60 * 1000;

// ============== ESTADO ==============
const cache = new Map();
let browser = null;
let page    = null;
let busy    = Promise.resolve();
let lastRefresh = 0;

// ============== BROWSER ==============
async function abrirBrowser() {
  if (browser && page && !page.isClosed()) return;

  console.log('[browser] arrancando Chrome...');
  const cnx = await connect({
    headless: false,           // Windows VPS: dejar visible es más estable
    turnstile: true,           // Resuelve CF Turnstile automáticamente
    fingerprint: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });
  browser = cnx.browser;
  page    = cnx.page;

  await page.setViewport({ width: 1280, height: 800 });
  await navegarConChallenge();
  console.log('[browser] listo');
}

async function navegarConChallenge() {
  await page.goto(CONSULTA_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await new Promise(r => setTimeout(r, 8000)); // espera a que CF resuelva
  lastRefresh = Date.now();
}

async function refrescarSiHaceFalta() {
  if (Date.now() - lastRefresh > REFRESH_MS) {
    console.log('[browser] refrescando sesión...');
    await navegarConChallenge();
  }
}

async function consultarUpstream(placa) {
  await abrirBrowser();
  await refrescarSiHaceFalta();

  const tirar = () => page.evaluate(async (url, placa) => {
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

  // Si CF se reactivó, recarga y reintenta
  if (res.status === 403 || res.status === 503 ||
      (res.body && res.body.includes('Just a moment'))) {
    console.log('[cf] challenge reactivado, recargando...');
    await navegarConChallenge();
    res = await tirar();
  }
  return res;
}

// ============== EXPRESS ==============
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/propietario/:placa', async (req, res) => {
  const placa = (req.params.placa || '').toUpperCase().trim();

  if (!REGEX_PLACA.test(placa)) {
    return res.status(400).json({ success: false, error: 'Placa inválida' });
  }

  const hit = cache.get(placa);
  if (hit && Date.now() - hit.t < TTL_MS) {
    return res.json({ success: true, from_cache: true, placa, resultado: hit.data });
  }

  // Serializar (un fetch por vez sobre la misma página)
  const job = busy.then(async () => {
    try {
      const r = await consultarUpstream(placa);
      if (r.status >= 200 && r.status < 300) {
        const json = JSON.parse(r.body);
        const normal = json.data ? json : { data: json };
        cache.set(placa, { t: Date.now(), data: normal });
        return { ok: true, data: normal };
      }
      return { ok: false, status: r.status, body: (r.body || '').slice(0, 250) };
    } catch (err) {
      console.error('[error]', err.message);
      try { await browser?.close(); } catch {}
      browser = page = null;
      return { ok: false, error: err.message };
    }
  });
  busy = job.catch(() => {});

  const out = await job;
  if (out.ok) {
    res.json({ success: true, from_cache: false, placa, resultado: out.data });
  } else {
    res.status(502).json({
      success: false,
      error:   out.error || `Upstream ${out.status}`,
      detalle: out.body
    });
  }
});

app.get('/health', (_, res) => res.json({
  ok: true,
  browser:    !!(browser && page && !page.isClosed()),
  cache_size: cache.size,
  uptime_min: Math.round(process.uptime() / 60),
  last_refresh_min: lastRefresh ? Math.round((Date.now() - lastRefresh) / 60000) : null
}));

// ============== ARRANQUE ==============
app.listen(PORT, async () => {
  console.log(`API escuchando en http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  try { await abrirBrowser(); }
  catch (e) { console.error('Falla arranque browser:', e.message); }
});

// Cierre limpio
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, async () => {
    console.log('\nCerrando...');
    try { await browser?.close(); } catch {}
    process.exit(0);
  });
});
