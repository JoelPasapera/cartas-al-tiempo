/* Genera un documento .html autónomo con la carta cifrada dentro: cuenta
   regresiva, verificación de hora, candado temporal (tlock/drand) y
   descifrado propios. Puede enviarse por WhatsApp o correo y abrirse sin
   esta página; solo necesita internet en el momento de abrir, para pedir
   a la red drand la llave del tiempo. La biblioteca tlock va incrustada
   en el propio archivo (sin dependencias externas). */

'use strict';

import { escaparHtml } from './util.js';
import { fmtLimaLargo, fmtLimaCorto } from './hora.js';
import { QUICKNET, ESPEJOS_DRAND } from './tiempo-cerrado.js';

let vendorCache = null;

async function obtenerVendor() {
  if (vendorCache) return vendorCache;
  const r = await fetch(new URL('vendor/tlock.min.js', import.meta.url));
  if (!r.ok) throw new Error('No se pudo leer la biblioteca de tiempo.');
  vendorCache = await r.text();
  return vendorCache;
}

export async function construirArchivoSellado(payload, vendorJs = null) {
  const vendor = (vendorJs || await obtenerVendor())
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');

  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const paraTxt = escaparHtml(payload.to);
  const deTxt = payload.de ? escaparHtml(payload.de) : '';
  const tituloDoc = escaparHtml('Carta sellada para ' + payload.to);
  const fechaTxt = escaparHtml(fmtLimaLargo(payload.ab));

  return '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<meta name="referrer" content="no-referrer">\n' +
'<meta name="robots" content="noindex, nofollow">\n' +
'<title>' + tituloDoc + '</title>\n' +
'<style>\n' +
':root{--tinta:#202a44;--tinta-osc:#141b2e;--papel:#f7f1e3;--lacre:#9e2b25;--oro:#c8a24b;--claro:#e9e2cf;--texto:#2b2f3e}\n' +
'*{box-sizing:border-box}\n' +
'body{margin:0;min-height:100vh;font:16px/1.6 Georgia,"Times New Roman",serif;color:var(--claro);' +
'background:radial-gradient(900px 600px at 50% -10%,#2b3757 0%,var(--tinta) 45%,var(--tinta-osc) 100%) fixed var(--tinta-osc);' +
'display:flex;flex-direction:column;align-items:center;padding:2.2rem 1rem 3rem;text-align:center}\n' +
'.eyebrow{font-family:system-ui,sans-serif;font-size:.72rem;letter-spacing:.22em;text-transform:uppercase;color:var(--oro);margin:0 0 .5rem}\n' +
'h1{font-size:clamp(1.6rem,5vw,2.3rem);margin:0 0 .3rem;color:#f2ead3;font-weight:600}\n' +
'.de{margin:0;font-style:italic;opacity:.9}\n' +
'.fecha{margin:.4rem 0 0;opacity:.85}.fecha strong{color:#f0e6c8}\n' +
'.badge{display:inline-block;font-family:system-ui,sans-serif;font-size:.74rem;border:1px solid rgba(233,226,207,.25);border-radius:999px;padding:.25rem .9rem;margin-top:.9rem;opacity:.85}\n' +
'.sello{width:118px;height:118px;margin:2rem auto 1.6rem;filter:drop-shadow(0 14px 26px rgba(8,12,26,.55));transition:transform .7s ease,opacity .6s ease}\n' +
'.sello.roto{transform:scale(1.15) rotate(9deg);opacity:0}\n' +
'.cuenta{display:grid;grid-template-columns:repeat(4,minmax(60px,90px));gap:.6rem;justify-content:center;font-family:system-ui,sans-serif}\n' +
'.celda{background:linear-gradient(180deg,#26314f,#1b2440);border:1px solid rgba(200,162,75,.35);border-radius:8px;padding:.65rem .3rem .5rem}\n' +
'.cifra{display:block;font-size:clamp(1.4rem,5vw,1.9rem);line-height:1;color:var(--oro);font-variant-numeric:tabular-nums;font-family:Georgia,serif;font-weight:600}\n' +
'.celda small{display:block;margin-top:.3rem;font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;opacity:.55}\n' +
'.listo{font-style:italic;font-size:1.2rem;color:#f0e6c8;margin:1.4rem 0 .3rem}\n' +
'button{font:600 1rem system-ui,sans-serif;color:#fbf3e2;background:linear-gradient(180deg,#ad3b31,var(--lacre) 55%,#7c1f1a);' +
'border:none;border-radius:999px;padding:.8rem 2rem;cursor:pointer;box-shadow:0 6px 16px rgba(124,31,26,.4);margin-top:.8rem}\n' +
'button:disabled{opacity:.55;cursor:wait}\n' +
'input{font:1rem system-ui,sans-serif;color:var(--claro);background:rgba(233,226,207,.07);border:1px solid rgba(233,226,207,.3);border-radius:8px;padding:.6rem .8rem;width:min(260px,80vw)}\n' +
'.oculto{display:none!important}\n' +
'.error{color:#e8a49e;font-family:system-ui,sans-serif;font-size:.9rem;margin-top:.9rem;max-width:420px}\n' +
'.carta{background:var(--papel);color:var(--texto);max-width:660px;width:100%;text-align:left;border-radius:8px;' +
'padding:clamp(1.5rem,5vw,2.8rem);box-shadow:0 22px 48px rgba(10,14,28,.4);margin-top:1.4rem}\n' +
'.carta .cab{font-family:system-ui,sans-serif;font-size:.74rem;letter-spacing:.18em;text-transform:uppercase;color:#6b6653;margin:0 0 1rem}\n' +
'.carta h2{margin:0 0 1.2rem;font-weight:600}\n' +
'.carta .cuerpo p{margin:0 0 1.05em;font-size:1.18rem;line-height:1.75;white-space:pre-wrap;overflow-wrap:break-word}\n' +
'.adjuntos{margin-top:1.4rem;display:flex;flex-direction:column;gap:1rem}\n' +
'.adjuntos img{max-width:100%;border-radius:8px;display:block}\n' +
'.adjuntos audio{width:100%}\n' +
'.adjuntos .adj-audio{background:#efe5ce;border-radius:12px;padding:.7rem .8rem}\n' +
'.adjuntos .adj-descargar{display:inline-block;margin-top:.4rem;font-size:.82rem;color:#7c1f1a}\n' +
'.carta .firma{font-style:italic;text-align:right;margin:1.5rem 0 0;font-size:1.15rem}\n' +
'.carta .pie{margin-top:2rem;padding-top:1rem;border-top:1px solid #e2d5b6;font-family:system-ui,sans-serif;font-size:.76rem;color:#6b6653}\n' +
'@media (prefers-reduced-motion: reduce){.sello{transition:none}}\n' +
'@media print{body{background:#fff;color:#000;display:block}.escena{display:none}.carta{box-shadow:none;max-width:100%}}\n' +
'</style>\n</head>\n<body>\n' +
'<div class="escena" id="escena">\n' +
'  <p class="eyebrow">Una carta espera</p>\n' +
'  <h1>Para ' + paraTxt + '</h1>\n' +
(deTxt ? '  <p class="de">De parte de ' + deTxt + '</p>\n' : '') +
'  <p class="fecha">Se abre el <strong>' + fechaTxt + '</strong> <span style="opacity:.7">(hora de Lima, Perú)</span></p>\n' +
'  <p class="badge" id="badge">Verificando la hora oficial…</p>\n' +
'  <svg class="sello" id="sello" viewBox="0 0 120 120" aria-hidden="true">\n' +
'    <g fill="#9e2b25"><circle cx="60" cy="18" r="9"/><circle cx="89" cy="26" r="8"/><circle cx="104" cy="50" r="8"/>' +
'<circle cx="103" cy="76" r="9"/><circle cx="86" cy="97" r="8"/><circle cx="60" cy="104" r="9"/>' +
'<circle cx="33" cy="97" r="8"/><circle cx="16" cy="76" r="9"/><circle cx="17" cy="50" r="8"/><circle cx="31" cy="26" r="8"/></g>\n' +
'    <circle cx="60" cy="60" r="47" fill="#9e2b25"/>\n' +
'    <circle cx="60" cy="60" r="37" fill="none" stroke="rgba(26,8,6,.35)" stroke-width="2.5"/>\n' +
'    <path d="M45 40h30v6l-11.5 14L75 74v6H45v-6l11.5-14L45 46z" fill="#f7f1e3" opacity=".95"/>\n' +
'  </svg>\n' +
'  <div class="cuenta" id="cuenta">\n' +
'    <div class="celda"><span class="cifra" id="d">–</span><small>días</small></div>\n' +
'    <div class="celda"><span class="cifra" id="h">–</span><small>horas</small></div>\n' +
'    <div class="celda"><span class="cifra" id="m">–</span><small>min</small></div>\n' +
'    <div class="celda"><span class="cifra" id="s">–</span><small>seg</small></div>\n' +
'  </div>\n' +
'  <p class="listo oculto" id="listo">El momento llegó.</p>\n' +
'  <div class="oculto" id="zona-clave"><input type="password" id="clave" placeholder="Contraseña" spellcheck="false" autocomplete="off"> <button id="abrir">Abrir</button></div>\n' +
'  <button class="oculto" id="romper">Romper el sello</button>\n' +
'  <p class="error oculto" id="err"></p>\n' +
'</div>\n' +
'<article class="carta oculto" id="carta">\n' +
'  <p class="cab">Para ' + paraTxt + '</p>\n' +
'  <h2 class="oculto" id="titu"></h2>\n' +
'  <div class="cuerpo" id="cuerpo"></div>\n' +
'  <div class="adjuntos" id="adjuntos"></div>\n' +
(deTxt ? '  <p class="firma">— ' + deTxt + '</p>\n' : '') +
'  <p class="pie">Sellada el ' + escaparHtml(fmtLimaCorto(payload.se)) + ' · hora de Lima, Perú</p>\n' +
'</article>\n' +
'<script>\n' + vendor + '\n<\/script>\n' +
'<script>\n' +
'"use strict";\n' +
'var P = ' + json + ';\n' +
'var INFO = ' + JSON.stringify(QUICKNET).replace(/</g, '\\u003c') + ';\n' +
'var ESPEJOS = ' + JSON.stringify(ESPEJOS_DRAND) + ';\n' +
'var offset = 0;\n' +
'function b64(str){str=String(str).replace(/-/g,"+").replace(/_/g,"/");while(str.length%4)str+="=";' +
'var bin=atob(str),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;}\n' +
'function el(id){return document.getElementById(id);}\n' +
'function aad(){var e=new TextEncoder();var c=["CartasAlTiempo","v"+P.v,P.to,P.de];' +
'if(P.v<3)c.push(P.ti);c.push(String(P.ab),String(P.se),P.tz);' +
'if(P.v>=3)c.push(P.s,String(P.it));if(P.v>=4)c.push(String(P.rd));return e.encode(c.join("\\u001f"));}\n' +
'function pedir(url,ms){return new Promise(function(res,rej){var c=new AbortController();' +
'var t=setTimeout(function(){c.abort();rej(new Error("timeout"));},ms);' +
'fetch(url,{signal:c.signal,cache:"no-store"}).then(function(r){clearTimeout(t);res(r);})' +
'.catch(function(e){clearTimeout(t);rej(e);});});}\n' +
'function armadura(compacta){var lineas=compacta.match(/.{1,64}/g)||[];\n' +
'  return "-----BEGIN AGE ENCRYPTED FILE-----\\n"+lineas.join("\\n")+"\\n-----END AGE ENCRYPTED FILE-----\\n";}\n' +
'function obtenerBeacon(ronda){\n' +
'  var i=0,huboFuturo=false;\n' +
'  function intento(){\n' +
'    if(i>=ESPEJOS.length){var e=new Error(huboFuturo?"llave futura":"sin red");' +
'e.codigo=huboFuturo?"LLAVE_FUTURA":"SIN_RED";return Promise.reject(e);}\n' +
'    var base=ESPEJOS[i++];\n' +
'    return pedir(base+"/"+INFO.hash+"/public/"+ronda,6000).then(function(r){\n' +
'      if(r.status===404||r.status===425){huboFuturo=true;return intento();}\n' +
'      if(!r.ok)return intento();\n' +
'      return r.json().then(function(j){\n' +
'        if(!j||typeof j.signature!=="string")return intento();\n' +
'        return Promise.resolve().then(function(){return tlock.verifyBeacon(INFO,j,ronda);})\n' +
'          .then(function(valido){return valido?j:intento();})\n' +
'          .catch(function(){return intento();});\n' +
'      });\n' +
'    }).catch(function(e){if(e&&e.codigo)throw e;return intento();});\n' +
'  }\n' +
'  return intento();\n' +
'}\n' +
'function clienteTiempo(){var info=Object.assign({},INFO,{genesis_time:1});\n' +
'  return {options:{disableBeaconVerification:true,noCache:true},\n' +
'    chain:function(){return {baseUrl:"fijada",info:function(){return Promise.resolve(info);}};},\n' +
'    latest:function(){return Promise.reject(new Error("no disponible"));},\n' +
'    get:function(r){return obtenerBeacon(r);}};}\n' +
'function horaDrand(){\n' +
'  var i=0;\n' +
'  function intento(){\n' +
'    if(i>=ESPEJOS.length)return Promise.reject(new Error("sin red"));\n' +
'    var base=ESPEJOS[i++];\n' +
'    return pedir(base+"/"+INFO.hash+"/public/latest",4000).then(function(r){\n' +
'      if(!r.ok)return intento();\n' +
'      return r.json().then(function(j){var rd=Number(j&&j.round);\n' +
'        if(!isFinite(rd)||rd<1)return intento();\n' +
'        return Promise.resolve().then(function(){return tlock.verifyBeacon(INFO,j,rd);})\n' +
'          .then(function(valido){return valido?(INFO.genesis_time+(rd-1)*INFO.period)*1000+1500:intento();})\n' +
'          .catch(function(){return intento();});});\n' +
'    }).catch(function(){return intento();});\n' +
'  }\n' +
'  return intento();\n' +
'}\n' +
'function ahora(){return Date.now()+offset;}\n' +
'function pad(n){return String(n).padStart(2,"0");}\n' +
'var fin=false;\n' +
'function tic(){\n' +
'  var r=P.ab-ahora();\n' +
'  if(r<=0){\n' +
'    if(!fin){fin=true;el("cuenta").classList.add("oculto");el("listo").classList.remove("oculto");\n' +
'      if(P.pw){el("zona-clave").classList.remove("oculto");}else{el("romper").classList.remove("oculto");}}\n' +
'    return;\n' +
'  }\n' +
'  el("d").textContent=Math.floor(r/86400000);\n' +
'  el("h").textContent=pad(Math.floor(r%86400000/3600000));\n' +
'  el("m").textContent=pad(Math.floor(r%3600000/60000));\n' +
'  el("s").textContent=pad(Math.floor(r%60000/1000));\n' +
'}\n' +
'function claveAES(passwordTxt){\n' +
'  if(P.pw){\n' +
'    var enc=new TextEncoder();\n' +
'    return crypto.subtle.importKey("raw",enc.encode(passwordTxt||""),"PBKDF2",false,["deriveKey"]).then(function(base){\n' +
'      return crypto.subtle.deriveKey({name:"PBKDF2",salt:b64(P.s),iterations:P.it||600000,hash:"SHA-256"},base,' +
'{name:"AES-GCM",length:256},false,["decrypt"]);\n' +
'    });\n' +
'  }\n' +
'  return crypto.subtle.importKey("raw",b64(P.k),{name:"AES-GCM"},false,["decrypt"]);\n' +
'}\n' +
'function pintarAdjuntos(adj){\n' +
'  if(!adj||!adj.length)return;\n' +
'  var cont=el("adjuntos");\n' +
'  adj.forEach(function(a){\n' +
'    if(!a||!a.datos||!a.mime)return;\n' +
'    var url="data:"+a.mime+";base64,"+a.datos;\n' +
'    if(a.mime.indexOf("image/")===0){\n' +
'      var img=document.createElement("img");img.src=url;img.alt=a.nombre||"Foto adjunta";\n' +
'      img.loading="lazy";cont.appendChild(img);\n' +
'    }else if(a.mime.indexOf("audio/")===0){\n' +
'      var caja=document.createElement("div");caja.className="adj-audio";\n' +
'      var au=document.createElement("audio");au.controls=true;au.src=url;au.preload="metadata";\n' +
'      caja.appendChild(au);\n' +
'      var link=document.createElement("a");link.className="adj-descargar";link.href=url;\n' +
'      link.download=a.nombre||"nota-de-voz";link.textContent="Descargar audio";\n' +
'      caja.appendChild(link);cont.appendChild(caja);\n' +
'    }\n' +
'  });\n' +
'}\n' +
'function revelar(obj){\n' +
'  if(obj.t){el("titu").textContent=obj.t;el("titu").classList.remove("oculto");}\n' +
'  else if(P.v<3&&P.ti){el("titu").textContent=P.ti;el("titu").classList.remove("oculto");}\n' +
'  var cuerpo=el("cuerpo");\n' +
'  String(obj.m).split(/\\n{2,}/).forEach(function(parr){\n' +
'    var p=document.createElement("p");p.textContent=parr;cuerpo.appendChild(p);\n' +
'  });\n' +
'  pintarAdjuntos(obj.adj);\n' +
'  el("sello").classList.add("roto");\n' +
'  var reducido=window.matchMedia("(prefers-reduced-motion: reduce)").matches;\n' +
'  setTimeout(function(){el("escena").classList.add("oculto");el("carta").classList.remove("oculto");\n' +
'    window.scrollTo({top:0,behavior:reducido?"auto":"smooth"});},reducido?40:650);\n' +
'}\n' +
'function mensajeError(e){\n' +
'  if(e&&e.codigo==="LLAVE_FUTURA")return "La red publica la llave de esta carta exactamente a la hora sellada. Faltan unos segundos: vuelve a intentarlo.";\n' +
'  if(e&&e.codigo==="SIN_RED")return "Sin conexión: abrir la carta necesita internet, porque la llave del tiempo vive en la red.";\n' +
'  return P.pw?"La contraseña no es correcta.":"No se pudo abrir la carta. El archivo puede estar dañado.";\n' +
'}\n' +
'function interior(){\n' +
'  if(P.v>=4){\n' +
'    return tlock.timelockDecrypt(armadura(P.tl),clienteTiempo()).then(function(buf){return new Uint8Array(buf);});\n' +
'  }\n' +
'  return Promise.resolve(b64(P.ct));\n' +
'}\n' +
'function abrir(passwordTxt,boton){\n' +
'  if(P.ab-ahora()>0)return;\n' +
'  el("err").classList.add("oculto");\n' +
'  if(P.pw&&(P.it||600000)>5000000){var ei=el("err");ei.classList.remove("oculto");' +
'ei.textContent="Par\\u00e1metros inv\\u00e1lidos.";return;}\n' +
'  var original=boton?boton.textContent:"";\n' +
'  if(boton){boton.disabled=true;boton.textContent="Pidiendo la llave del tiempo\\u2026";}\n' +
'  interior().then(function(ct){\n' +
'    if(boton)boton.textContent="Abriendo\\u2026";\n' +
'    var opciones={name:"AES-GCM",iv:b64(P.iv)};\n' +
'    if(P.v>=2)opciones.additionalData=aad();\n' +
'    return claveAES(passwordTxt).then(function(k){\n' +
'      return crypto.subtle.decrypt(opciones,k,ct);\n' +
'    });\n' +
'  }).then(function(plano){\n' +
'    var obj=JSON.parse(new TextDecoder().decode(plano));\n' +
'    revelar(obj);\n' +
'  }).catch(function(e){\n' +
'    var er=el("err");er.classList.remove("oculto");er.textContent=mensajeError(e);\n' +
'  }).then(function(){\n' +
'    if(boton){boton.disabled=false;boton.textContent=original;}\n' +
'  });\n' +
'}\n' +
'el("romper").addEventListener("click",function(){abrir(null,el("romper"));});\n' +
'el("abrir").addEventListener("click",function(){abrir(el("clave").value,el("abrir"));});\n' +
'el("clave").addEventListener("keydown",function(ev){if(ev.key==="Enter")abrir(el("clave").value,el("abrir"));});\n' +
'horaDrand().catch(function(){\n' +
'  return pedir("https://timeapi.io/api/Time/current/zone?timeZone=UTC",4500).then(function(r){return r.json();})\n' +
'    .then(function(j){return Date.UTC(j.year,j.month-1,j.day,j.hour,j.minute,j.seconds,j.milliSeconds||0);});\n' +
'}).then(function(t){offset=t-Date.now();\n' +
'  el("badge").textContent="Hora verificada por internet";\n' +
'}).catch(function(){\n' +
'  el("badge").textContent="Sin conexión: usando la hora del dispositivo";\n' +
'}).then(function(){tic();setInterval(tic,250);});\n' +
'<\/script>\n</body>\n</html>\n';
}
