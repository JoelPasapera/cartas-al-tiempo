/* Interfaz de Cartas al Tiempo: vistas, formulario de sellado, lista de
   cartas y ceremonia de apertura. Toda la criptografía vive en cripto.js;
   la hora, en hora.js; el archivo autónomo, en sellado.js. */

'use strict';

import { escaparHtml, slug, limpiarTexto } from './util.js';
import {
  limaInputAEpoch, limaEpochAInput,
  fmtLimaLargo, fmtLimaCorto, fmtLimaHora,
  obtenerHoraConfiable
} from './hora.js';
import { sellarCarta, abrirCarta, payloadAFragmento, fragmentoAPayload, generarFrase, crearVerificador, verificarClave } from './cripto.js';
import { cargarCartas, guardarCartas } from './almacen.js';
import { construirArchivoSellado } from './sellado.js';

const $ = (id) => document.getElementById(id);

const estado = {
  offset: 0,
  verificada: false,
  fuente: 'dispositivo',
  horaLista: false,
  cartas: [],
  ultima: null,
  verOcultas: false,
  pendiente: null,
  adjuntos: [],
  grabador: null,
  grabStream: null,
  grabTimer: null,
  intervaloCuenta: null,
  intervaloResync: null,
  payloadAbierto: null
};

function ahora() { return Date.now() + estado.offset; }

/* -------------------------------- Navegación ------------------------------ */

function leerPayloadDeUrl() {
  const hash = location.hash.slice(1);
  if (!hash) return null;
  if (!hash.includes('c=')) return null;
  try {
    return fragmentoAPayload(hash);
  } catch (_) {
    return { __error: true };
  }
}

function mostrarVista(nombre) {
  $('vista-escribir').hidden = nombre !== 'escribir';
  $('vista-cartas').hidden = nombre !== 'cartas';
  $('vista-apertura').hidden = nombre !== 'apertura';
  $('tab-escribir').classList.toggle('activa', nombre === 'escribir');
  $('tab-cartas').classList.toggle('activa', nombre === 'cartas');
  $('tab-escribir').setAttribute('aria-pressed', String(nombre === 'escribir'));
  $('tab-cartas').setAttribute('aria-pressed', String(nombre === 'cartas'));
  if (estado.intervaloCuenta && nombre !== 'apertura') {
    clearInterval(estado.intervaloCuenta);
    estado.intervaloCuenta = null;
  }
  if (estado.intervaloResync && nombre !== 'apertura') {
    clearInterval(estado.intervaloResync);
    estado.intervaloResync = null;
  }
}

function limpiarHash() {
  history.replaceState(null, '', location.pathname + location.search);
}

function enrutar() {
  const payload = leerPayloadDeUrl();
  if (payload) {
    prepararApertura(payload);
  } else {
    mostrarVista('escribir');
  }
}

/* -------------------------------- Hora en vivo ---------------------------- */

function pintarBadgeHora() {
  const b = $('estado-hora');
  if (!estado.horaLista) {
    b.textContent = 'Verificando la hora oficial…';
    b.className = 'badge-hora';
  } else if (estado.verificada) {
    b.textContent = 'Hora verificada por internet';
    b.className = 'badge-hora ok';
  } else {
    b.textContent = 'Sin conexión: usando la hora del dispositivo';
    b.className = 'badge-hora aviso';
  }
}

function actualizarMinimoFecha() {
  $('campo-fecha').min = limaEpochAInput(ahora() + 60 * 1000);
}

async function sincronizarHora(silencioso) {
  const r = await obtenerHoraConfiable();
  if (r.verificada || !estado.verificada) {
    estado.offset = r.offset;
    estado.verificada = r.verificada;
    estado.fuente = r.fuente;
  }
  estado.horaLista = true;
  if (!silencioso) actualizarMinimoFecha();
  pintarBadgeHora();
  refrescarListaCartas();
}

/* ------------------------------ Vista: escribir --------------------------- */

// Límites de longitud: evitan enlaces gigantes, saturar localStorage y
// cargar el navegador con miles de párrafos. Generosos para cartas reales.
const MAX_MENSAJE = 20000;
const MAX_TITULO = 200;
const MAX_NOMBRE = 120;

// Adjuntos: tope total (en bytes reales, antes de base64), lado máximo al
// que se reescala una foto, y umbral a partir del cual una carta se
// considera «solo archivo» (su enlace sería inservible de tan grande).
const MAX_ADJUNTOS_BYTES = 6 * 1024 * 1024;
const MAX_FOTO_DIM = 1600;
const UMBRAL_SOLO_ARCHIVO = 100000;

