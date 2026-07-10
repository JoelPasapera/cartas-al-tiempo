// Prueba de humo del flujo de la lista con jsdom (node humo.mjs)
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';


const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const vendor = readFileSync(new URL('./js/vendor/tlock.min.js', import.meta.url), 'utf8');

const dom = new JSDOM(html, {
  url: 'https://ejemplo.local/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
const { document } = window;

// Entorno mínimo del navegador
globalThis.window = window;
globalThis.document = document;
globalThis.location = window.location;
globalThis.history = window.history;
globalThis.localStorage = window.localStorage;
globalThis.Blob = window.Blob;
globalThis.URL = window.URL;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView || function () {};
window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || function () {};
window.scrollTo = () => {};
window.alert = () => {};
globalThis.alert = () => {};
window.confirm = () => true;
// Sin red: drand/timeapi fallan → hora del dispositivo (suficiente para la lista)
const fetchFalso = () => Promise.reject(new Error('sin red en la prueba'));
globalThis.fetch = fetchFalso;
window.fetch = fetchFalso;
// tlock (para sellar): se evalúa en el contexto global
(0, eval)(vendor);
window.tlock = globalThis.tlock;

const $ = (id) => document.getElementById(id);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let fallos = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fallos++; };

// Cargar la app (módulo ES real)
await import('./js/app.js');
document.dispatchEvent(new window.Event('DOMContentLoaded'));
await espera(200); // deja correr init (los fetch de hora fallan rápido)

// --- Cableado de adjuntos (canvas/micrófono no existen en jsdom: solo la conexión) ---
let fotoAbierta = false;
$('input-foto').click = () => { fotoAbierta = true; };
$('btn-adj-foto').dispatchEvent(new window.Event('click', { bubbles: true }));
ok(fotoAbierta, 'el botón «Añadir foto» abre el selector de archivos');
let avisoVoz = '';
globalThis.alert = (m) => { avisoVoz = String(m); };
$('btn-adj-voz').dispatchEvent(new window.Event('click', { bubbles: true }));
await espera(50);
ok(/micrófono|grabar/i.test(avisoVoz), 'sin micrófono, «Grabar voz» avisa con gracia (no rompe)');
globalThis.alert = () => {};

// --- Crear una carta PÚBLICA ---
function rellenar({ para, mensaje, clave, visibilidad }) {
  $('campo-para').value = para;
  $('campo-mensaje').value = mensaje;
  $('campo-clave').value = clave;
  // fecha: mañana
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  $('campo-fecha').value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  document.querySelector('input[name="visibilidad"][value="' + visibilidad + '"]').checked = true;
}

const form = $('form-carta');
rellenar({ para: 'Ana', mensaje: 'hola pública', clave: 'clave-larga-uno', visibilidad: 'publico' });
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await espera(1800); // sellado: PBKDF2 + tlock

const items = () => [...$('lista-cartas').querySelectorAll('li')];
ok($('badge-cartas').textContent === '1', 'carta pública aparece en la lista (badge=1, obtenido ' + $('badge-cartas').textContent + ')');
ok(items().length === 1, 'un item visible en la lista');

// --- Crear una carta PRIVADA (no debe guardarse) ---
rellenar({ para: 'Beto', mensaje: 'hola privada', clave: 'clave-larga-dos', visibilidad: 'privado' });
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await espera(1500);
ok($('badge-cartas').textContent === '1', 'carta privada NO se guarda (badge sigue 1, obtenido ' + $('badge-cartas').textContent + ')');

// --- OCULTAR la carta pública (con contraseña) ---
document.querySelector('[data-act="ocultar"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await espera(50);
const campoOcultar = document.querySelector('.clave-borrar');
ok(!!campoOcultar, 'aparece el campo de contraseña al ocultar');
// contraseña incorrecta primero
campoOcultar.value = 'incorrecta';
document.querySelector('[data-act="confirmar-accion"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await espera(900);
ok(items().length >= 1 && !!document.querySelector('.error-borrado:not([hidden])'), 'contraseña incorrecta → error, no oculta');
// contraseña correcta
document.querySelector('.clave-borrar').value = 'clave-larga-uno';
document.querySelector('[data-act="confirmar-accion"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await espera(900);
ok($('badge-cartas').textContent === '0', 'tras ocultar, badge de visibles = 0 (obtenido ' + $('badge-cartas').textContent + ')');
ok(!$('btn-ver-ocultas').hidden, 'aparece el botón «Ver ocultas»');
ok(/Ver ocultas \(1\)/.test($('btn-ver-ocultas').textContent), 'el botón indica «Ver ocultas (1)»');

// --- VER OCULTAS: la carta oculta se muestra SIN título ni destinatario ---
$('btn-ver-ocultas').dispatchEvent(new window.Event('click', { bubbles: true }));
await espera(50);
const ocultaLi = items()[0];
ok(!!ocultaLi && /Carta oculta/.test(ocultaLi.textContent), 'la carta oculta se lista como «Carta oculta»');
ok(!!ocultaLi && !/Ana/.test(ocultaLi.textContent), 'la carta oculta NO revela el destinatario');

// --- MOSTRAR de nuevo (con contraseña) ---
document.querySelector('[data-act="mostrar"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await espera(50);
document.querySelector('.clave-borrar').value = 'clave-larga-uno';
document.querySelector('[data-act="confirmar-accion"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await espera(900);
ok($('badge-cartas').textContent === '1', 'tras mostrar, la carta vuelve a visibles (badge=1, obtenido ' + $('badge-cartas').textContent + ')');
ok($('btn-ver-ocultas').hidden, '«Ver ocultas» desaparece (0 ocultas)');

// --- ELIMINAR (con contraseña) ---
document.querySelector('[data-act="eliminar"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await espera(50);
document.querySelector('.clave-borrar').value = 'clave-larga-uno';
document.querySelector('[data-act="confirmar-accion"]').dispatchEvent(new window.Event('click', { bubbles: true }));
await espera(900);
ok($('badge-cartas').hidden || $('badge-cartas').textContent === '0', 'tras eliminar, la lista queda vacía');
ok(items().length === 0, 'no quedan items en la lista');

console.log('\n' + (fallos === 0 ? '\x1b[32mPRUEBA DE HUMO OK\x1b[0m' : '\x1b[31m' + fallos + ' FALLOS\x1b[0m'));
process.exit(fallos === 0 ? 0 : 1);
