import express from 'express';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { classifyText } from './classifier.service.js';
import { extractText } from './textExtraction.service.js';
import { checkLlmAvailable, warmUp, LLM_MODEL, LLM_SERVICE_URL } from './llm.service.js';

dotenv.config();
const app = express();
app.use(express.json({ limit: '15mb' }));

// Las rutas del backend se montan en /api (backend/src/app.js), asi que el
// webhook vive en /api/webhooks/worker-update. Se acepta BACKEND_URL con o sin
// el /api final: sin esto el worker manda los estados a un 404 y el usuario ve
// el analisis congelado sin ningun error visible.
const BACKEND_BASE = String(process.env.BACKEND_URL || '')
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');

const BACKEND_WEBHOOK_URL = BACKEND_BASE + '/api/webhooks/worker-update';

// La llave se valida al arrancar: si está mal, es mejor no levantar el worker
// que aceptar documentos y fallar al descifrarlos uno por uno.
function loadEncryptionKey() {
  const raw = process.env.WORKER_ENCRYPTION_KEY;

  if (!raw) {
    console.error('Falta WORKER_ENCRYPTION_KEY.');
    console.error('Genera una con:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }

  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    console.error('WORKER_ENCRYPTION_KEY debe ser exactamente 64 caracteres hexadecimales (32 bytes).');
    console.error(`Recibido: ${raw.length} caracteres. aes-256-gcm no acepta otra longitud.`);
    process.exit(1);
  }

  return Buffer.from(raw, 'hex');
}

const ENCRYPTION_KEY = loadEncryptionKey();

async function sendStatusUpdate(documentId, status, payload = {}) {
    try {
        await fetch(BACKEND_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-worker-token': process.env.WORKER_WEBHOOK_SECRET // Inyectar la llave
            },
            body: JSON.stringify({ documentId, status, ...payload })
        });
    } catch (e) {
        console.error(`Error enviando estado (Doc: ${documentId})`, e);
    }
}

/** Permite a Railway (y a ti) comprobar que el worker y la GPU están vivos. */
app.get('/health', async (_req, res) => {
    const llm = await checkLlmAvailable();
    res.status(llm.available ? 200 : 503).json({
        worker: 'ok',
        llm: llm.available ? 'ok' : 'no disponible',
        model: LLM_MODEL,
        reason: llm.reason,
    });
});

// El worker se publica por un tunel para que Railway lo alcance, asi que
// /api/analyze queda expuesto a internet. El payload va cifrado, pero sin
// token cualquiera puede encolar trabajo en la GPU y provocar webhooks.
function requireWorkerToken(req, res, next) {
    const esperado = process.env.WORKER_API_TOKEN;

    if (!esperado) {
        console.warn('WORKER_API_TOKEN no definido: /api/analyze esta SIN autenticacion.');
        return next();
    }

    const recibido = req.headers['x-worker-token'];

    if (typeof recibido !== 'string' || recibido.length !== esperado.length) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    if (!crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(esperado))) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    return next();
}

app.post('/api/analyze', requireWorkerToken, async (req, res) => {
    res.status(202).json({ message: 'Documento en procesamiento' });
    await procesarTrabajo(req.body);
});

/** Descifra, extrae, clasifica y reporta. Compartido por el bucle y el POST. */
async function procesarTrabajo(job) {
    const { documentId, userId, iv, authTag, fileData, subcriteria, format } = job;

    try {
        await sendStatusUpdate(documentId, 'RECEIVED_BY_ANALYZER');

        const initVector = Buffer.from(iv, 'hex');
        const tag = Buffer.from(authTag, 'hex');
        const encryptedBuffer = Buffer.from(fileData, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, initVector);
        decipher.setAuthTag(tag); // Validamos la integridad antes de hacer nada

        const decryptedFileBuffer = Buffer.concat([
            decipher.update(encryptedBuffer),
            decipher.final()
        ]);

        await sendStatusUpdate(documentId, 'EXTRACTING_CONTENT');

        // El Servicio A manda el archivo físico, no el texto. Un PDF o un DOCX
        // leído como utf-8 es binario ilegible, así que hay que extraerlo de
        // verdad. `format` es opcional: si no viene, se deduce de los bytes.
        const { text: textToAnalyze, format: detectado } = await extractText(
            decryptedFileBuffer,
            format
        );

        if (!textToAnalyze || !textToAnalyze.trim()) {
            throw new Error(
                `No se pudo extraer texto del documento (formato ${detectado}). ` +
                'Si es un PDF escaneado, necesita OCR.'
            );
        }

        console.log(`[Doc ${documentId}] ${detectado}, ${textToAnalyze.length} caracteres`);

        await sendStatusUpdate(documentId, 'ANALYZING_CONTENT');

        const started = Date.now();
        const result = await classifyText(textToAnalyze, subcriteria);
        console.log(
            `[Doc ${documentId}] ${result.subcriterion?.code ?? 'NO relevante'} ` +
            `en ${((Date.now() - started) / 1000).toFixed(1)}s`
        );

        await sendStatusUpdate(documentId, 'RECEIVING_RESULT');

        await sendStatusUpdate(documentId, 'COMPLETED', { result, userId });

    } catch (error) {
        console.error("Error en el Worker:", error);
        await sendStatusUpdate(documentId, 'ERROR', { error: error.message });
    }
}

