# Cartas al Tiempo

Cartas cifradas que solo se abren en la fecha y hora elegidas (hora de Lima, Perú).
Sitio 100 % estático: no hay servidor propio, base de datos ni cuentas.

## Estructura

```
index.html          Página única (escribir · mis cartas · apertura)
styles.css          Estilos y tipografías autoalojadas
js/app.js           Interfaz y flujo
js/cripto.js        Cifrado AES-256-GCM + AAD, PBKDF2 (600 000 iteraciones), frases
js/tiempo-cerrado.js  Candado temporal real (tlock sobre drand quicknet)
js/vendor/tlock.min.js  Biblioteca oficial tlock-js empaquetada y autoalojada
SEGURIDAD.md        Análisis de seguridad: vectores de ataque y defensas
js/hora.js          Hora de Lima (UTC-5) y hora verificada por internet
js/sellado.js       Generador del archivo .html sellado autónomo
js/almacen.js       Lista local de cartas (solo este navegador)
js/util.js          Base64url, escape de HTML
fonts/              8 woff2 locales (cero peticiones a Google Fonts)
_headers            Cabeceras de seguridad (Netlify / Cloudflare Pages)
robots.txt          Sitio no indexable (bórralo si quieres aparecer en buscadores)
test.mjs            Pruebas (node test.mjs)
```

## Probar en local

Los módulos ES necesitan un servidor (no funciona con doble clic al archivo):

```
npx serve .
```

y abre la dirección que muestre (p. ej. http://localhost:3000).

## Desplegar

**Cloudflare Pages** o **Netlify** (recomendados): arrastra esta carpeta al panel
y listo. Ambos leen `_headers` y aplican las cabeceras de seguridad solos.
Evita GitHub Pages: no permite cabeceras personalizadas.

Para publicar de forma anónima: cuenta creada con un correo alias, 2FA activado
y dominio contratado con protección de datos WHOIS (o el subdominio gratuito
`*.pages.dev` / `*.netlify.app`, que no exige dominio propio).

## Modelo de seguridad y privacidad

- **El contenido nunca sale del navegador.** Se cifra con AES-256-GCM antes de
  generar el enlace o el archivo. El servidor solo entrega archivos estáticos.
- **La carta viaja en el fragmento `#...` del enlace.** Los navegadores no
  envían el fragmento al servidor: no queda en logs del hosting ni de ningún
  intermediario.
- **Metadatos blindados (AAD).** Destinatario, remitente, título y fechas van
  autenticados dentro del cifrado: si alguien altera la fecha de apertura del
  enlace o del archivo, el descifrado falla.
- **Candado temporal criptográfico (no una cuenta atrás de cortesía).**
  Cada carta se cierra además con timelock hacia una ronda de la red drand
  «quicknet» de la League of Entropy (20+ organizaciones independientes:
  Cloudflare, EPFL, Kudelski…). La llave de ese candado es la firma umbral
  que la red publica exactamente a esa hora: **antes no existe en ningún
  lugar del mundo**. Ni el destinatario con la contraseña, ni un experto
  con el archivo, ni quien manipule su reloj o bloquee servidores puede
  abrir antes. Abrir la carta requiere conexión (la llave vive en la red).
- **Hora verificada por internet** para la cuenta regresiva en pantalla
  (primera fuente: la propia red drand). Cambiar el reloj del dispositivo
  no altera nada.
- **Contraseña obligatoria = garantía matemática.** La clave se deriva con
  PBKDF2-SHA-256 (600 000 iteraciones) y **no viaja con la carta**: ni siquiera
  alguien con el enlace y conocimientos técnicos puede leerla antes. El botón
  «Generar frase» crea frases de seis palabras (lista de 256 → 48 bits)
  fáciles de dictar e imposibles de romper en la práctica.
- **El título también viaja cifrado.** El enlace y el archivo solo muestran
  el «sobre»: destinatario, remitente y fechas. Título y mensaje aparecen
  únicamente con la contraseña correcta.
- **Adjuntos (foto y nota de voz).** Se pueden añadir fotos (que se reescalan
  solas) y grabar una nota de voz desde el navegador. Viajan cifrados dentro
  del mismo doble candado; por su tamaño, esas cartas se comparten como
  archivo `.html` en vez de como enlace.
- Análisis completo de ataques y defensas en `SEGURIDAD.md`.
- **Cero rastreo.** Sin analíticas, sin cookies, fuentes autoalojadas. Las
  únicas peticiones externas son a dos servicios públicos de hora (solo ven
  una IP pidiendo la hora; jamás el contenido).
- **Datos locales bajo control.** «Mis cartas» vive en el localStorage de tu
  navegador; el botón «Borrar todas» lo vacía al instante.
- Cabeceras aplicadas por `_headers`: CSP estricta (solo scripts y estilos
  propios), no-referrer, anti-embebido (frame-ancestors), HSTS, nosniff.

## Pruebas

```
npm install
node test.mjs
```

Las pruebas montan una red drand falsa local (misma criptografía que
quicknet) y validan el candado temporal de punta a punta, incluido el
ataque del reloj adelantado.

Verifica cifrado/descifrado con y sin contraseña, rechazo de contraseña
errónea, detección de manipulación de metadatos, conversión de hora de Lima,
compatibilidad con cartas v1 y la integridad del archivo sellado autónomo.
