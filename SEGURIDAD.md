# Análisis de seguridad — Cartas al Tiempo

Análisis desde la perspectiva de un atacante que quiere **leer una carta antes
de tiempo**, **romper la contraseña** o **abusar del sistema**. Formato actual: v3.

## El principio que sostiene todo

Una página estática no puede "esconder" nada de quien la posee: cualquier
persona puede abrir las herramientas del navegador y leer el código o los
datos. Por eso la seguridad de v3 **no depende de la aplicación, sino de las
matemáticas**: el título y el mensaje viajan cifrados con AES-256-GCM y la
clave se deriva de la contraseña con PBKDF2-SHA-256 (600 000 iteraciones).
**La clave nunca viaja con la carta.** Quien no tiene la contraseña no tiene
nada que descifrar, tenga o no conocimientos técnicos.

Desde v4 la fecha también es matemática: cada carta lleva un **segundo
candado, temporal**, cerrado con timelock (tlock) hacia una ronda de la red
drand «quicknet» de la League of Entropy — más de 20 organizaciones
independientes (Cloudflare, EPFL, Kudelski, UCL, Protocol Labs…) que
publican cada 3 segundos una firma umbral BLS sobre el número de ronda.
Esa firma ES la llave del candado temporal y **no existe en ningún lugar
del mundo hasta que la red la emite**, exactamente a su hora. El candado
por contraseña queda DENTRO del candado temporal: antes de la fecha ni
siquiera hay material sobre el que probar contraseñas.

## Qué ve un atacante que intercepta el enlace o el archivo

Visible (el «sobre», por diseño): destinatario, remitente, fecha de apertura,
fecha de sellado, zona horaria, y los parámetros criptográficos (sal, IV,
iteraciones). Nada de esto ayuda a descifrar.

Invisible (dentro del cifrado): **el título, el mensaje y los adjuntos
(fotos, notas de voz) completos**. Los adjuntos viajan dentro del mismo
doble candado que el mensaje —AES-256 + candado temporal, con los metadatos
autenticados (AAD)—, así que heredan todas sus protecciones y no abren
ningún vector nuevo. Por su tamaño, una carta con adjuntos se comparte como
archivo `.html` (no como enlace); ese archivo se abre solo y solo necesita
internet en el momento de abrir, para pedir la llave del tiempo a la red.

## Vectores analizados

### 1. Extraer la clave del enlace o del archivo
**Antes (v1/v2 sin contraseña):** la clave iba dentro del enlace; con las
DevTools se descifraba en segundos. **Ahora:** la contraseña es obligatoria y
la clave no existe en ningún lugar del enlace ni del archivo. *Cerrado.*

### 2. Fuerza bruta contra la contraseña (ataque offline)
El atacante con el archivo puede probar contraseñas sin límite en su propia
máquina; ningún límite de intentos en la página lo frenaría (correría el
ataque fuera de ella). Las defensas reales son dos:

- **Coste por intento:** 600 000 iteraciones de PBKDF2 ≈ 1,2 millones de
  SHA-256 por contraseña probada. Una GPU de gama alta baja de millones de
  intentos/segundo a **miles**.
- **Entropía:** el botón «Generar frase» produce 6 palabras de una lista de
  256 (elección con `crypto.getRandomValues`, sin sesgo modular porque
  2³² es múltiplo exacto de 256) = **48 bits**. Recorrer el espacio completo
  a 8 000 intentos/s por GPU tomaría **más de mil años por GPU**; incluso una
  granja de cien GPUs necesitaría décadas.

El punto débil real es humano: una contraseña corta o adivinable
("julio2026", el nombre del perro) cae ante un ataque de diccionario en
horas. Por eso la interfaz exige mínimo 8 caracteres y empuja hacia la frase
generada. *Mitigado; depende de la calidad de la contraseña.*

