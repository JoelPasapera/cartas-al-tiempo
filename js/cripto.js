/* Cifrado de cartas — formato v4: DOBLE candado criptográfico.

   Candado 1 (contraseña): título y mensaje se cifran con AES-256-GCM y una
   clave derivada de la contraseña (PBKDF2-SHA-256, 600 000 iteraciones).
   La clave nunca viaja con la carta.

   Candado 2 (tiempo): ese cifrado se vuelve a cerrar «hacia el futuro» con
   timelock (tlock/drand quicknet). La llave de este candado es la firma
   umbral que la red de la League of Entropy publica exactamente en la
   ronda elegida: antes de esa hora NO EXISTE, así que ni el destinatario
   con la contraseña, ni un atacante con GPUs, ni quien manipule su reloj
   puede abrir la carta antes. Además, hasta que llegue la hora ni siquiera
   se puede empezar a probar contraseñas: el material atacable está dentro
   del candado temporal.

   Payload v4:
     { v:4, to, de, ab, se, tz, rd, iv, pw:1, s, it, tl }
     rd = ronda drand de apertura · tl = armadura tlock compacta ·
     iv/s en base64url · it = iteraciones PBKDF2.

   Los metadatos visibles (nombres, fechas, ronda, sal, iteraciones) van
   autenticados (AAD) dentro del AES-GCM: alterarlos rompe el descifrado.

   Compatibilidad al abrir: v1 (sin AAD), v2 (AAD con título a la vista),
   v3 (título cifrado, sin candado temporal), v4 (actual). */

'use strict';

import { te, td, bytesABase64url, base64urlABytes } from './util.js';
import { rondaParaEpoch, cerrarHastaRonda, abrirConLlaveDelTiempo } from './tiempo-cerrado.js';

export const ITERACIONES = 600000;
export const MAX_ITERACIONES = 5000000; // tope al abrir: evita enlaces trampa que congelen el navegador
export const MAX_CUERPO_B64 = 400000;   // tope de tamaño del cuerpo cifrado al abrir (~15× una carta máxima)

function construirAAD(p) {
  const campos = ['CartasAlTiempo', 'v' + p.v, p.to, p.de];
  if (p.v < 3) campos.push(p.ti);            // v2 llevaba el título a la vista
  campos.push(String(p.ab), String(p.se), p.tz);
  if (p.v >= 3) campos.push(p.s, String(p.it));
  if (p.v >= 4) campos.push(String(p.rd));   // la ronda drand también queda blindada
  return te.encode(campos.join('\u001f'));
}

async function claveDesdePassword(password, salt, iteraciones, usos) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iteraciones, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usos
  );
}

async function claveDesdeBytes(raw, usos) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usos);
}

/* Verificador de contraseña para el borrado local.

   No se puede comprobar la contraseña descifrando una carta aún sellada
   (la llave del tiempo no existe todavía). Por eso, al crear la carta se
   guarda EN EL REGISTRO LOCAL —nunca en el enlace ni en el archivo— un
   verificador: un hash PBKDF2 con su propia sal, independiente de la clave
   del contenido. Permite exigir la contraseña para eliminar, antes o
   después de la fecha, sin revelar nada del contenido ni debilitar la
   carta compartida. */

async function bitsDeClave(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password || ''), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERACIONES, hash: 'SHA-256' }, base, 256
  );
  return new Uint8Array(bits);
}

export async function crearVerificador(password) {
  const vs = crypto.getRandomValues(new Uint8Array(16));
  const vc = await bitsDeClave(password, vs);
  return { vs: bytesABase64url(vs), vc: bytesABase64url(vc) };
}

/* Comparación en tiempo constante: no filtra por cuánto coincide. */
export async function verificarClave(password, vs, vc) {
  if (typeof vs !== 'string' || typeof vc !== 'string') return false;
  let salt, esperado;
  try { salt = base64urlABytes(vs); esperado = base64urlABytes(vc); }
  catch (_) { return false; }
  const obtenido = await bitsDeClave(password, salt);
  if (obtenido.length !== esperado.length) return false;
  let diff = 0;
  for (let i = 0; i < obtenido.length; i++) diff |= obtenido[i] ^ esperado[i];
  return diff === 0;
}

function errorCon(codigo, mensaje) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  return e;
}

