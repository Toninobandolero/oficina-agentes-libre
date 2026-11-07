// Panel en inglés: envuelve en TR(…) los textos de panel/index.html que tienen traducción en panel/en.js.
//   npm run traducir           aplica (se puede repetir: lo ya envuelto no se toca) y cuenta lo que falta
//   npm run traducir -- faltan lista los textos en español que aún no tienen traducción (para añadirlos a en.js)
// en.js es un diccionario «texto en español → texto en inglés». En las plantillas, ${…} se escribe {0}, {1}…
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { parseDocument, DomUtils } from 'htmlparser2';

const PANEL = process.env.PANEL || path.join(import.meta.dirname, '..', 'panel');
const F_HTML = path.join(PANEL, 'index.html'), F_EN = path.join(PANEL, 'en.js');
const leerEN = () => { const w = {}; new Function('window', fs.readFileSync(F_EN, 'utf8'))(w); return w.EN; };

// Lo que va al principio del script principal y en el <head> (si no está ya)
const RUNTIME = `/* ---------- Idioma: ?lang=en o el del navegador. Las traducciones, en en.js (npm run traducir, en servidor/) ---------- */
const LANG=window.LANG||'es', LOCALE=LANG==='en'?'en-GB':'es-ES';
function TR(s,...v){const k=typeof s==='string'?s:s.reduce((a,x,i)=>a+(i?\`{\${i-1}}\`:'')+x,'');const t=LANG==='en'&&window.EN?.[k]||k;return v.length?t.replace(/\\{(\\d+)\\}/g,(m,i)=>i<v.length?v[i]:m):t;}
if(LANG==='en'&&window.EN){   // lo que ya viene escrito en el HTML
  const tr=s=>{const k=s.trim();return k&&EN[k]?s.replace(k,()=>EN[k]):s;};
  const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);for(let n;(n=w.nextNode());)n.nodeValue=tr(n.nodeValue);
  for(const a of ['title','placeholder','aria-label','alt'])document.querySelectorAll('['+a+']').forEach(e=>e.setAttribute(a,tr(e.getAttribute(a))));
  document.title=tr(document.title);}
const btnIdioma=document.getElementById('btn-idioma');   // en el menú: cambia de idioma y se recuerda
if(btnIdioma){if(LANG==='en')btnIdioma.textContent='🇪🇸 Español';btnIdioma.onclick=()=>{const u=new URL(location.href);u.searchParams.set('lang',LANG==='en'?'es':'en');location.href=u;};}
`;
const CABEZA = v => `<script>/* Idioma del panel: ?lang=es|en se recuerda; si no, el del navegador */window.LANG=(()=>{try{var q=new URLSearchParams(location.search).get('lang');if(q==='es'||q==='en'){localStorage.setItem('idioma',q);return q;}return localStorage.getItem('idioma')||(/^es\\b/i.test(navigator.language)?'es':'en');}catch(e){return 'es';}})();document.documentElement.lang=LANG;if(LANG==='en')document.write('<script src="en.js?v=${v}"><\\/script>');</script>`;

