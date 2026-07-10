/* Candado temporal real (timelock) sobre la red drand «quicknet» de la
   League of Entropy: más de 20 organizaciones independientes (Cloudflare,
   EPFL, Kudelski, UCL, Protocol Labs…) publican cada 3 segundos una firma
   umbral BLS sobre el número de ronda. Esa firma ES la llave de descifrado
   de todo lo cifrado «hacia» esa ronda — y no existe en ningún lugar del
   mundo hasta que la red la emite, exactamente a su hora.

   Cifrar: solo necesita la clave pública de la red (fijada abajo), sin
   conexión. Descifrar: exige pedir la firma de la ronda a la red; para
   rondas futuras la firma no existe y nadie puede fabricarla sin corromper
   a la mayoría de las organizaciones a la vez.

   La biblioteca criptográfica (tlock-js, de los autores de drand) va
   autoalojada en js/vendor/tlock.min.js y expone el global `tlock`. */

'use strict';

// Parámetros de quicknet, verificados contra la documentación oficial de
// drand y contra los valores incluidos en tlock-js. Fijarlos aquí evita
// confiar en lo que respondan los espejos.
export const QUICKNET = {
  public_key: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1692803367,
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: { beaconID: 'quicknet' }
};

export const ESPEJOS_DRAND = [
  'https://api.drand.sh',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
  'https://drand.cloudflare.com'
];

// Red inyectable solo para pruebas automatizadas (test.mjs).
let redPruebas = null;
export function _usarRedDePruebas(red) { redPruebas = red; }

function lib() {
  const t = globalThis.tlock;
  if (!t) throw new Error('Falta la biblioteca de tiempo (js/vendor/tlock.min.js).');
  return t;
}

function infoActual() {
  return redPruebas ? redPruebas.info : QUICKNET;
}

/* ------------------------- Rondas <-> instantes --------------------------- */

export function rondaParaEpoch(epochMs) {
  return lib().roundAt(epochMs, infoActual());
}

export function epochDeRonda(ronda) {
  return lib().roundTime(infoActual(), ronda);
}

/* --------------------------- Llaves de la red ----------------------------- */

async function pedirJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(t);
  }
}

/* Pide a la red la firma (llave) de una ronda y LA VERIFICA contra la clave
   pública fijada antes de usarla. Así, un espejo malicioso o averiado no
   puede colar una firma inválida (la matemática la rechaza) ni bloquear la
   apertura: si un espejo responde algo que no verifica, se prueba el
   siguiente. Errores: codigo='LLAVE_FUTURA' (la ronda aún no existe) o
   codigo='SIN_RED' (ningún espejo entregó una llave válida). */
async function obtenerBeacon(ronda) {
  const T = lib();
  const info = infoActual();
  const bases = (redPruebas && redPruebas.espejos) || ESPEJOS_DRAND;
  let huboFuturo = false;

  for (const base of bases) {
    try {
      const r = redPruebas
        ? await redPruebas.fetchMirror(base, ronda)
        : await pedirJson(base + '/' + info.hash + '/public/' + ronda, 6000);
      if (r.status === 404 || r.status === 425) { huboFuturo = true; continue; }
      if (!r.ok) continue;
      const j = await r.json();
      if (!j || typeof j.signature !== 'string') continue;

      let valido = false;
      try { valido = await T.verifyBeacon(info, j, ronda); } catch (_) { valido = false; }
      if (!valido) continue;      // espejo no confiable → siguiente
      return j;
    } catch (_) { /* siguiente espejo */ }
  }

  const e = new Error(huboFuturo
    ? 'La red aún no publica la llave de esta ronda.'
    : 'Ningún espejo entregó una llave válida de la red de tiempo.');
  e.codigo = huboFuturo ? 'LLAVE_FUTURA' : 'SIN_RED';
  throw e;
}

/* Clientes mínimos para tlock-js. Al cifrar solo hace falta la información
   de la cadena (clave pública y esquema): funciona sin conexión. Al
   descifrar, el genesis se fija en 1 para que la decisión de «¿ya se
   puede?» la tome ÚNICAMENTE la red al publicar o no la firma — nunca el
   reloj local del dispositivo, que un atacante controla. Una firma falsa
   de un espejo malicioso no descifra nada (la matemática la rechaza). */

function clienteCifrado() {
  const info = infoActual();
  return {
    options: { disableBeaconVerification: true, noCache: true },
    chain: () => ({ baseUrl: 'fijada', info: async () => info }),
    latest: async () => { throw new Error('no disponible'); },
    get: async () => { throw new Error('no requerido al sellar'); }
  };
}

function clienteDescifrado() {
  const info = { ...infoActual(), genesis_time: 1 };
  return {
    options: { disableBeaconVerification: true, noCache: true },
    chain: () => ({ baseUrl: 'fijada', info: async () => info }),
    latest: async () => { throw new Error('no disponible'); },
    get: (ronda) => obtenerBeacon(ronda)
  };
}

/* --------------------- Cerrar y abrir hacia el futuro --------------------- */

const CABECERA_ARMADURA = '-----BEGIN AGE ENCRYPTED FILE-----';
const PIE_ARMADURA = '-----END AGE ENCRYPTED FILE-----';

// La armadura age se guarda compacta (solo su base64, sin cabeceras ni
// saltos de línea) y se reconstruye al abrir.
function compactarArmadura(armadura) {
  return armadura
    .replace(CABECERA_ARMADURA, '')
    .replace(PIE_ARMADURA, '')
    .replace(/\s+/g, '');
}

export function reconstruirArmadura(compacta) {
  const lineas = compacta.match(/.{1,64}/g) || [];
  return CABECERA_ARMADURA + '\n' + lineas.join('\n') + '\n' + PIE_ARMADURA + '\n';
}

/* Cifra bytes hacia una ronda futura. Devuelve la armadura compacta. */
export async function cerrarHastaRonda(bytes, ronda) {
  const T = lib();
  const armadura = await T.timelockEncrypt(ronda, T.Buffer.from(bytes), clienteCifrado());
  return compactarArmadura(armadura);
}

/* Abre una armadura compacta pidiendo la llave de su ronda a la red. */
export async function abrirConLlaveDelTiempo(compacta) {
  const T = lib();
  const buf = await T.timelockDecrypt(reconstruirArmadura(compacta), clienteDescifrado());
  return new Uint8Array(buf);
}

/* ------------------- La red drand como fuente de hora --------------------- */

/* La última ronda publicada revela la hora real con precisión de ±3 s:
   una fuente de hora que además es la misma autoridad que custodia las
   llaves. Devuelve epoch ms o lanza si no hay conexión. */
export async function horaDesdeDrand() {
  const T = lib();
  for (const base of ESPEJOS_DRAND) {
    try {
      const r = await pedirJson(base + '/' + QUICKNET.hash + '/public/latest', 4000);
      if (!r.ok) continue;
      const j = await r.json();
      const ronda = Number(j && j.round);
      if (!Number.isFinite(ronda) || ronda < 1) continue;

      // Verificar la firma: un espejo no puede inflar la ronda para
      // adelantar el reloj (aunque adelantar el reloj no abre nada en v4).
      let valido = false;
      try { valido = await T.verifyBeacon(QUICKNET, j, ronda); } catch (_) { valido = false; }
      if (!valido) continue;

      return (QUICKNET.genesis_time + (ronda - 1) * QUICKNET.period) * 1000 +
        Math.floor(QUICKNET.period * 500);
    } catch (_) { /* siguiente espejo */ }
  }
  throw new Error('drand no disponible');
}