### 3. Manipular la fecha del enlace para engañar al destinatario
Ataque: un intermediario (o el propio destinatario) edita el payload y
adelanta `ab` para que la página muestre "el momento llegó" antes de tiempo.
**Defensa:** todos los metadatos visibles —nombres, fechas, sal, iteraciones—
van como *datos autenticados* (AAD) del propio AES-GCM. Cualquier alteración
hace que el descifrado falle, aunque la contraseña sea correcta. Probado en
`test.mjs` con cinco manipulaciones distintas. *Cerrado.*

### 4. Adelantar el reloj o burlar la cuenta regresiva — CERRADO en v4
Antes, la cuenta atrás era una cortesía de interfaz: quien bloqueara los
servicios de hora o llamara al descifrado desde la consola podía llegar al
botón antes de tiempo (aunque sin contraseña no abría nada). **Desde v4 esto
está cerrado criptográficamente**, y así lo demuestran las pruebas
(`test.mjs`, «el ataque del reloj»):

- El descifrado exige la firma BLS de la ronda drand elegida. Para una ronda
  futura, esa firma **no existe todavía** — no está en el enlace, ni en el
  archivo, ni en ningún servidor. No hay nada que robar ni que adivinar.
- Da igual manipular el reloj del sistema, la consola, los hosts o un proxy:
  la decisión de «¿ya se puede?» no la toma ningún reloj local, la toma la
  red al publicar (o no) la firma.
- Un espejo malicioso que responda con una firma falsa tampoco sirve: cada
  firma se **verifica contra la clave pública fijada** antes de usarla
  (`verifyBeacon`) y, además, la matemática del descifrado la rechaza. Si un
  espejo miente o falla, se prueba el siguiente automáticamente, de modo que
  un espejo averiado tampoco puede impedir abrir a su hora (probado en
  `pentest.mjs`).
- Fabricar la firma antes de hora exigiría corromper simultáneamente a una
  mayoría (umbral) de las 20+ organizaciones de la League of Entropy, o
  romper BLS12-381.

Bonus de este diseño: como el cifrado por contraseña vive DENTRO del candado
temporal, **antes de la fecha ni siquiera se puede empezar un ataque de
fuerza bruta contra la contraseña**. El "antes de tiempo" pasó de incómodo a
matemáticamente imposible.

### 5. Inyección de código (XSS) mediante nombres o títulos maliciosos
Ataque: crear una carta cuyo destinatario sea `<script>…</script>` o un
atributo roto, y enviarle el enlace a alguien para ejecutar código en su
navegador. **Defensas en capas:** (a) todo lo que viene del payload se pinta
con `textContent`, nunca como HTML; (b) donde se construye HTML (lista de
cartas, archivo sellado) cada interpolación pasa por escape de `& < > " '`;
(c) la CSP del sitio (`script-src 'self'`, sin `unsafe-inline`) bloquearía
cualquier script inyectado aunque (a) y (b) fallaran; (d) el JSON incrustado
en el archivo sellado escapa `<` como `\u003c`, impidiendo cerrar la etiqueta
`</script>`. Probado con payloads de inyección en `test.mjs`. *Cerrado.*

### 6. Envenenar el prototipo (prototype pollution) vía JSON del enlace
`JSON.parse` de un payload hostil con claves `__proto__` crea propiedades
propias, no toca `Object.prototype`, y la aplicación nunca fusiona el payload
sobre otros objetos. *No aplicable.*

### 7. Enlaces trampa (denegación de servicio)
Ataque: un enlace con `it: 99999999` congelaría el navegador de la víctima
derivando la clave. **Defensa:** tope de 5 000 000 de iteraciones al abrir;
por encima se rechaza al instante. Fragmentos gigantes los corta el propio
límite de URL del navegador. *Cerrado.*

### 8. Robo del contenido por el canal, el servidor o los registros
- El contenido viaja en el **fragmento `#`** del enlace: los navegadores no
  lo envían nunca al servidor → no queda en logs del hosting, proxies ni CDN.