export async function sellarCarta({ para, de, titulo, mensaje, abreEpoch, selladaEpoch, password, adjuntos }) {
  if (!password) throw errorCon('SIN_CLAVE', 'La contraseña es obligatoria.');

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const payload = {
    v: 4,
    to: para,
    de: de || '',
    ab: abreEpoch,
    se: selladaEpoch,
    tz: 'America/Lima',
    rd: rondaParaEpoch(abreEpoch),
    iv: bytesABase64url(iv),
    pw: 1,
    s: bytesABase64url(salt),
    it: ITERACIONES
  };

  // Texto plano: título + mensaje, y adjuntos SOLO si los hay (así una
  // carta sin adjuntos queda idéntica byte a byte a las de siempre). Cada
  // adjunto es { mime, nombre, datos } con datos en base64. Todo esto
  // viaja cifrado dentro del doble candado, igual que el mensaje.
  const plano = { t: titulo || '', m: mensaje };
  if (Array.isArray(adjuntos) && adjuntos.length) plano.adj = adjuntos;

  // Candado 1: contraseña (AES-GCM con metadatos autenticados)
  const clave = await claveDesdePassword(password, salt, ITERACIONES, ['encrypt']);
  const datos = te.encode(JSON.stringify(plano));
  const interior = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: construirAAD(payload) },
    clave,
    datos
  );

  // Candado 2: tiempo (la llave la publica la red drand en la ronda rd)
  payload.tl = await cerrarHastaRonda(new Uint8Array(interior), payload.rd);
  return payload;
}

/* Devuelve { titulo, mensaje }. Errores con e.codigo:
   'LLAVE_FUTURA'  la red aún no publica la llave (la hora no llegó)
   'SIN_RED'       sin conexión con la red de tiempo
   'CLAVE_MALA'    contraseña incorrecta o carta manipulada           */
export async function abrirCarta(payload, password) {
  // --- Candado 2 primero (solo v4): sin la llave del tiempo no hay nada que atacar
  let cifradoInterior;
  if (payload.v >= 4) {
    if (!payload.tl) throw errorCon('CLAVE_MALA', 'Carta incompleta.');
    try {
      cifradoInterior = await abrirConLlaveDelTiempo(payload.tl);
    } catch (e) {
      if (e && (e.codigo === 'LLAVE_FUTURA' || e.codigo === 'SIN_RED')) throw e;
      throw errorCon('CLAVE_MALA', 'La carta está dañada o fue manipulada.');
    }
  } else {
    cifradoInterior = base64urlABytes(payload.ct);
  }

  // --- Candado 1: contraseña
  let clave;
  if (payload.pw) {
    const it = payload.it || (payload.v >= 2 ? ITERACIONES : 210000);
    if (!Number.isFinite(it) || it > MAX_ITERACIONES) throw errorCon('CLAVE_MALA', 'Parámetros inválidos.');
    const salt = base64urlABytes(payload.s);
    clave = await claveDesdePassword(password || '', salt, it, ['decrypt']);
  } else {
    clave = await claveDesdeBytes(base64urlABytes(payload.k), ['decrypt']);
  }

  const opciones = { name: 'AES-GCM', iv: base64urlABytes(payload.iv) };
  if (payload.v >= 2) opciones.additionalData = construirAAD(payload);

  let plano;
  try {
    plano = await crypto.subtle.decrypt(opciones, clave, cifradoInterior);
  } catch (_) {
    throw errorCon('CLAVE_MALA', 'La contraseña no es correcta.');
  }

  const obj = JSON.parse(td.decode(plano));
  return {
    titulo: payload.v >= 3 ? (obj.t || '') : (payload.ti || ''),
    mensaje: obj.m,
    adjuntos: Array.isArray(obj.adj) ? obj.adj : []
  };
}

export function payloadAFragmento(payload) {
  return 'c=' + bytesABase64url(te.encode(JSON.stringify(payload)));
}

// Un epoch en milisegundos que Date/Intl pueden formatear sin lanzar
// (el rango válido de Date es ±8.64e15 ms). Rechaza string, NaN e Infinity.
function esEpochValido(x) {
  return typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 8.64e15;
}

export function fragmentoAPayload(hash) {
  const params = new URLSearchParams(hash);
  const c = params.get('c');
  if (!c) return null;
  const payload = JSON.parse(td.decode(base64urlABytes(c)));
  if (!payload || typeof payload !== 'object') throw new Error('incompleto');
  if (typeof payload.iv !== 'string') throw new Error('incompleto');
  if (!payload.ct && !payload.tl) throw new Error('incompleto');

  // Tope de tamaño: un enlace con un cuerpo cifrado desproporcionado
  // (para saturar memoria/CPU al abrir) se rechaza aquí.
  const cuerpo = payload.tl || payload.ct;
  if (typeof cuerpo !== 'string' || cuerpo.length > MAX_CUERPO_B64) throw new Error('cuerpo invalido');

  // Validación numérica: un enlace deformado (ab no numérico, Infinity,
  // NaN, ronda o iteraciones absurdas) se rechaza aquí, antes de romper el
  // formateo de fechas o disparar trabajo inútil al abrir.
  if (!esEpochValido(payload.ab)) throw new Error('ab invalido');
  if (payload.se !== undefined && !esEpochValido(payload.se)) throw new Error('se invalido');
  if (payload.v >= 4) {
    if (typeof payload.tl !== 'string') throw new Error('tl invalido');
    if (!Number.isFinite(payload.rd) || payload.rd < 1 || payload.rd > Number.MAX_SAFE_INTEGER) {
      throw new Error('rd invalido');
    }
  }
  if (payload.pw) {
    if (typeof payload.s !== 'string') throw new Error('s invalido');
    if (!Number.isFinite(payload.it) || payload.it < 1 || payload.it > MAX_ITERACIONES) {
      throw new Error('it invalido');
    }
  }
  return payload;
}

