
// server.js
// API PROXY estable con rate limit + cache + axios

const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = 3000;

/*
====================================
CONFIGURACIÓN
====================================
*/

const CACHE_TIEMPO = 1000 * 60 * 30; // 30 minutos
const LIMITE_CONSULTAS = 5; // máximo por IP
const VENTANA_TIEMPO = 1000 * 60 * 1; // 1 minuto

/*
====================================
MEMORIA TEMPORAL
====================================
*/

const cache = new Map();
const rateLimit = new Map();

/*
====================================
MIDDLEWARES
====================================
*/

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*
====================================
FUNCIÓN RATE LIMIT
====================================
*/

function verificarRateLimit(ip) {
  const ahora = Date.now();

  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, {
      count: 1,
      startTime: ahora
    });
    return true;
  }

  const userData = rateLimit.get(ip);

  if (ahora - userData.startTime > VENTANA_TIEMPO) {
    rateLimit.set(ip, {
      count: 1,
      startTime: ahora
    });
    return true;
  }

  if (userData.count >= LIMITE_CONSULTAS) {
    return false;
  }

  userData.count++;
  return true;
}

/*
====================================
RUTA PRINCIPAL
====================================
*/

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "API de consulta funcionando",
    endpoint: "/api/propietario/:placa",
    rate_limit: `${LIMITE_CONSULTAS} consultas por minuto`,
    cache: "30 minutos"
  });
});

/*
====================================
API CONSULTA POR PLACA
====================================
*/

app.get("/api/propietario/:placa", async (req, res) => {
  try {
    const ip = req.ip;
    const placa = req.params.placa.toUpperCase().trim();

    /*
    ============================
    VALIDAR RATE LIMIT
    ============================
    */

    if (!verificarRateLimit(ip)) {
      return res.status(429).json({
        success: false,
        message: "Demasiadas consultas. Espere 1 minuto."
      });
    }

    /*
    ============================
    VALIDAR PLACA
    ============================
    */

    if (!placa) {
      return res.status(400).json({
        success: false,
        message: "Debe enviar una placa válida"
      });
    }

    /*
    ============================
    REVISAR CACHE
    ============================
    */

    if (cache.has(placa)) {
      const cachedData = cache.get(placa);

      if (Date.now() - cachedData.timestamp < CACHE_TIEMPO) {
        return res.json({
          success: true,
          from_cache: true,
          placa,
          resultado: cachedData.data
        });
      }

      cache.delete(placa);
    }

    /*
    ============================
    CONSULTA API EXTERNA
    ============================
    */

    const response = await axios.post(
      "https://app3902.privynote.net/api/v1/transit/vehicle-owner",
      {
        placa: placa
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": "https://consultasecuador.com/"
        },
        timeout: 30000
      }
    );

    /*
    ============================
    GUARDAR EN CACHE
    ============================
    */

    cache.set(placa, {
      data: response.data,
      timestamp: Date.now()
    });

    /*
    ============================
    RESPUESTA FINAL
    ============================
    */

    res.json({
      success: true,
      from_cache: false,
      placa,
      resultado: response.data
    });

  } catch (error) {
    console.error("ERROR:", error.message);

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

/*
====================================
INICIAR SERVIDOR
====================================
*/

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});

