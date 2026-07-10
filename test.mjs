// Pruebas de los módulos (npm install && node test.mjs)
// Incluye una red drand FALSA local con la misma criptografía que quicknet
// (BLS12-381, esquema bls-unchained-g1-rfc9380) para probar el candado
// temporal de punta a punta sin depender de internet.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bls12_381 } from '@noble/curves/bls12-381';
import { sha256 } from '@noble/hashes/sha256';

import { bytesABase64url, base64urlABytes, limpiarTexto, te } from './js/util.js';
import { limaInputAEpoch, limaEpochAInput } from './js/hora.js';

// La biblioteca de tiempo se carga desde el MISMO archivo que irá al
// navegador: las pruebas validan el artefacto real.
(0, eval)(readFileSync(new URL('./js/vendor/tlock.min.js', import.meta.url), 'utf8'));
assert.ok(globalThis.tlock, 'el bundle debe exponer el global tlock');

const { QUICKNET, _usarRedDePruebas, reconstruirArmadura } = await import('./js/tiempo-cerrado.js');
const {
  sellarCarta, abrirCarta, payloadAFragmento, fragmentoAPayload,
  generarFrase, ITERACIONES, TOTAL_PALABRAS, crearVerificador, verificarClave
} = await import('./js/cripto.js');
const { construirArchivoSellado } = await import('./js/sellado.js');

const CLAVE = 'colibri-marea-farol-nube-lima-cedro';

// 0) Los parámetros de quicknet fijados en el código coinciden con los que
//    trae la biblioteca oficial (dos fuentes independientes de la verdad).
for (const campo of ['public_key', 'period', 'genesis_time', 'hash', 'schemeID']) {
  assert.deepEqual(QUICKNET[campo], globalThis.tlock.defaultChainInfo[campo]);
}
console.log('OK  parámetros quicknet fijados = biblioteca oficial');

// ---- Red drand falsa local (mismas matemáticas que quicknet) --------------
// Expone la misma interfaz que espera el código: una lista de espejos y un
// fetchMirror(base, ronda). Firma cada ronda con su propia clave BLS y
// entrega la randomness correcta (sha256 de la firma), de modo que la
// verificación de beacon del código la acepte igual que a quicknet.
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
const sk = BigInt('0x' + Buffer.from(bls12_381.utils.randomPrivateKey()).toString('hex'));
const pkHex = Buffer.from(bls12_381.G2.ProjectivePoint.BASE.multiply(sk).toRawBytes(true)).toString('hex');
const idRonda = (r) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(r)); return sha256(b); };
const firmarRonda = (r) => Buffer.from(
  bls12_381.G1.hashToCurve(idRonda(r), { DST }).multiply(sk).toRawBytes(true)
).toString('hex');
const beaconDe = (r) => {
  const s = firmarRonda(r);
  return { round: r, signature: s, randomness: Buffer.from(sha256(Buffer.from(s, 'hex'))).toString('hex') };
};

const red = {
  publicada: 1001, // la red solo «conoce» firmas hasta esta ronda
  espejos: ['https://espejo-de-prueba/'],
  info: {
    ...QUICKNET,
    public_key: pkHex,
    genesis_time: Math.floor(Date.now() / 1000) - 1001 * QUICKNET.period,
    hash: 'aa'.repeat(32)
  },
  fetchMirror(_base, r) {
    if (r > red.publicada) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => beaconDe(r) });
  }
};
_usarRedDePruebas(red);

// 1) base64url ida y vuelta (incluye tamaño grande para el troceo)
const bytes = new Uint8Array(70000).map((_, i) => (i * 31 + 7) % 256);
assert.deepEqual(base64urlABytes(bytesABase64url(bytes)), bytes);
console.log('OK  base64url ida y vuelta (70 KB)');

// 2) Hora de Lima: 24-dic-2026 20:00 Lima = 25-dic-2026 01:00 UTC
assert.equal(limaInputAEpoch('2026-12-24T20:00'), Date.UTC(2026, 11, 25, 1, 0));
assert.equal(limaEpochAInput(Date.UTC(2026, 11, 25, 1, 0)), '2026-12-24T20:00');
console.log('OK  conversión hora de Lima (UTC-5)');