function leerFormulario() {
  return {
    para: limpiarTexto($('campo-para').value).trim(),
    de: limpiarTexto($('campo-de').value).trim(),
    titulo: limpiarTexto($('campo-titulo').value).trim(),
    mensaje: limpiarTexto($('campo-mensaje').value.replace(/\r\n/g, '\n'), true),
    fechaStr: $('campo-fecha').value,
    clave: $('campo-clave').value,
    visibilidad: (document.querySelector('input[name="visibilidad"]:checked') || {}).value || 'publico'
  };
}

function mostrarErrorFormulario(msg, campo) {
  const e = $('form-error');
  e.textContent = msg;
  e.hidden = false;
  if (campo) campo.focus();
}

function construirEnlace(payload) {
  const base = location.href.split('#')[0];
  return base + '#' + payloadAFragmento(payload);
}

async function manejarSellado(ev) {
  ev.preventDefault();
  $('form-error').hidden = true;

  const f = leerFormulario();
  if (!f.para) return mostrarErrorFormulario('Escribe el nombre de quien recibirá la carta.', $('campo-para'));
  if (f.para.length > MAX_NOMBRE) return mostrarErrorFormulario('El nombre del destinatario es demasiado largo.', $('campo-para'));
  if (f.de.length > MAX_NOMBRE) return mostrarErrorFormulario('Tu nombre es demasiado largo.', $('campo-de'));
  if (f.titulo.length > MAX_TITULO) return mostrarErrorFormulario('El título es demasiado largo (máximo ' + MAX_TITULO + ' caracteres).', $('campo-titulo'));
  if (!f.mensaje.trim()) return mostrarErrorFormulario('La carta está vacía.', $('campo-mensaje'));
  if (f.mensaje.length > MAX_MENSAJE) {
    return mostrarErrorFormulario('La carta es muy larga (máximo ' + MAX_MENSAJE.toLocaleString('es') + ' caracteres). Acórtala un poco.', $('campo-mensaje'));
  }
  if (!f.clave) {
    return mostrarErrorFormulario('La contraseña es obligatoria: es lo que mantiene la carta cerrada. Usa «Generar frase» si quieres una fuerte y fácil de dictar.', $('campo-clave'));
  }
  if (f.clave.length < 8) {
    return mostrarErrorFormulario('La contraseña debe tener al menos 8 caracteres. «Generar frase» te da una fuerte y fácil de dictar.', $('campo-clave'));
  }

  const abreEpoch = limaInputAEpoch(f.fechaStr);
  if (!abreEpoch) return mostrarErrorFormulario('Elige la fecha y hora de apertura.', $('campo-fecha'));
  if (abreEpoch <= ahora() + 60 * 1000) {
    return mostrarErrorFormulario('La apertura debe ser al menos un minuto en el futuro (hora de Lima).', $('campo-fecha'));
  }

  const boton = $('btn-sellar');
  boton.disabled = true;
  boton.textContent = 'Sellando…';

  try {
    const payload = await sellarCarta({
      para: f.para,
      de: f.de,
      titulo: f.titulo,
      mensaje: f.mensaje,
      abreEpoch,
      selladaEpoch: ahora(),
      password: f.clave,
      adjuntos: estado.adjuntos.map((a) => ({ mime: a.mime, nombre: a.nombre, datos: a.datos }))
    });

    // Privado: no se guarda en este navegador, sin rastro local (solo el
    // remitente tendrá el enlace o el archivo). Público: se guarda en «Mis
    // cartas» con su verificador para poder ocultarla o eliminarla luego.
    const registro = { id: crypto.randomUUID(), creada: ahora(), titulo: f.titulo, payload };
    if (f.visibilidad !== 'privado') {
      const { vs, vc } = await crearVerificador(f.clave);
      registro.vs = vs;
      registro.vc = vc;
      registro.oculta = false;
      estado.cartas.push(registro);
      guardarCartas(estado.cartas);
    }
    estado.ultima = registro;
    estado.adjuntos = [];
    renderAdjuntos();

    mostrarResultado(registro);
    refrescarListaCartas();
  } catch (_) {
    mostrarErrorFormulario('No se pudo sellar la carta. Vuelve a intentarlo.');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Sellar la carta';
  }
}