/* Frases de contraseña: seis palabras al azar de una lista de 256
   (elección criptográfica: 48 bits de entropía). Fáciles de dictar por
   teléfono; combinadas con las 600 000 iteraciones de PBKDF2, romperlas
   por fuerza bruta queda fuera del alcance práctico. */

const PALABRAS = [
  'aire', 'alba', 'aldea', 'algodon', 'amapola', 'ancla', 'arena', 'arroz',
  'atlas', 'aurora', 'avena', 'azafran', 'bahia', 'balcon', 'bambu', 'barco',
  'bosque', 'brisa', 'bruma', 'buho', 'cabaña', 'cacao', 'campana', 'canela',
  'cantaro', 'caoba', 'caracol', 'carbon', 'castaña', 'cedro', 'cereza', 'cielo',
  'ciruela', 'clavel', 'cobre', 'colibri', 'cometa', 'concha', 'coral', 'cordel',
  'corona', 'cristal', 'cumbre', 'dalia', 'delfin', 'diamante', 'duende', 'durazno',
  'ebano', 'eco', 'estepa', 'estrella', 'farol', 'faro', 'fresa', 'fuego',
  'gacela', 'garza', 'girasol', 'granada', 'granizo', 'grulla', 'guitarra', 'helecho',
  'hierro', 'higo', 'hoguera', 'hoja', 'huerta', 'humo', 'iman', 'isla',
  'jade', 'jazmin', 'jengibre', 'jirafa', 'laguna', 'lavanda', 'lienzo', 'lima',
  'lino', 'lirio', 'llave', 'lluvia', 'loma', 'luciernaga', 'madera', 'manantial',
  'marea', 'marfil', 'melon', 'menta', 'mirlo', 'molino', 'montaña', 'musgo',
  'nacar', 'nardo', 'nevada', 'niebla', 'nogal', 'nube', 'oasis', 'ola',
  'olivo', 'ostra', 'palmera', 'panal', 'pesca', 'piedra', 'pino', 'plata',
  'pradera', 'puerto', 'quinua', 'relampago', 'remo', 'roble', 'rocio', 'romero',
  'sabana', 'salvia', 'sandia', 'sauce', 'semilla', 'sendero', 'tejado', 'trigo',
  'abeja', 'abeto', 'acero', 'aguacate', 'ajedrez', 'albahaca', 'almendra', 'ambar',
  'anguila', 'antena', 'anzuelo', 'arandano', 'arcilla', 'ardilla', 'arpa', 'arroyo',
  'atun', 'avellana', 'avispa', 'azucena', 'ballena', 'bandera', 'barranco', 'bellota',
  'berenjena', 'bicicleta', 'brujula', 'bufanda', 'burbuja', 'caballo', 'cactus', 'calabaza',
  'camelia', 'camino', 'canario', 'cangrejo', 'canoa', 'cascada', 'castillo', 'cebolla',
  'centeno', 'cerezo', 'chocolate', 'cigarra', 'cinturon', 'cipres', 'cisne', 'clavo',
  'cocina', 'cocotero', 'colina', 'collar', 'colmena', 'corcho', 'cordillera', 'cortina',
  'cuaderno', 'cuarzo', 'cuchara', 'cuerda', 'cueva', 'dado', 'dedal', 'desierto',
  'dique', 'dorado', 'encina', 'eneldo', 'esmeralda', 'espuma', 'estanque', 'faisan',
  'flauta', 'flecha', 'fogata', 'fresno', 'frontera', 'fuente', 'gaviota', 'geranio',
  'glaciar', 'golondrina', 'gorrion', 'gota', 'granero', 'granito', 'grosella', 'guayaba',
  'halcon', 'hamaca', 'harina', 'hebilla', 'herradura', 'hiedra', 'hilo', 'hormiga',
  'horno', 'huella', 'jabali', 'jarron', 'jilguero', 'junco', 'ladera', 'ladrillo',
  'lampara', 'lancha', 'laurel', 'lechuza', 'lenteja', 'libelula', 'liebre', 'linterna',
  'lobo', 'lucero', 'luna', 'madreselva', 'maiz', 'mandarina', 'mango', 'manzana',
  'mariposa', 'mimbre', 'naranja', 'nectar', 'nutria', 'obsidiana', 'orquidea', 'tortuga'
];

export const TOTAL_PALABRAS = PALABRAS.length;

export function generarFrase(palabras = 6) {
  const idx = new Uint32Array(palabras);
  crypto.getRandomValues(idx);
  const partes = [];
  for (let i = 0; i < palabras; i++) partes.push(PALABRAS[idx[i] % PALABRAS.length]);
  return partes.join('-');
}
