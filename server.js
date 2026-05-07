// server.js  — apicar-irjp en Render
// Endpoint: GET /api/propietario/:placa
// Mantiene la misma firma para que tu frontend no cambie.

const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors()); // permite llamadas desde tu HTML
app.use(express.json());

// Caché simple en memoria (TTL 1h) para reducir llamadas al upstream
const cache = new Map();
const TTL_MS = 60 * 60 * 1000;

const UPSTREAM_URL = 'https://app3902.privynote.net/api/v1/transit/vehicle-owner';

app.get('/api/propietario/:placa', async (req, res) => {
  const placa = (req.params.placa || '').toUpperCase().trim();

  // Validación básica (auto + moto + placas con sufijo)
  const reValida = /^([A-Z]{3}[0-9]{3,4}|[A-Z]{2}[0-9]{3}[A-Z]|[A-Z]{3}[0-9]{3}[A-Z])$/;
  if (!reValida.test(placa)) {
    return res.status(400).json({ success: false, error: 'Placa inválida' });
  }

  // Caché
  const hit = cache.get(placa);
  if (hit && Date.now() - hit.t < TTL_MS) {
    return res.json({
      success: true,
      from_cache: true,
      placa,
      resultado: hit.data
    });
  }

  try {
    const upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-US,es-419;q=0.9,es;q=0.8,en;q=0.7',
        'Origin':  'https://consultasecuador.com',
        'Referer': 'https://consultasecuador.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({ placa })
    });

    if (!upstream.ok) {
      // Devolver el código del upstream (404 si no existe la placa, etc.)
      const texto = await upstream.text();
      return res.status(upstream.status).json({
        success: false,
        error: `Upstream ${upstream.status}`,
        detalle: texto.slice(0, 200)
      });
    }

    const data = await upstream.json();

    // Guardar en caché
    cache.set(placa, { t: Date.now(), data });

    res.json({
      success: true,
      from_cache: false,
      placa,
      resultado: data
    });

  } catch (err) {
    console.error('Error consultando upstream:', err);
    res.status(502).json({
      success: false,
      error: 'No se pudo contactar al servidor de placas',
      detalle: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en :${PORT}`));