function esLarga(payload) {
  const cuerpo = payload.tl || payload.ct || '';
  return cuerpo.length > 6000;
}

// Cartas cuyo enlace sería inservible de tan grande (adjuntos): se comparten
// solo como archivo. Se detecta por el tamaño del cuerpo cifrado.
function esSoloArchivo(payload) {
  return (payload.tl || '').length > UMBRAL_SOLO_ARCHIVO;
}

function mostrarResultado(registro) {
  const p = registro.payload;
  const soloArchivo = esSoloArchivo(p);
  $('resultado-para').textContent = p.to;
  $('resultado-fecha').textContent = 'Se abrirá el ' + fmtLimaLargo(p.ab) + ' (hora de Lima, Perú)';

  $('bloque-enlace').hidden = soloArchivo;
  $('btn-previa').hidden = soloArchivo;

  const nota = $('nota-enlace');
  if (soloArchivo) {
    nota.textContent = 'Esta carta lleva adjuntos, así que se comparte como archivo. Descárgala y envíala por WhatsApp, correo o la nube:';
  } else {
    const enlace = construirEnlace(p);
    $('enlace-carta').value = enlace;
    $('btn-previa').href = enlace;
    if (esLarga(p)) {
      nota.textContent = 'El mensaje es largo: algunos chats recortan enlaces extensos. Para esta carta conviene enviar el archivo:';
    } else {
      nota.textContent = 'El enlace funciona cuando esta página está publicada en internet. Si vas a enviarla por WhatsApp o correo sin publicar la página, envía el archivo:';
    }
  }

  $('resultado-consejo').textContent = 'Comparte la contraseña por otro medio —o recién el día de la apertura—. Sin ella, la carta no se abre jamás: ni el título ni el mensaje.';

  $('panel-resultado').hidden = false;
  $('panel-resultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch (_) {
    return false;
  }
}

async function copiarEnlace() {
  const campo = $('enlace-carta');
  const boton = $('btn-copiar');
  let ok = await copiarTexto(campo.value);
  if (!ok) {
    campo.select();
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  }
  boton.textContent = ok ? 'Copiado ✓' : 'No se pudo copiar';
  setTimeout(() => { boton.textContent = 'Copiar'; }, 1800);
}

