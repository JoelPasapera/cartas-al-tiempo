/* Almacén local de cartas selladas. Vive únicamente en localStorage de
   este navegador: nunca sale del dispositivo. */

'use strict';

const CLAVE = 'cartasAlTiempo.v1';

export function cargarCartas() {
  try {
    const bruto = localStorage.getItem(CLAVE);
    const lista = bruto ? JSON.parse(bruto) : [];
    return Array.isArray(lista) ? lista : [];
  } catch (_) { return []; }
}

export function guardarCartas(lista) {
  try { localStorage.setItem(CLAVE, JSON.stringify(lista)); }
  catch (_) { /* almacenamiento no disponible: la sesión sigue funcionando */ }
}

export function borrarTodo() {
  try { localStorage.removeItem(CLAVE); } catch (_) { /* nada que borrar */ }
}
