/* Hora de Lima, Perú (UTC-5 fija, sin horario de verano) y hora confiable.
   La hora se verifica contra servicios públicos para que cambiar el reloj
   del dispositivo no adelante la apertura. Si no hay conexión, se usa la
   hora del dispositivo y se avisa. */

'use strict';

export const LIMA_MS = 5 * 3600 * 1000;

// 'YYYY-MM-DDTHH:MM' interpretado como hora de Lima -> epoch ms universal
export function limaInputAEpoch(str) {
  if (!str) return null;
  let s = String(str);
  if (s.length === 16) s += ':00';
  const t = Date.parse(s + '.000Z');
  if (Number.isNaN(t)) return null;
  return t + LIMA_MS;
}

// epoch ms -> valor 'YYYY-MM-DDTHH:MM' en hora de Lima
export function limaEpochAInput(epoch) {
  const d = new Date(epoch - LIMA_MS);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

// Guarda: con un epoch inválido, Intl.DateTimeFormat.format lanza
// "Invalid time value". Devolvemos un texto de reserva para que un dato
// corrupto nunca rompa la vista que lo muestra.
function fechaValida(epoch) {
  const d = new Date(epoch);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtLimaLargo(epoch) {
  const d = fechaValida(epoch);
  if (!d) return '—';
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima', dateStyle: 'full', timeStyle: 'short'
  }).format(d);
}

export function fmtLimaCorto(epoch) {
  const d = fechaValida(epoch);
  if (!d) return '—';
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima', dateStyle: 'medium', timeStyle: 'short'
  }).format(d);
}

export function fmtLimaHora(epoch) {
  const d = fechaValida(epoch);
  if (!d) return '--:--:--';
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(d);
}

async function pedirConTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/* Devuelve { offset, verificada, fuente }. El offset se suma a Date.now()
   en todos los cálculos de la aplicación. La primera fuente es la propia
   red drand (la misma que custodia las llaves del tiempo). */
export async function obtenerHoraConfiable() {
  try {
    const { horaDesdeDrand } = await import('./tiempo-cerrado.js');
    const t = await horaDesdeDrand();
    if (Number.isFinite(t)) return { offset: t - Date.now(), verificada: true, fuente: 'drand' };
  } catch (_) { /* siguiente fuente */ }

  try {
    const j = await pedirConTimeout('https://timeapi.io/api/Time/current/zone?timeZone=UTC', 4500);
    const t = Date.UTC(j.year, j.month - 1, j.day, j.hour, j.minute, j.seconds, j.milliSeconds || 0);
    if (Number.isFinite(t)) return { offset: t - Date.now(), verificada: true, fuente: 'timeapi.io' };
  } catch (_) { /* siguiente fuente */ }

  try {
    const j = await pedirConTimeout('https://worldtimeapi.org/api/timezone/Etc/UTC', 4500);
    const t = Number(j.unixtime) * 1000;
    if (Number.isFinite(t)) return { offset: t - Date.now(), verificada: true, fuente: 'worldtimeapi.org' };
  } catch (_) { /* sin conexión */ }

  return { offset: 0, verificada: false, fuente: 'dispositivo' };
}
