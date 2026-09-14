<<<<<<< HEAD
import express from 'express';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { classifyText } from './classifier.service.js'; 

dotenv.config();
const app = express();
app.use(express.json({ limit: '15mb' }));

const BACKEND_WEBHOOK_URL = process.env.BACKEND_URL + '/webhooks/worker-update'; 
const ENCRYPTION_KEY = Buffer.from(process.env.WORKER_ENCRYPTION_KEY, 'hex');

async function sendStatusUpdate(documentId, status, payload = {}) {
    try {
        await fetch(BACKEND_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId, status, ...payload })
        });
    } catch (e) {
        console.error(`Error enviando estado (Doc: ${documentId})`, e);
    }
}

app.post('/api/analyze', async (req, res) => {
    // AHORA RECIBIMOS LOS SUBCRITERIOS DIRECTAMENTE DESDE EL SERVICIO A
    const { documentId, userId, iv, fileData, subcriteria } = req.body;

    res.status(202).json({ message: 'Documento en procesamiento' });

    try {
        await sendStatusUpdate(documentId, 'RECEIVED_BY_ANALYZER');

        const initVector = Buffer.from(iv, 'hex');
        const encryptedBuffer = Buffer.from(fileData, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, initVector);
        
        const decryptedFileBuffer = Buffer.concat([
            decipher.update(encryptedBuffer),
            decipher.final()
        ]);

        await sendStatusUpdate(documentId, 'EXTRACTING_CONTENT');
        
        // Aquí extraes tu texto del buffer (o si el Servicio A ya extrajo el texto, 
        // simplemente desencriptas el texto en lugar del archivo físico).
        const textToAnalyze = decryptedFileBuffer.toString('utf-8'); 

        await sendStatusUpdate(documentId, 'ANALYZING_CONTENT');

        // Llamamos a tu lógica intacta de Gemini + Fallback
        const result = await classifyText(textToAnalyze, subcriteria);

        await sendStatusUpdate(documentId, 'RECEIVING_RESULT');

        await sendStatusUpdate(documentId, 'COMPLETED', { result, userId });

    } catch (error) {
        console.error("Error en el Worker:", error);
        await sendStatusUpdate(documentId, 'ERROR', { error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Worker activo en el puerto ${PORT}`);
=======
// worker.js (Servicio B)
import express from 'express';
import crypto from 'node:crypto';
import fetch from 'node-fetch'; // O nativo en Node v18+
import { classifyText } from './classifier.service.js'; // Tu función de IA
// Asegúrate de importar o inicializar tu conexión a BD aquí para obtener subcriterios
import { prisma } from './prisma.js';

const app = express();
app.use(express.json({ limit: '15mb' })); // Permitimos archivos de hasta 10MB

// Esta es la URL de tu Servicio A (Backend Principal)
const BACKEND_WEBHOOK_URL = process.env.BACKEND_URL + '/webhooks/worker-update'; 
const ENCRYPTION_KEY = Buffer.from(process.env.WORKER_ENCRYPTION_KEY, 'hex');

// Función helper para avisar al Servicio A
async function sendStatusUpdate(documentId, status, payload = {}) {
    try {
        await fetch(BACKEND_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId, status, ...payload })
        });
    } catch (e) {
        console.error(`Error enviando estado al backend (Doc: ${documentId})`, e);
    }
}

app.post('/api/analyze', async (req, res) => {
    const { documentId, userId, iv, fileData } = req.body;

    // 1. Confirmar recepción INMEDIATAMENTE
    // Cerramos la conexión HTTP para no colgar el servidor principal.
    res.status(202).json({ message: 'Documento en procesamiento' });

    try {
        // 2. Avisamos: RECEIVED_BY_ANALYZER
        await sendStatusUpdate(documentId, 'RECEIVED_BY_ANALYZER');

        // 3. Desencriptación en memoria (Paso 4)
        const initVector = Buffer.from(iv, 'hex');
        const encryptedBuffer = Buffer.from(fileData, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, initVector);
        
        const decryptedFileBuffer = Buffer.concat([
            decipher.update(encryptedBuffer),
            decipher.final()
        ]);

        // 4. Avisamos: EXTRACTING_CONTENT
        await sendStatusUpdate(documentId, 'EXTRACTING_CONTENT');
        
        // Aquí extraes el texto de tu buffer desencriptado 
        // (Depende de si usas pdf-parse, mammoth, etc)
        const extractedText = await extractTextFromBuffer(decryptedFileBuffer); 
        
        // 5. Destrucción del archivo desencriptado de la memoria
        // Javascript maneja el garbage collection, pero podemos forzar el borrado de variables
        const textToAnalyze = extractedText;

        // 6. Avisamos: ANALYZING_CONTENT
        await sendStatusUpdate(documentId, 'ANALYZING_CONTENT');

        const subcriteria = await prisma.subcriterion.findMany({
            where: { criterion: { code: '9' } },
        });

        const result = await classifyText(textToAnalyze, subcriteria);

        // 7. Avisamos: RECEIVING_RESULT
        await sendStatusUpdate(documentId, 'RECEIVING_RESULT');

        // 8. Enviamos el resultado final al backend principal
        // y avisamos que el estado es COMPLETED
        await sendStatusUpdate(documentId, 'COMPLETED', {
            result,
            userId
        });

    } catch (error) {
        console.error("Error en el Worker:", error);
        await sendStatusUpdate(documentId, 'ERROR', { error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Worker interno de análisis corriendo en puerto ${PORT}`);
>>>>>>> b189068dfb0dc4d7d6fe0548fe2d2bca1923524e
});