- La cabecera `Referrer-Policy: no-referrer` (más la meta equivalente) impide
  fugas de URL hacia terceros; los fragmentos, además, jamás viajan en el
  encabezado Referer.
- No hay analíticas, cookies ni fuentes externas; las tipografías van en el
  propio sitio. Las únicas peticiones salen hacia dos servicios de hora, que
  solo ven una IP preguntando la hora — nunca contenido.
- HSTS + `upgrade-insecure-requests` fuerzan HTTPS. *Cerrado.*

### 9. Incrustar la página en un sitio hostil (clickjacking)
`frame-ancestors 'none'` + `X-Frame-Options: DENY`. *Cerrado.*

### 10. Compromiso del hosting (el ataque serio)
Si alguien toma la cuenta de Cloudflare/Netlify puede servir JavaScript
alterado que robe las cartas **que se escriban o abran a partir de ese
momento**. Ninguna web puede autodefenderse de su propio servidor
comprometido. Mitigaciones: cuenta de hosting con contraseña única + 2FA;
los archivos `.html` sellados **ya enviados** son inmunes (no dependen del
sitio); y el remitente paranoico puede trabajar con una copia local del
proyecto. *Residual, mitigado.*

### 11. Dispositivo comprometido o compartido
Malware, extensiones espía o alguien con acceso físico ven lo que el usuario
ve: la carta al escribirla o al abrirla, y el historial del navegador guarda
el enlace completo (fragmento incluido). Mitigaciones incorporadas: corrector
ortográfico desactivado en los campos (evita que el "corrector mejorado" de
algunos navegadores o extensiones suban el texto a la nube), botón «Borrar
todas» para vaciar la lista local, y la lista local guarda solo el payload
cifrado (ni el mensaje ni la contraseña se almacenan jamás; el título se
guarda solo en el navegador del remitente para que reconozca sus cartas).
*Fuera del alcance de cualquier web; reducido.*

### 12. Metadatos visibles
Nombres y fechas se ven a propósito (es el sobre). Si un caso exige ocultar
también los nombres, pueden moverse dentro del cifrado con un cambio menor —
el sobre diría solo "Una carta espera". *Decisión de diseño documentada.*

### 13. Nonce/IV reutilizado en AES-GCM
Cada carta genera sal e IV aleatorios nuevos; cada clave derivada es única
por carta, así que jamás se repite un par (clave, IV). *Cerrado.*

### 14. Caracteres invisibles de dirección (suplantación visual)
Texto con marcas RLO/LRO podría disfrazar nombres en pantalla. Se eliminan
al sellar (`limpiarTexto`), junto con caracteres de control. *Cerrado.*

### 15. El candado temporal: modelo de confianza y riesgos residuales
Ser honestos exige decir de quién depende cada garantía:

- **Confianza distribuida, no en un servidor nuestro.** El candado temporal
  descansa en que una mayoría (umbral) de la League of Entropy sea honesta.
  Son 20+ instituciones independientes con años de servicio ininterrumpido;
  el esquema (tlock, de los autores de drand) fue auditado por Kudelski.
  Nuestro sitio, el hosting y los espejos no pueden adelantar nada: solo
  transportan la firma, y una firma falsa no descifra.
- **Abrir requiere internet.** La llave vive en la red; el archivo sellado
  sigue siendo autónomo pero necesita conexión en el momento de abrir. Sin
  red, la aplicación lo explica y no revela nada.
- **Si la red drand cerrara algún día**, las cartas con fecha posterior al
  cierre quedarían sin llave para siempre (los miembros borran sus
  fragmentos de clave). Es un riesgo real pero remoto: la red lleva años en
  producción con respaldo institucional, y el estado de drand es público y
  observable con antelación.
- **No es resistente a computación cuántica.** Como casi toda la
  criptografía actual. Para cartas a décadas vista, cuenta con ello.
- **Precisión ±3 segundos** (una ronda). La cuenta regresiva en pantalla es
  informativa; la llave aparece en su ronda exacta.