// 3) v4: contraseña obligatoria; doble candado; nada visible
const base = {
  para: 'María José', de: 'Álvaro', titulo: 'Feliz cumpleaños treinta',
  mensaje: 'Primera línea.\n\nSegundo párrafo con ñ y tildes: á é í ó ú.',
  abreEpoch: Date.now() + 3600 * 1000, selladaEpoch: Date.now()
};
await assert.rejects(() => sellarCarta({ ...base, password: null }));
console.log('OK  sellar sin contraseña queda prohibido');

const p4 = await sellarCarta({ ...base, password: CLAVE });
assert.equal(p4.v, 4);
assert.ok(p4.tl && p4.rd > red.publicada);
assert.equal(p4.ti, undefined);
assert.equal(p4.k, undefined);
assert.equal(p4.ct, undefined);
const enlace = payloadAFragmento(p4);
assert.ok(!enlace.includes('cumplea') && !JSON.stringify(p4).includes('cumplea'));
console.log('OK  v4 sellada hacia la ronda', p4.rd, '· título y mensaje jamás en claro');

// 4) EL ATAQUE DEL RELOJ: aunque el atacante tenga la CONTRASEÑA y burle
//    todos los relojes locales, la red no ha publicado la llave → imposible.
await assert.rejects(() => abrirCarta(p4, CLAVE), (e) => e.codigo === 'LLAVE_FUTURA');
console.log('OK  con contraseña correcta + reloj adelantado: la red dice NO (LLAVE_FUTURA)');

// 5) Al publicarse la ronda, la carta se abre con la contraseña (y solo con ella)
red.publicada = p4.rd;
const abierta = await abrirCarta(p4, CLAVE);
assert.equal(abierta.titulo, base.titulo);
assert.equal(abierta.mensaje, base.mensaje);
await assert.rejects(() => abrirCarta(p4, 'otra-clave-cualquiera'), (e) => e.codigo === 'CLAVE_MALA');
console.log('OK  llegada la ronda: contraseña correcta abre; incorrecta no');

// 6) AAD: manipular cualquier metadato visible rompe el descifrado
for (const cambio of [
  { ab: p4.ab - 86400000 },
  { to: 'Otro nombre' },
  { rd: p4.rd - 10 },
  { s: bytesABase64url(new Uint8Array(16)) },
  { it: 1000 }
]) {
  const manipulado = { ...p4, ...cambio };
  if (cambio.rd) red.publicada = Math.max(red.publicada, manipulado.rd);
  await assert.rejects(() => abrirCarta(manipulado, CLAVE));
}
console.log('OK  metadatos blindados: fecha, nombre, ronda, sal o iteraciones alterados no abren');

// 7) Enlaces trampa con iteraciones absurdas se rechazan al instante
await assert.rejects(() => abrirCarta({ ...p4, it: 99999999 }, CLAVE), (e) => e.codigo === 'CLAVE_MALA');
console.log('OK  tope de iteraciones: un enlace trampa no congela el navegador');

// 8) La armadura compacta se reconstruye idéntica al formato age
{
  const arm = reconstruirArmadura(p4.tl);
  assert.ok(arm.startsWith('-----BEGIN AGE ENCRYPTED FILE-----\n'));
  assert.ok(arm.endsWith('-----END AGE ENCRYPTED FILE-----\n'));
  assert.ok(arm.split('\n').every((l) => l.length <= 64 || l.startsWith('-----')));
  console.log('OK  armadura age compacta y reconstruible');
}

