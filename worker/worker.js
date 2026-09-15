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

app.post('/api/analyze', async (req, res) => {
    // AHORA RECIBIMOS LOS SUBCRITERIOS DIRECTAMENTE DESDE EL SERVICIO A
    const { documentId, userId, iv, authTag, fileData, subcriteria } = req.body;

    res.status(202).json({ message: 'Documento en procesamiento' });

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
});