- **Denegación de servicio:** bloquear los 4 espejos a un destinatario solo
  retrasa su apertura, nunca la adelanta; en cuanto recupere conexión, abre.
  Y si uno de los espejos está comprometido y devuelve basura, el código lo
  verifica, lo descarta y usa otro (no basta con un espejo malicioso para
  bloquear la apertura).

### 16. Privacidad de red y almacenamiento local (por diseño)
Dos matices honestos que no son fallos, pero conviene conocer:

- **Guardar en «Mis cartas» es opcional (privado/público).** Al crear la
  carta se elige: en **privado** no se guarda nada en el navegador —no deja
  rastro local, solo el remitente conserva el enlace o el archivo—; en
  **público** se guarda en «Mis cartas» para gestionarla después. El mensaje
  y la contraseña NO se guardan jamás en ninguno de los dos casos; de una
  carta pública se guarda solo el «sobre» (destinatario, fechas) y el título,
  y únicamente en este dispositivo.
- **Ocultar, mostrar y eliminar una carta pública exigen la contraseña** (la
  misma que la abre). Se guarda un verificador local —un hash PBKDF2 con sal
  propia, independiente del contenido y que nunca sale del dispositivo—, así
  que en un navegador compartido nadie puede gestionar cartas ajenas sin
  conocer su contraseña. Al **ocultar**, la carta desaparece de la lista y en
  «Ver ocultas» solo se muestra su fecha (ni título ni destinatario) hasta
  que se restaura con la contraseña. Eliminar de la lista no destruye la
  carta: los enlaces y archivos ya enviados seguirán abriéndose a su hora.
- Aun así, «Mis cartas» es almacenamiento del navegador: alguien con acceso
  técnico al dispositivo podría leer el `localStorage` directamente. Para
  privacidad fuerte, crea la carta en **privado** (o en una ventana privada).
- **Abrir la carta hace peticiones a la red drand y a un servicio de hora.**
  Es inevitable: la llave del tiempo vive en la red. Esos servidores ven la
  IP del receptor y el momento de apertura (no el contenido, que nunca sale
  del dispositivo). Para máxima discreción, el receptor puede abrir tras una
  VPN. El contenido en sí sigue viajando solo en el fragmento `#`, que nunca
  llega a ningún servidor.

## Resumen honesto

| Quiere… | ¿Puede? |
|---|---|
| Leer título o mensaje sin la contraseña | No — AES-256, la clave no existe en el enlace |
| Romper la frase generada por fuerza bruta | No en la práctica — 48 bits × PBKDF2 600k |
| Adelantar la fecha editando el enlace | No — AAD y ronda blindadas: el descifrado falla |
| Adelantar el reloj, bloquear hora, usar la consola | No — la llave del tiempo no existe hasta su ronda |
| Abrir antes **teniendo ya la contraseña** | No — el candado temporal es independiente de la contraseña |
| Probar contraseñas antes de la fecha | No — el material atacable está dentro del candado temporal |
| Falsificar la llave desde un espejo malicioso | No — la firma se valida matemáticamente al descifrar |
| Inyectar código vía nombres/título | No — escape + textContent + CSP |
| Congelar el navegador con un enlace trampa | No — tope de iteraciones |
| Leer cartas desde los logs del servidor | No — el fragmento nunca llega al servidor |
| Servir JS malicioso hackeando el hosting | Solo cartas futuras — proteger la cuenta con 2FA |

## Reglas de oro para el remitente

1. Usa **«Generar frase»** (o una contraseña larga propia, nunca datos personales).
2. Envía **enlace/archivo y contraseña por canales distintos**. (Desde v4 ya no hace falta esperar al día D: el candado temporal impide abrir antes incluso con la contraseña.)
3. No reutilices la misma contraseña en varias cartas.
4. Protege la cuenta del hosting con contraseña única y 2FA.
5. Para el máximo secreto, borra la carta de «Mis cartas» tras enviarla (el enlace y el archivo enviados siguen funcionando).