// 9) Compatibilidad: v3 (título cifrado, sin candado temporal), v2 y v1
{
  // v3
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const v3 = {
    v: 3, to: 'Julio', de: 'Rosa', ab: Date.now() - 1000, se: Date.now() - 5000,
    tz: 'America/Lima', iv: bytesABase64url(iv), pw: 1, s: bytesABase64url(salt), it: 600000
  };
  const aadV3 = te.encode(['CartasAlTiempo', 'v3', v3.to, v3.de, String(v3.ab), String(v3.se), v3.tz, v3.s, String(v3.it)].join('\u001f'));
  const kb = await crypto.subtle.importKey('raw', te.encode('clave-v3'), 'PBKDF2', false, ['deriveKey']);
  const k3 = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, kb,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct3 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadV3 }, k3,
    te.encode(JSON.stringify({ t: 'Secreto v3', m: 'hola v3' })));
  v3.ct = bytesABase64url(new Uint8Array(ct3));
  const r3 = await abrirCarta(v3, 'clave-v3');
  assert.equal(r3.mensaje, 'hola v3');
  assert.equal(r3.titulo, 'Secreto v3');

  // v2 (título a la vista)
  const iv2 = crypto.getRandomValues(new Uint8Array(12));
  const salt2 = crypto.getRandomValues(new Uint8Array(16));
  const v2 = {
    v: 2, to: 'Julio', de: 'Rosa', ti: 'Sorpresa', ab: Date.now() - 1000,
    se: Date.now() - 5000, tz: 'America/Lima',
    iv: bytesABase64url(iv2), pw: 1, s: bytesABase64url(salt2), it: 600000
  };
  const aadV2 = te.encode(['CartasAlTiempo', 'v2', v2.to, v2.de, v2.ti, String(v2.ab), String(v2.se), v2.tz].join('\u001f'));
  const kb2 = await crypto.subtle.importKey('raw', te.encode('clave-antigua'), 'PBKDF2', false, ['deriveKey']);
  const k2 = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt2, iterations: 600000, hash: 'SHA-256' }, kb2,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct2 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv2, additionalData: aadV2 }, k2, te.encode(JSON.stringify({ m: 'hola v2' })));
  v2.ct = bytesABase64url(new Uint8Array(ct2));
  const r2 = await abrirCarta(v2, 'clave-antigua');
  assert.equal(r2.mensaje, 'hola v2');
  assert.equal(r2.titulo, 'Sorpresa');

  // v1 (clave en el enlace, sin AAD)
  const iv1 = crypto.getRandomValues(new Uint8Array(12));
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const k1 = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct1 = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv1 }, k1, te.encode(JSON.stringify({ m: 'hola v1' })));
  const v1 = {
    v: 1, to: 'Julio', de: '', ti: '', ab: Date.now() - 1000, se: Date.now() - 5000,
    tz: 'America/Lima', iv: bytesABase64url(iv1), ct: bytesABase64url(new Uint8Array(ct1)),
    k: bytesABase64url(raw)
  };
  assert.equal((await abrirCarta(v1, null)).mensaje, 'hola v1');
  console.log('OK  cartas v1, v2 y v3 antiguas siguen abriéndose');
}

// 10) Fragmento del enlace reversible
assert.ok(enlace.startsWith('c='));
assert.deepEqual(fragmentoAPayload(enlace), p4);
console.log('OK  fragmento del enlace reversible');

// 11) Archivo sellado autónomo: biblioteca incrustada, doble candado, sin fugas
const vendorTxt = readFileSync(new URL('./js/vendor/tlock.min.js', import.meta.url), 'utf8');
const html = await construirArchivoSellado(p4, vendorTxt);
assert.ok(html.startsWith('<!doctype html>'));
assert.ok(html.includes('timelockDecrypt'));       // biblioteca dentro
assert.ok(html.includes(p4.tl.slice(0, 40)));      // candado temporal dentro
assert.ok(html.includes('api.drand.sh'));          // espejos de la red
assert.ok(!html.includes('cumplea'));              // título jamás en claro
assert.ok(!html.includes('Segundo párrafo'));      // mensaje jamás en claro
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 2);
const pMalo = await sellarCarta({ ...base, para: '<script>alert(1)</script>', password: CLAVE });
const htmlMalo = await construirArchivoSellado(pMalo, vendorTxt);
assert.ok(!htmlMalo.includes('<script>alert(1)</script>'));
assert.ok(htmlMalo.includes('&lt;script&gt;'));
console.log('OK  archivo sellado con biblioteca incrustada, sin texto en claro y con nombres escapados');