// ─── Bucle de sondeo ──────────────────────────────────────────────────────────
//
// El worker pregunta al backend si hay trabajo en vez de esperar conexiones.
// Asi esta maquina no necesita IP estable, puertos abiertos, tunel ni VPN: solo
// salida HTTPS, que cualquier conexion domestica tiene.

// Sondeo adaptativo: rapido mientras hay actividad, lento cuando no la hay.
// A intervalo fijo de 5s son ~17.000 peticiones diarias, casi todas contra una
// cola vacia. Asi se bajan a unas 3.000 sin empeorar la latencia cuando
// realmente se esta usando: tras encontrar trabajo se vuelve al ritmo rapido.
const POLL_MIN_MS = Number(process.env.WORKER_POLL_MS || 2000);
const POLL_MAX_MS = Number(process.env.WORKER_POLL_MAX_MS || 30000);

// Cuanto se sigue sondeando rapido despues del ultimo trabajo.
const POLL_ACTIVE_MS = Number(process.env.WORKER_POLL_ACTIVE_MS || 120000);

const JOBS_URL = BACKEND_BASE + '/api/worker/jobs';

let sondeando = false;
// Arranca en modo activo: un worker recien encendido suele serlo porque
// alguien va a usarlo. Con 0 entraba directo al ritmo de reposo y el primer
// documento esperaba hasta 30s.
let ultimoTrabajo = Date.now();

function intervaloActual() {
    return Date.now() - ultimoTrabajo < POLL_ACTIVE_MS ? POLL_MIN_MS : POLL_MAX_MS;
}

function programarSondeo() {
    setTimeout(async () => {
        await sondearTrabajo();
        programarSondeo();
    }, intervaloActual());
}

async function sondearTrabajo() {
    // Un solo documento a la vez: la GPU no gana nada procesando en paralelo.
    if (sondeando) return;
    sondeando = true;

    try {
        const response = await fetch(JOBS_URL, {
            headers: { 'x-worker-token': process.env.WORKER_API_TOKEN || '' },
            signal: AbortSignal.timeout(60000),
        });

        // 204: no hay trabajo. Es el caso normal, no se registra.
        if (response.status === 204) return;

        if (!response.ok) {
            console.warn(`[sondeo] El backend respondio ${response.status}`);
            return;
        }

        const job = await response.json();
        ultimoTrabajo = Date.now();
        console.log(`[sondeo] Trabajo recibido: documento ${job.documentId}`);
        await procesarTrabajo(job);
    } catch (error) {
        // Backend caido o sin red: se reintenta en el siguiente ciclo.
        console.warn(`[sondeo] ${error.message}`);
    } finally {
        sondeando = false;
    }
}

// 4001 es el puerto que espera WORKER_URL en la configuración del backend.
const PORT = process.env.PORT || 4001;

app.listen(PORT, async () => {
    console.log(`Worker activo en el puerto ${PORT}`);

    const llm = await checkLlmAvailable();
    if (llm.available) {
        console.log(`LLM local listo: ${LLM_MODEL} en ${LLM_SERVICE_URL}`);
        try {
            const s = await warmUp();
            console.log(`Modelo precargado en VRAM (${s.toFixed(1)}s). Listo para recibir documentos.`);
        } catch (err) {
            console.warn(`No se pudo precargar el modelo: ${err.message}`);
        }
    } else {
        console.warn(`ATENCION: el LLM local no responde — ${llm.reason}`);
        console.warn('El worker va a caer al clasificador por keywords hasta que Ollama esté arriba.');
    }

    console.log(
        `Sondeando ${JOBS_URL} cada ${POLL_MIN_MS / 1000}s con actividad, ` +
        `${POLL_MAX_MS / 1000}s en reposo`
    );
    void sondearTrabajo();
    programarSondeo();
});
