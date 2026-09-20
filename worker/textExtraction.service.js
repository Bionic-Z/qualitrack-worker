// Extracción de texto desde el archivo que llega cifrado del Servicio A.
//
// El backend envía el archivo físico, no el texto, y el payload no incluye el
// formato. Por eso el tipo se deduce de los bytes: es más confiable que la
// extensión de todos modos, porque no depende de cómo el usuario nombró el
// archivo.
//
// Si en el futuro el Servicio A manda `text` o `format` en el payload, worker.js
// los prefiere y esto no se ejecuta.

/** Deduce el formato mirando la firma del archivo. */
export function detectFormat(buffer) {
  if (buffer.length < 4) return null;

  // %PDF
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';

  // PK\x03\x04 — es un zip: docx y xlsx lo son. Se distinguen por las rutas
  // internas que el zip declara en su índice.
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('latin1');
    if (head.includes('word/')) return 'docx';
    if (head.includes('xl/')) return 'xlsx';
    // Algunos zips declaran las rutas solo al final, en el directorio central.
    const tail = buffer.subarray(Math.max(0, buffer.length - 65536)).toString('latin1');
    if (tail.includes('word/')) return 'docx';
    if (tail.includes('xl/')) return 'xlsx';
    return null;
  }

  // \xD0\xCF\x11\xE0 — formato OLE2 (doc/xls antiguos de Office).
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    return 'ole2';
  }

  return 'text';
}

async function extractPdf(buffer) {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const data = await pdfParse(buffer);
  return data.text || '';
}

async function extractDocx(buffer) {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.extractRawText({ buffer });
  return value || '';
}

async function extractXlsx(buffer) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return wb.SheetNames.map((name) => `# ${name}\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`).join(
    '\n\n'
  );
}

/**
 * @param {Buffer} buffer  Bytes ya descifrados.
 * @param {string} [format] Formato conocido; si falta se deduce de los bytes.
 * @returns {Promise<{text: string, format: string}>}
 */
export async function extractText(buffer, format) {
  const tipo = format || detectFormat(buffer);

  if (tipo === 'pdf') return { text: await extractPdf(buffer), format: 'pdf' };
  if (tipo === 'docx') return { text: await extractDocx(buffer), format: 'docx' };
  if (tipo === 'xlsx') return { text: await extractXlsx(buffer), format: 'xlsx' };

  if (tipo === 'ole2') {
    throw new Error(
      'El archivo está en formato Office antiguo (.doc/.xls binario). Conviértelo a .docx o .xlsx.'
    );
  }

  if (tipo === 'text') return { text: buffer.toString('utf-8'), format: 'text' };

  throw new Error('No se pudo determinar el formato del archivo a partir de sus bytes.');
}