async function descargarSellada(payload, boton) {
  const original = boton ? boton.textContent : '';
  if (boton) { boton.disabled = true; boton.textContent = 'Preparando…'; }
  try {
    const html = await construirArchivoSellado(payload);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Carta-para-' + slug(payload.to) + '.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (_) {
    alert('No se pudo generar el archivo. Comprueba la conexión y vuelve a intentarlo.');
  } finally {
    if (boton) { boton.disabled = false; boton.textContent = original; }
  }
}

function actualizarContador() {
  const n = $('campo-mensaje').value.length;
  let sufijo = '';
  if (n > MAX_MENSAJE) sufijo = ' · demasiado largo (máximo ' + MAX_MENSAJE.toLocaleString('es') + ')';
  else if (n > 4000) sufijo = ' · para textos largos conviene el archivo descargable';
  const c = $('contador-msg');
  c.textContent = n.toLocaleString('es') + (n === 1 ? ' carácter' : ' caracteres') + sufijo;
  c.classList.toggle('excedido', n > MAX_MENSAJE);
}

/* ------------------------------- Adjuntos --------------------------------- */

// Tamaño real aproximado (los datos van en base64: 4 chars ≈ 3 bytes).
function bytesBase64(b64) { return Math.floor((b64 ? b64.length : 0) * 3 / 4); }
function totalAdjuntos() { return estado.adjuntos.reduce((s, a) => s + bytesBase64(a.datos), 0); }

function fmtMB(bytes) {
  const mb = bytes / (1024 * 1024);
  return (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + ' MB';
}

function renderAdjuntos() {
  const ul = $('lista-adjuntos');
  ul.innerHTML = '';
  estado.adjuntos.forEach((a, i) => {
    const esFoto = a.mime.indexOf('image/') === 0;
    const li = document.createElement('li');
    li.className = 'adj-chip';
    li.innerHTML =
      '<span class="adj-icono">' + (esFoto ? '▣' : '♪') + '</span>' +
      '<span class="adj-nombre">' + escaparHtml(a.nombre || (esFoto ? 'Foto' : 'Nota de voz')) +
        ' <span class="adj-peso">· ' + fmtMB(bytesBase64(a.datos)) + '</span></span>' +
      '<button class="adj-quitar" data-quitar="' + i + '" type="button" aria-label="Quitar adjunto">✕</button>';
    ul.appendChild(li);
  });
  const ayuda = $('adjuntos-ayuda');
  if (estado.adjuntos.length) {
    ayuda.innerHTML = 'Van cifrados dentro de la carta (' + fmtMB(totalAdjuntos()) +
      ' de ' + fmtMB(MAX_ADJUNTOS_BYTES) + '). Con adjuntos, la carta se comparte como <strong>archivo</strong>.';
  } else {
    ayuda.innerHTML = 'Una foto o una nota de voz viajan cifradas dentro de la carta. Con adjuntos, la carta se comparte como <strong>archivo</strong> (no como enlace).';
  }
}

function agregarAdjunto(adj) {
  if (totalAdjuntos() + bytesBase64(adj.datos) > MAX_ADJUNTOS_BYTES) {
    alert('Se supera el máximo de adjuntos (' + fmtMB(MAX_ADJUNTOS_BYTES) + '). Quita alguno o usa una foto más ligera.');
    return false;
  }
  estado.adjuntos.push(adj);
  renderAdjuntos();
  return true;
}

// Reescala la foto a MAX_FOTO_DIM de lado mayor y la vuelve JPEG: una foto
// de móvil de varios MB baja a unos cientos de KB sin pérdida visible.
function fotoAAdjunto(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error('lectura'));
    r.onload = () => {
      const img = new Image();
      img.onerror = () => rej(new Error('no es una imagen válida'));
      img.onload = () => {
        let { width: w, height: h } = img;
        const m = MAX_FOTO_DIM;
        if (w > m || h > m) { const s = Math.min(m / w, m / h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const url = c.toDataURL('image/jpeg', 0.82);
        res({ mime: 'image/jpeg', nombre: (file.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg', datos: url.split(',')[1] });
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

async function elegirFotos(fileList) {
  for (const file of Array.from(fileList)) {
    try {
      const adj = await fotoAAdjunto(file);
      if (!agregarAdjunto(adj)) break;
    } catch (_) {
      alert('No se pudo añadir «' + (file.name || 'archivo') + '»: no parece una imagen válida.');
    }
  }
}

function blobABase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(new Error('lectura'));
    r.readAsDataURL(blob);
  });
}

function mejorMimeAudio() {
  const tipos = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
    for (const t of tipos) if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function pintarTiempoGrab(seg) {
  const m = Math.floor(seg / 60), s = seg % 60;
  $('grabacion-tiempo').textContent = m + ':' + String(s).padStart(2, '0');
}

async function iniciarGrabacion() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    alert('Tu navegador no permite grabar audio aquí. Puedes adjuntar un archivo de audio como foto… o probar en otro navegador.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    alert('No se pudo acceder al micrófono. Revisa los permisos del navegador.');
    return;
  }
  const mime = mejorMimeAudio();
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const trozos = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) trozos.push(e.data); };
  rec.onstop = async () => {
    clearInterval(estado.grabTimer);
    stream.getTracks().forEach((t) => t.stop());
    $('grabacion').classList.add('oculto');
    if (!estado.grabCancelada && trozos.length) {
      const blob = new Blob(trozos, { type: rec.mimeType || 'audio/webm' });
      try {
        const datos = await blobABase64(blob);
        agregarAdjunto({ mime: blob.type || 'audio/webm', nombre: 'Nota de voz', datos });
      } catch (_) { alert('No se pudo guardar la grabación.'); }
    }
    estado.grabador = null;
    estado.grabStream = null;
  };

  estado.grabador = rec;
  estado.grabStream = stream;
  estado.grabCancelada = false;
  rec.start();

  let seg = 0;
  pintarTiempoGrab(0);
  $('grabacion').classList.remove('oculto');
  estado.grabTimer = setInterval(() => {
    seg += 1;
    pintarTiempoGrab(seg);
    if (seg >= 300) pararGrabacion(); // tope 5 min
  }, 1000);
}

function pararGrabacion() {
  if (estado.grabador && estado.grabador.state !== 'inactive') estado.grabador.stop();
}

function cancelarGrabacion() {
  estado.grabCancelada = true;
  pararGrabacion();
}

/* ----------------------------- Vista: mis cartas -------------------------- */

function cssId(id) { return (window.CSS && CSS.escape) ? CSS.escape(id) : id; }

function filaConfirmacion(reg, accion) {
  const conClave = !!reg.vc;
  const verbo = accion === 'eliminar' ? 'eliminar' : accion === 'ocultar' ? 'ocultar' : 'mostrar';
  const etiqueta = accion === 'eliminar' ? 'Eliminar' : accion === 'ocultar' ? 'Ocultar' : 'Mostrar';
  const clase = accion === 'eliminar' ? ' peligro' : '';
  return '<div class="confirmar-borrado">' +
    '<span class="aviso-borrado">' +
      (conClave ? 'Escribe la contraseña para ' + verbo + ':' : '¿' + etiqueta + ' esta carta?') +
    '</span>' +
    (conClave
      ? '<input type="password" class="clave-borrar" data-id="' + escaparHtml(reg.id) + '" placeholder="Contraseña" spellcheck="false" autocomplete="off">'
      : '') +
    '<button class="btn btn-fantasma' + clase + '" data-act="confirmar-accion" data-id="' + escaparHtml(reg.id) + '" type="button">' + etiqueta + '</button>' +
    '<button class="btn btn-fantasma" data-act="cancelar-accion" data-id="' + escaparHtml(reg.id) + '" type="button">Cancelar</button>' +
    '<span class="error-borrado" hidden></span>' +
  '</div>';
}

function itemCarta(reg, esOculta) {
  const p = reg.payload;
  const li = document.createElement('li');
  li.className = 'papel carta-item' + (esOculta ? ' es-oculta' : '');

  let cabecera;
  if (esOculta) {
    // Sin título ni destinatario: solo la fecha, para reconocerla sin exponerla.
    cabecera =
      '<div class="datos">' +
        '<p class="quien">Carta oculta <span class="chip oculta-chip">Oculta</span></p>' +
        '<p class="cuando">Se abre el ' + escaparHtml(fmtLimaCorto(p.ab)) + ' (hora de Lima)</p>' +
      '</div>';
  } else {
    const ti = reg.titulo ?? p.ti ?? '';
    const abierta = p.ab <= ahora();
    cabecera =
      '<div class="datos">' +
        '<p class="quien">Para ' + escaparHtml(p.to) +
          (ti ? ' · <span class="titulo-suave">' + escaparHtml(ti) + '</span>' : '') +
          '<span class="chip ' + (abierta ? 'lista' : 'sellada') + '">' + (abierta ? 'Ya puede abrirse' : 'Sellada') + '</span>' +
          (esSoloArchivo(p) ? '<span class="chip adj-chip-lista">Con adjuntos</span>' : '') +
        '</p>' +
        '<p class="cuando">Se abre el ' + escaparHtml(fmtLimaCorto(p.ab)) + ' (hora de Lima)' + (p.pw ? ' · con contraseña' : '') + '</p>' +
      '</div>';
  }

  let acciones;
  if (estado.pendiente && estado.pendiente.id === reg.id) {
    acciones = filaConfirmacion(reg, estado.pendiente.accion);
  } else if (esOculta) {
    acciones =
      '<div class="botones">' +
        '<button class="btn btn-fantasma" data-act="mostrar" data-id="' + escaparHtml(reg.id) + '" type="button">Mostrar</button>' +
        '<button class="btn btn-fantasma peligro" data-act="eliminar" data-id="' + escaparHtml(reg.id) + '" type="button">Eliminar</button>' +
      '</div>';
  } else {
    const soloArchivo = esSoloArchivo(p);
    const copiarYver = soloArchivo ? '' :
      '<button class="btn btn-fantasma" data-act="copiar" data-id="' + escaparHtml(reg.id) + '" type="button">Copiar enlace</button>' +
      '<a class="btn btn-fantasma" href="' + escaparHtml(construirEnlace(p)) + '" target="_blank" rel="noopener">Ver</a>';
    acciones =
      '<div class="botones">' +
        copiarYver +
        '<button class="btn btn-fantasma" data-act="descargar" data-id="' + escaparHtml(reg.id) + '" type="button">Descargar</button>' +
        '<button class="btn btn-fantasma" data-act="ocultar" data-id="' + escaparHtml(reg.id) + '" type="button">Ocultar</button>' +
        '<button class="btn btn-fantasma peligro" data-act="eliminar" data-id="' + escaparHtml(reg.id) + '" type="button">Eliminar</button>' +
      '</div>';
  }

  li.innerHTML = cabecera + acciones;
  return li;
}

function refrescarListaCartas() {
  const lista = $('lista-cartas');
  const vacio = $('cartas-vacio');
  const badge = $('badge-cartas');
  const barra = $('barra-cartas');
  const btnOcultas = $('btn-ver-ocultas');

  lista.innerHTML = '';
  const visibles = estado.cartas.filter((c) => !c.oculta);
  const ocultas = estado.cartas.filter((c) => c.oculta);
  const hay = estado.cartas.length > 0;

  vacio.hidden = hay;
  barra.hidden = ocultas.length === 0;        // la barra solo aloja «Ver ocultas»
  badge.hidden = visibles.length === 0;
  badge.textContent = String(visibles.length);

  btnOcultas.hidden = ocultas.length === 0;
  btnOcultas.textContent = estado.verOcultas ? 'Ocultar las ocultas' : 'Ver ocultas (' + ocultas.length + ')';

  if (!hay) return;

  for (const reg of [...visibles].sort((a, b) => a.payload.ab - b.payload.ab)) {
    lista.appendChild(itemCarta(reg, false));
  }
  if (estado.verOcultas) {
    for (const reg of [...ocultas].sort((a, b) => a.payload.ab - b.payload.ab)) {
      lista.appendChild(itemCarta(reg, true));
    }
  }
}

async function accionEnLista(ev) {
  const boton = ev.target.closest('[data-act]');
  if (!boton) return;
  const reg = estado.cartas.find((c) => c.id === boton.dataset.id);
  if (!reg) return;
  const act = boton.dataset.act;

  if (act === 'copiar') {
    const ok = await copiarTexto(construirEnlace(reg.payload));
    boton.textContent = ok ? 'Copiado ✓' : 'No se pudo';
    setTimeout(() => { boton.textContent = 'Copiar enlace'; }, 1800);

  } else if (act === 'descargar') {
    descargarSellada(reg.payload, boton);

  } else if (act === 'eliminar' || act === 'ocultar' || act === 'mostrar') {
    // Ninguna se aplica de inmediato: piden la contraseña (la que abre la carta).
    estado.pendiente = { id: reg.id, accion: act };
    refrescarListaCartas();
    const campo = document.querySelector('.clave-borrar[data-id="' + cssId(reg.id) + '"]');
    if (campo) campo.focus();

  } else if (act === 'cancelar-accion') {
    estado.pendiente = null;
    refrescarListaCartas();

  } else if (act === 'confirmar-accion') {
    const accion = estado.pendiente ? estado.pendiente.accion : null;
    if (!accion) return;
    const li = boton.closest('li');
    const campo = li ? li.querySelector('.clave-borrar') : null;
    const err = li ? li.querySelector('.error-borrado') : null;

    // Carta sin verificador (creada antes de esta función): solo confirma.
    if (reg.vc) {
      const clave = campo ? campo.value : '';
      if (!clave) { if (err) { err.textContent = 'Escribe la contraseña.'; err.hidden = false; } return; }
      const original = boton.textContent;
      boton.disabled = true;
      boton.textContent = 'Comprobando…';
      const ok = await verificarClave(clave, reg.vs, reg.vc);
      boton.disabled = false;
      boton.textContent = original;
      if (!ok) {
        if (err) { err.textContent = 'La contraseña no es correcta.'; err.hidden = false; }
        if (campo) { campo.value = ''; campo.focus(); }
        return;
      }
    }

    if (accion === 'eliminar') estado.cartas = estado.cartas.filter((c) => c.id !== reg.id);
    else if (accion === 'ocultar') reg.oculta = true;
    else if (accion === 'mostrar') reg.oculta = false;

    estado.pendiente = null;
    guardarCartas(estado.cartas);
    refrescarListaCartas();
  }
}

/* ------------------------------ Vista: apertura --------------------------- */

function prepararApertura(payload) {
  mostrarVista('apertura');
  estado.payloadAbierto = payload;

  $('sobre-escena').hidden = false;
  $('vista-carta').hidden = true;
  $('msg-apertura').hidden = true;
  $('sobre').classList.remove('abierto');
  $('btn-romper').hidden = true;
  $('panel-clave').hidden = true;
  $('msg-listo').hidden = true;
  $('cuenta').style.display = '';

  if (payload.__error) {
    $('apertura-para').textContent = '…';
    $('apertura-de').hidden = true;
    $('apertura-fecha').textContent = '—';
    $('sobre').style.display = 'none';
    $('cuenta').style.display = 'none';
    const e = $('msg-apertura');
    e.textContent = 'Este enlace parece dañado o incompleto. Pide que te lo reenvíen.';
    e.hidden = false;
    return;
  }

  $('sobre').style.display = '';
  $('apertura-para').textContent = payload.to;
  if (payload.de) {
    $('apertura-de-nombre').textContent = payload.de;
    $('apertura-de').hidden = false;
  } else {
    $('apertura-de').hidden = true;
  }
  $('apertura-fecha').textContent = fmtLimaLargo(payload.ab);
  pintarBadgeHora();

  if (estado.intervaloCuenta) clearInterval(estado.intervaloCuenta);
  estado.intervaloCuenta = setInterval(latidoCuenta, 250);
  latidoCuenta();

  // Resincroniza la hora cada 5 minutos mientras se espera
  if (estado.intervaloResync) clearInterval(estado.intervaloResync);
  estado.intervaloResync = setInterval(() => { sincronizarHora(true); }, 5 * 60 * 1000);
}

function latidoCuenta() {
  const p = estado.payloadAbierto;
  if (!p || p.__error) return;
  const r = p.ab - ahora();

  if (r <= 0) {
    $('cuenta').style.display = 'none';
    $('msg-listo').hidden = false;
    if (p.pw) {
      if ($('panel-clave').hidden) {
        $('panel-clave').hidden = false;
        $('campo-clave-abrir').focus();
      }
    } else {
      $('btn-romper').hidden = false;
    }
    return;
  }

  const pad = (n) => String(n).padStart(2, '0');
  $('cd-dias').textContent = String(Math.floor(r / 86400000));
  $('cd-horas').textContent = pad(Math.floor((r % 86400000) / 3600000));
  $('cd-min').textContent = pad(Math.floor((r % 3600000) / 60000));
  $('cd-seg').textContent = pad(Math.floor((r % 60000) / 1000));
}

async function intentarAbrir(passwordTxt, boton) {
  const p = estado.payloadAbierto;
  if (!p || p.__error) return;
  if (p.ab - ahora() > 0) return; // aún sellada

  $('msg-apertura').hidden = true;
  const textoOriginal = boton ? boton.textContent : '';
  if (boton) {
    boton.disabled = true;
    boton.textContent = p.v >= 4 ? 'Pidiendo la llave del tiempo…' : 'Abriendo…';
  }

  try {
    const { titulo, mensaje } = await abrirCarta(p, passwordTxt);
    revelarCarta(p, titulo, mensaje);
  } catch (err) {
    const e = $('msg-apertura');
    if (err && err.codigo === 'LLAVE_FUTURA') {
      e.textContent = 'La red publica la llave de esta carta exactamente a la hora sellada. Faltan unos segundos: vuelve a intentarlo.';
    } else if (err && err.codigo === 'SIN_RED') {
      e.textContent = 'Sin conexión: abrir la carta necesita internet, porque la llave del tiempo vive en la red.';
    } else {
      e.textContent = p.pw
        ? 'La contraseña no es correcta.'
        : 'No se pudo abrir la carta. El enlace puede estar incompleto.';
    }
    e.hidden = false;
  } finally {
    if (boton) { boton.disabled = false; boton.textContent = textoOriginal; }
  }
}

function revelarCarta(payload, tituloTxt, texto) {
  $('carta-para').textContent = payload.to;

  const titulo = $('carta-titulo');
  if (tituloTxt) { titulo.textContent = tituloTxt; titulo.hidden = false; }
  else titulo.hidden = true;

  const cuerpo = $('carta-cuerpo');
  cuerpo.innerHTML = '';
  texto.split(/\n{2,}/).forEach((parr) => {
    const el = document.createElement('p');
    el.textContent = parr;
    cuerpo.appendChild(el);
  });

  const firma = $('carta-firma');
  if (payload.de) { firma.textContent = '— ' + payload.de; firma.hidden = false; }
  else firma.hidden = true;

  $('carta-meta').textContent = 'Sellada el ' + fmtLimaCorto(payload.se) + ' · hora de Lima, Perú';

  // El sello se parte, la solapa se levanta y aparece la carta
  $('sobre').classList.add('abierto');
  const reducido = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    $('sobre-escena').hidden = true;
    $('vista-carta').hidden = false;
    window.scrollTo({ top: 0, behavior: reducido ? 'auto' : 'smooth' });
  }, reducido ? 40 : 950);

  if (estado.intervaloCuenta) { clearInterval(estado.intervaloCuenta); estado.intervaloCuenta = null; }
  if (estado.intervaloResync) { clearInterval(estado.intervaloResync); estado.intervaloResync = null; }
}

/* ---------------------------------- Inicio -------------------------------- */

function irAEscribir(ev) {
  if (ev) ev.preventDefault();
  limpiarHash();
  mostrarVista('escribir');
  window.scrollTo({ top: 0 });
}

function init() {
  estado.cartas = cargarCartas();
  refrescarListaCartas();

  // Pestañas y enlaces de navegación
  $('tab-escribir').addEventListener('click', irAEscribir);
  $('link-inicio').addEventListener('click', irAEscribir);
  $('link-crear').addEventListener('click', irAEscribir);
  $('link-crear-2').addEventListener('click', irAEscribir);
  $('btn-ir-escribir').addEventListener('click', irAEscribir);
  $('tab-cartas').addEventListener('click', () => {
    limpiarHash();
    refrescarListaCartas();
    mostrarVista('cartas');
  });

  // Formulario
  $('form-carta').addEventListener('submit', manejarSellado);
  $('campo-mensaje').addEventListener('input', actualizarContador);
  actualizarContador();

  // Generador de frase de contraseña
  $('btn-generar-clave').addEventListener('click', () => {
    const campo = $('campo-clave');
    campo.type = 'text';
    campo.value = generarFrase();
    campo.focus();
    campo.select();
  });

  // Adjuntos
  $('btn-adj-foto').addEventListener('click', () => $('input-foto').click());
  $('input-foto').addEventListener('change', async (ev) => {
    await elegirFotos(ev.target.files);
    ev.target.value = '';
  });
  $('btn-adj-voz').addEventListener('click', iniciarGrabacion);
  $('btn-adj-parar').addEventListener('click', pararGrabacion);
  $('btn-adj-cancelar-voz').addEventListener('click', cancelarGrabacion);
  $('lista-adjuntos').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-quitar]');
    if (!b) return;
    estado.adjuntos.splice(Number(b.dataset.quitar), 1);
    renderAdjuntos();
  });

  // Resultado
  $('btn-copiar').addEventListener('click', copiarEnlace);
  $('btn-descargar').addEventListener('click', () => {
    if (estado.ultima) descargarSellada(estado.ultima.payload, $('btn-descargar'));
  });
  $('btn-otra').addEventListener('click', () => {
    $('panel-resultado').hidden = true;
    $('campo-para').value = '';
    $('campo-para').focus();
    $('form-carta').scrollIntoView({ behavior: 'smooth' });
  });
  $('btn-nueva').addEventListener('click', () => {
    $('panel-resultado').hidden = true;
    $('form-carta').reset();
    $('campo-clave').type = 'password';
    estado.adjuntos = [];
    renderAdjuntos();
    actualizarContador();
    $('campo-para').focus();
    $('form-carta').scrollIntoView({ behavior: 'smooth' });
  });

  // Mis cartas
  $('lista-cartas').addEventListener('click', accionEnLista);
  $('btn-ver-ocultas').addEventListener('click', () => {
    estado.verOcultas = !estado.verOcultas;
    estado.pendiente = null;
    refrescarListaCartas();
  });

  // Apertura
  $('btn-romper').addEventListener('click', () => intentarAbrir(null, $('btn-romper')));
  $('btn-abrir').addEventListener('click', () => intentarAbrir($('campo-clave-abrir').value, $('btn-abrir')));
  $('campo-clave-abrir').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') intentarAbrir($('campo-clave-abrir').value, $('btn-abrir'));
  });
  $('btn-imprimir').addEventListener('click', () => window.print());

  // Reloj de Lima en vivo (en el formulario)
  setInterval(() => {
    $('hora-lima-actual').textContent = fmtLimaHora(ahora());
  }, 1000);
  $('hora-lima-actual').textContent = fmtLimaHora(ahora());

  // Valor inicial razonable para la fecha: mañana a esta hora
  actualizarMinimoFecha();
  if (!$('campo-fecha').value) {
    $('campo-fecha').value = limaEpochAInput(ahora() + 24 * 3600 * 1000);
  }

  // Hora confiable y ruta inicial
  sincronizarHora(false);
  window.addEventListener('hashchange', enrutar);
  enrutar();
}

document.addEventListener('DOMContentLoaded', init);
