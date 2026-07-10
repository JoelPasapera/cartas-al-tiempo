// Prueba de humo del ARCHIVO AUTÓNOMO con adjuntos (node humo-sellado.mjs).
// Construye el .html sellado, lo carga en jsdom ejecutando sus scripts, y
// llama a su revelar() real con adjuntos para comprobar que pinta la foto
// (<img data:...>) y la nota de voz (<audio data:...> + descarga).
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { bls12_381 } from '@noble/curves/bls12-381';
import { sha256 } from '@noble/hashes/sha256';

const vendor = readFileSync(new URL('./js/vendor/tlock.min.js', import.meta.url), 'utf8');
(0, eval)(vendor); // define globalThis.tlock (para sellar en node)
const { QUICKNET, _usarRedDePruebas } = await import('./js/tiempo-cerrado.js');
const { sellarCarta } = await import('./js/cripto.js');
const { construirArchivoSellado } = await import('./js/sellado.js');

// Red drand falsa solo para sellar (no se descifra en esta prueba)
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
const sk = BigInt('0x' + Buffer.from(bls12_381.utils.randomPrivateKey()).toString('hex'));
const pk = Buffer.from(bls12_381.G2.ProjectivePoint.BASE.multiply(sk).toRawBytes(true)).toString('hex');
_usarRedDePruebas({ info: { ...QUICKNET, public_key: pk, genesis_time: Math.floor(Date.now() / 1000) - 3000, hash: 'aa'.repeat(32) }, espejos: ['x'], fetchMirror: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) });

const payload = await sellarCarta({ para: 'José', de: 'Ana', titulo: 'Boda', mensaje: 'hola', abreEpoch: Date.now() + 3600e3, selladaEpoch: Date.now(), password: 'clave-larga-uno' });
const html = await construirArchivoSellado(payload, vendor);

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    window.scrollTo = () => {};
    window.fetch = () => Promise.reject(new Error('sin red'));
  }
});
const { window } = dom;
await new Promise((r) => setTimeout(r, 300)); // deja evaluar los <script>

let fallos = 0;
const ok = (c, m) => { console.log((c ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + m); if (!c) fallos++; };

ok(typeof window.revelar === 'function', 'el archivo expone revelar()');

const fotoB64 = Buffer.from([255, 216, 255, 0, 1, 2, 3]).toString('base64');
const vozB64 = Buffer.from(new Uint8Array(1200).map((_, i) => i % 256)).toString('base64');
window.revelar({ t: 'Boda', m: 'Escucha esto el día de tu boda', adj: [
  { mime: 'image/jpeg', nombre: 'playa.jpg', datos: fotoB64 },
  { mime: 'audio/webm', nombre: 'Nota de voz', datos: vozB64 }
] });
await new Promise((r) => setTimeout(r, 50));

const cont = window.document.getElementById('adjuntos');
const img = cont.querySelector('img');
const audio = cont.querySelector('audio');
const descarga = cont.querySelector('a.adj-descargar');

ok(!!img, 'pinta una <img> para la foto');
ok(img && img.src === 'data:image/jpeg;base64,' + fotoB64, 'la <img> usa el data: URL correcto');
ok(!!audio, 'pinta un <audio> para la nota de voz');
ok(audio && audio.getAttribute('src') === 'data:audio/webm;base64,' + vozB64, 'el <audio> usa el data: URL correcto');
ok(audio && audio.controls === true, 'el <audio> tiene controles');
ok(!!descarga && descarga.getAttribute('download') === 'Nota de voz', 'ofrece descargar el audio (reserva de compatibilidad)');

console.log('\n' + (fallos === 0 ? '\x1b[32mARCHIVO AUTÓNOMO CON ADJUNTOS OK\x1b[0m' : '\x1b[31m' + fallos + ' FALLOS\x1b[0m'));
process.exit(fallos === 0 ? 0 : 1);
