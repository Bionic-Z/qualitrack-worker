// Cliente del LLM local (Ollama) para generación con salida estructurada.
//
// El worker corre en la misma máquina que la GPU, así que habla con Ollama por
// localhost: no hay túnel, ni proxy, ni token de por medio. El aislamiento de
// red lo provee Tailscale entre Railway y esta máquina.
//
// La salida se restringe con JSON Schema vía el parámetro `format`, que es el
// equivalente directo del `responseSchema` de Gemini: el modelo no puede emitir
// tokens que violen el esquema, así que el JSON siempre parsea.

const LLM_SERVICE_URL = process.env.LLM_SERVICE_URL || 'http://127.0.0.1:11434';
const LLM_MODEL = process.env.LLM_MODEL || 'qwen3.5:9b';

// La carga inicial del modelo a VRAM puede tardar decenas de segundos si los
// pesos viven en un disco mecánico. Después de eso cada respuesta son ~2-3s.
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180000);

/**
 * Genera una respuesta JSON que cumple el esquema entregado.
 *
 * @param {object} params
 * @param {string} params.system  Instrucciones de sistema.
 * @param {string} params.user    Contenido a analizar.
 * @param {object} params.schema  JSON Schema que restringe la salida.
 * @returns {Promise<object>} El JSON ya parseado.
 */
export async function generateStructured({ system, user, schema }) {
  const response = await fetch(`${LLM_SERVICE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      stream: false,
      // Desactiva el modo de razonamiento: para clasificar no aporta y
      // multiplica la latencia.
      think: false,
      format: schema,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Error del servicio LLM (${response.status}): ${await response.text()}`);
  }

  const result = await response.json();
  const content = result?.message?.content;

  if (!content) throw new Error('El servicio LLM devolvió una respuesta vacía');

  return JSON.parse(content);
}

/**
 * Verifica que Ollama esté arriba y que el modelo esperado esté descargado.
 * El worker lo llama al arrancar para fallar temprano y con un mensaje claro,
 * en vez de descubrirlo con el primer documento del usuario.
 */
export async function checkLlmAvailable() {
  try {
    const response = await fetch(`${LLM_SERVICE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` };

    const { models = [] } = await response.json();
    const names = models.map((m) => m.name);

    return {
      available: names.includes(LLM_MODEL),
      model: LLM_MODEL,
      reason: names.includes(LLM_MODEL)
        ? null
        : `El modelo ${LLM_MODEL} no está descargado. Disponibles: ${names.join(', ') || 'ninguno'}`,
    };
  } catch (err) {
    return { available: false, reason: `No se pudo contactar a Ollama en ${LLM_SERVICE_URL}: ${err.message}` };
  }
}

/**
 * Precarga el modelo en VRAM. keep_alive=-1 lo mantiene cargado, pero no lo
 * carga solo al arrancar Ollama: sin esto, el primer documento del dia paga la
 * lectura de 6,6 GB desde disco mientras procesa el prompt, y puede superar el
 * timeout. Con el worker precalentado, el primer usuario ve la misma latencia
 * que el resto.
 */
export async function warmUp() {
  const started = Date.now();

  const response = await fetch(`${LLM_SERVICE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      stream: false,
      think: false,
      keep_alive: -1,
      messages: [{ role: 'user', content: 'ok' }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return (Date.now() - started) / 1000;
}

export { LLM_MODEL, LLM_SERVICE_URL };
