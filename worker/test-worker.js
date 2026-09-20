// Prueba de integración del worker, sin backend ni Railway.
//
//   node test-worker.js <archivo>
//
// Hace lo mismo que el Servicio A: levanta un receptor de webhooks, cifra el
// archivo con aes-256-gcm y lo envía a /api/analyze. Imprime cada cambio de
// estado a medida que llega, así se ve dónde se rompe el flujo si algo falla.
//
// Requiere el worker corriendo con BACKEND_URL apuntando a este receptor:
//   BACKEND_URL=http://127.0.0.1:4999 npm start

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';

const WORKER_URL = process.env.WORKER_URL || 'http://127.0.0.1:4001';
const WEBHOOK_PORT = Number(process.env.TEST_WEBHOOK_PORT || 4999);
const KEY = process.env.WORKER_ENCRYPTION_KEY;

const file = process.argv[2];

if (!file) {
  console.error('Uso: node test-worker.js <archivo.pdf|docx|xlsx>');
  process.exit(1);
}

if (!KEY || !/^[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error('WORKER_ENCRYPTION_KEY debe ser 64 caracteres hex, y la misma que usa el worker.');
  process.exit(1);
}

// Subcriterios mínimos para la prueba (en producción los manda el backend).
const SUBCRITERIA = [
  { id: 1, code: '9.1.1', name: 'Institucionalidad de la calidad', description: 'Existe una política de aseguramiento interno de la calidad y responsables de su implementación.', keywords: ['política de calidad'] },
  { id: 2, code: '9.1.2', name: 'Monitoreo del desempeño', description: 'La universidad recoge y procesa información sobre los resultados de su desempeño y la usa para identificar áreas a mejorar.', keywords: ['indicadores', 'retención'] },
  { id: 3, code: '9.1.3', name: 'Transparencia y acceso a la información', description: 'La información sobre el desempeño institucional es accesible para directivos y unidades.', keywords: ['transparencia'] },
  { id: 4, code: '9.2.1', name: 'Formalización de mecanismos e indicadores', description: 'Mecanismos formalizados y sistemas de información para gestionar la calidad: manuales, reglamentos, KPI.', keywords: ['manual'] },
  { id: 5, code: '9.2.2', name: 'Instalación de una cultura de calidad transversal', description: 'Cultura de calidad con participación de todos los estamentos.', keywords: ['cultura de calidad'] },
  { id: 6, code: '9.3.1', name: 'Autorregulación autónoma y madurez del sistema', description: 'Planes de mejora cerrados, presupuesto ejecutado, auditorías externas al sistema.', keywords: ['autorregulación'] },
  { id: 7, code: '9.3.2', name: 'Compromiso y coherencia estamental total', description: 'Cada estamento evidencia compromiso con la cultura de calidad.', keywords: ['compromiso estamental'] },
];

const started = Date.now();
const seg = () => ((Date.now() - started) / 1000).toFixed(1).padStart(5);

const receptor = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    try {
      const { status, result, error } = JSON.parse(body);
      console.log(`  ${seg()}s  ${status}`);

      if (status === 'ERROR') {
        console.log(`\nEl worker reportó un error:\n  ${error}\n`);
        cerrar(1);
      }

      if (status === 'COMPLETED') {
        console.log('\n=== RESULTADO ===');
        if (result?.relevant) {
          console.log(`Subcriterio : ${result.subcriterion?.code} ${result.subcriterion?.name}`);
          console.log(`Confianza   : ${result.confidence}`);
        } else {
          console.log('No relevante para el Criterio 9');
        }
        console.log(`Justificación: ${result?.justification}`);
        if (result?.evidenceFragment) console.log(`Cita        : "${result.evidenceFragment}"`);
        cerrar(0);
      }
    } catch (err) {
      console.error('Webhook ilegible:', err.message);
    }
  });
});

function cerrar(code) {
  receptor.close();
  process.exitCode = code;
}

receptor.listen(WEBHOOK_PORT, '127.0.0.1', async () => {
  console.log(`Receptor de webhooks en http://127.0.0.1:${WEBHOOK_PORT}`);
  console.log(`Enviando ${file} a ${WORKER_URL}\n`);

  try {
    const fileBuffer = await fs.readFile(file);

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
    const encrypted = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);

    const response = await fetch(`${WORKER_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentId: 999,
        userId: 1,
        iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        fileData: encrypted.toString('base64'),
        subcriteria: SUBCRITERIA,
      }),
    });

    console.log(`Worker respondió ${response.status} — esperando webhooks:\n`);
  } catch (err) {
    console.error(`No se pudo contactar al worker: ${err.message}`);
    cerrar(1);
  }
});