// ¿Parece texto para leer? (no ids, clases, css ni rutas)
const sinHtml = s => s.replace(/<[^>]*>/g, ' ').replace(/&\w+;/g, ' ').replace(/\{\d+\}/g, ' ');
const visible = s => {
  const t = sinHtml(s);
  if (/^[\s\W\d]*$/.test(t) || /^(https?:|\/api|#[0-9a-f]{3,8}$|[.#[][\w-])/i.test(s.trim()) || /^[\w-]+(:[^ ]+;?)+$/.test(s.trim())) return false;
  return /[áéíóúñ¿¡ÁÉÍÓÚÑ]/.test(t) || /(^|[\s}])(de|en|el|la|los|las|y|con|por|para|hoy|HOY)(\s|$)/.test(t) || /[a-z]{2,} +[a-z]{2,}/i.test(t) || /^[^\p{L}]*[A-ZÁÉÍÓÚ][a-záéíóúñ]+/u.test(t);
};
const clave = n => n.type === 'Literal' ? n.value : n.quasis.map((q, i) => q.value.cooked + (i < n.expressions.length ? `{${i}}` : '')).join('');
// Singular y plural sueltos (n===1?'cosa':'cosas'): solo se traducen en pareja, porque palabras como «pendiente» también son estados
const PAREJAS = new Set(['partida|partidas', 'hoyo|hoyos', 'golpe|golpes', 'cosa|cosas', 'pendiente|pendientes', 'necesita|necesitan']);

function script(html) {
  const ini = html.indexOf('<script>\n') + 9, fin = html.indexOf('</script>', ini);
  return { ini, fin, src: html.slice(ini, fin) };
}

function textos(src) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  const res = [];
  walk.fullAncestor(ast, (n, _st, anc) => {
    if (!((n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral')) return;
    const p = anc[anc.length - 2];
    const plantilla = p.type === 'TaggedTemplateExpression' && p.tag.name === 'TR';
    if ((p.type === 'Property' && p.key === n) || (p.type === 'TaggedTemplateExpression' && !plantilla)) return;
    const hecho = plantilla || (p.type === 'CallExpression' && p.callee.name === 'TR');
    let pareja = false;
    if (p.type === 'ConditionalExpression' && n !== p.test) {
      const [a, b] = [p.consequent, p.alternate].map(x => x.type === 'Literal' ? x.value : null);
      pareja = PAREJAS.has(`${a}|${b}`) || PAREJAS.has(`${b}|${a}`);
    }
    const sector = p.type === 'Property' && ['s', 'sector', 'nombre'].includes(p.key.name);   // sectores de la demo y nombres (canal «trabajo»)
    res.push({ n, k: clave(n), hecho, plantilla, pareja, sector, locale: n.type === 'Literal' && n.value === 'es-ES' && anc[anc.length - 3]?.id?.name !== 'LOCALE' });
  });
  return res;
}

function aplicar() {
  let html = fs.readFileSync(F_HTML, 'utf8');
  const en = fs.readFileSync(F_EN, 'utf8'), EN = leerEN();
  const v = crypto.createHash('sha1').update(en).digest('hex').slice(0, 8);
  // cabecera con la versión de en.js (para que el navegador no use una vieja)
  html = /<script>\/\* Idioma del panel[^\n]*?<\/script>/.test(html) ? html.replace(/<script>\/\* Idioma del panel[^\n]*?<\/script>/, CABEZA(v)) : html.replace('<title>', CABEZA(v) + '\n<title>');
  let { ini, src } = script(html);
  if (!src.includes('function TR(s,...v)')) { src = RUNTIME + src; }
  const ins = [];
  for (const t of textos(src)) {
    if (t.hecho) continue;
    if (t.locale) { ins.push([t.n.start, t.n.end, 'LOCALE']); continue; }
    if (!EN[t.k] || EN[t.k] === t.k) continue;
    if (/^[a-záéíóúñ]+$/.test(t.k) && !t.pareja && !t.sector && !/[áéíóúñ]/.test(t.k)) continue;   // palabra suelta: puede ser un id
    const antes = /[\w$]/.test(src[t.n.start - 1]) ? ' ' : '';
    if (t.n.type === 'TemplateLiteral') ins.push([t.n.start, t.n.start, antes + 'TR']);
    else ins.push([t.n.start, t.n.end, `${antes}TR(${src.slice(t.n.start, t.n.end)})`]);
  }
  ins.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [a, b, s] of ins) src = src.slice(0, a) + s + src.slice(b);
  acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });   // que siga siendo JavaScript válido
  ({ ini } = script(html));
  html = html.slice(0, ini) + src + html.slice(script(html).fin);
  fs.writeFileSync(F_HTML, html);
  console.log(`${ins.length} textos envueltos. ${faltan(html, EN).length} sin traducir (npm run traducir -- faltan).`);
}

// Lo marcado con TR`…` o TR('…') va todo, parezca texto o no: quien lo marca quiere que se traduzca
export function marcadosSinIngles(html = fs.readFileSync(F_HTML, 'utf8'), EN = leerEN()) {
  return [...new Set(textos(script(html).src).filter(t => t.hecho && !EN[t.k]).map(t => t.k))];
}

export function faltan(html = fs.readFileSync(F_HTML, 'utf8'), EN = leerEN()) {
  const fuera = new Set(marcadosSinIngles(html, EN));
  for (const t of textos(script(html).src)) if (!t.locale && visible(t.k) && !EN[t.k]) fuera.add(t.k);
  // el HTML fijo: textos y atributos que se leen
  const doc = parseDocument(html.slice(html.indexOf('<body'), html.indexOf('<script>\n')));
  for (const n of DomUtils.findAll(() => true, doc.children)) {
    for (const a of ['title', 'placeholder', 'aria-label', 'alt']) if (n.attribs?.[a] && visible(n.attribs[a]) && !EN[n.attribs[a].trim()]) fuera.add(n.attribs[a].trim());
    for (const c of n.children) if (c.type === 'text' && visible(c.data) && !EN[c.data.trim()]) fuera.add(c.data.trim());
  }
  return [...fuera];
}

if (path.basename(process.argv[1] || '') === 'traducir-panel.mjs') {   // la prueba lo importa: importarlo no aplica nada
  if (process.argv[2] === 'faltan') for (const k of faltan()) console.log(JSON.stringify(k));
  else aplicar();
}