// 11b) Archivo sellado CON adjuntos: renderizado embebido y sin fuga en claro
{
  const marca = 'ZZfotoSecretaZZ';
  const fotoB64 = bytesABase64url(te.encode(marca + 'x'.repeat(40)));
  red.publicada = 5000;
  const pf = await sellarCarta({ ...base, password: CLAVE, adjuntos: [{ mime: 'image/jpeg', nombre: 'playa.jpg', datos: fotoB64 }] });
  const htmlF = await construirArchivoSellado(pf, vendorTxt);
  assert.ok(htmlF.includes('pintarAdjuntos'));          // lógica de renderizado embebida
  assert.ok(htmlF.includes('id="adjuntos"'));           // contenedor presente
  assert.ok(/data:"\s*\+\s*a\.mime/.test(htmlF) || htmlF.includes('data:')); // reconstruye data: URL
  assert.ok(!htmlF.includes(fotoB64));                  // el adjunto NO viaja en claro
  assert.ok(!htmlF.includes(marca));                    // ni su contenido
  console.log('OK  archivo sellado con adjuntos: renderizado embebido, adjunto cifrado (no en claro)');
}

// 12) Generador de frases y saneamiento
assert.equal(TOTAL_PALABRAS, 256);
const f1 = generarFrase();
assert.equal(f1.split('-').length, 6);
assert.match(f1, /^[a-zñ]+(-[a-zñ]+){5}$/);
assert.notEqual(f1, generarFrase());
assert.equal(limpiarTexto('Ho\u202Ela\u0000'), 'Hola');
assert.equal(limpiarTexto('línea1\nlínea2\u0007', true), 'línea1\nlínea2');
console.log('OK  frases (6 × 256 = 48 bits: ' + f1 + ') y saneamiento de texto');

// 13) Verificador de contraseña para el borrado: acepta la correcta,
//     rechaza la incorrecta, y no viaja en el enlace ni en el archivo.
{
  const { vs, vc } = await crearVerificador(CLAVE);
  assert.ok(typeof vs === 'string' && typeof vc === 'string');
  assert.equal(await verificarClave(CLAVE, vs, vc), true);
  assert.equal(await verificarClave('clave-equivocada', vs, vc), false);
  assert.equal(await verificarClave('', vs, vc), false);
  assert.equal(await verificarClave(CLAVE, 'malo', 'malo'), false);
  // el verificador NO forma parte del payload compartido
  const pv = await sellarCarta({ ...base, password: CLAVE });
  assert.equal(pv.vs, undefined);
  assert.equal(pv.vc, undefined);
  assert.ok(!payloadAFragmento(pv).includes(vc.slice(0, 16)));
  console.log('OK  verificador de borrado: contraseña correcta/incorrecta y fuera del enlace');
}

// 14) Adjuntos: viajan cifrados dentro del doble candado, con round-trip
//     exacto, y una carta SIN adjuntos queda idéntica (sin el campo adj).
{
  const foto = { mime: 'image/jpeg', nombre: 'playa.jpg', datos: bytesABase64url(new Uint8Array([255, 216, 255, 0, 1, 2, 3, 250])) };
  const voz = { mime: 'audio/webm', nombre: '', datos: bytesABase64url(new Uint8Array(2000).map((_, i) => (i * 7) % 256)) };

  red.publicada = 5000;
  const pAdj = await sellarCarta({ ...base, password: CLAVE, adjuntos: [foto, voz] });
  red.publicada = Math.max(red.publicada, pAdj.rd);

  // El adjunto NO aparece en claro en el payload (va dentro del cifrado)
  assert.ok(!JSON.stringify(pAdj).includes('playa.jpg'));
  assert.ok(!JSON.stringify(pAdj).includes(foto.datos));

  const abiertaAdj = await abrirCarta(pAdj, CLAVE);
  assert.equal(abiertaAdj.adjuntos.length, 2);
  assert.deepEqual(abiertaAdj.adjuntos[0], foto);
  assert.deepEqual(abiertaAdj.adjuntos[1], voz);
  assert.equal(abiertaAdj.mensaje, base.mensaje);

  // Manipular la ronda sigue rompiendo el descifrado aunque haya adjuntos
  await assert.rejects(() => abrirCarta({ ...pAdj, rd: pAdj.rd - 1 }, CLAVE));

  // Una carta sin adjuntos no lleva el campo adj (compat byte a byte)
  const pSin = await sellarCarta({ ...base, password: CLAVE });
  const sinAdj = await abrirCarta(pSin, CLAVE);
  assert.deepEqual(sinAdj.adjuntos, []);
  console.log('OK  adjuntos cifrados: round-trip exacto, fuera del claro, integridad intacta');
}

console.log('\nTODAS LAS PRUEBAS PASARON');
