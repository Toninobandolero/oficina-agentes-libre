// Cómo le está escribiendo Dirección al equipo. Si escribe con prisa, enfadado o repitiendo algo que ya pidió,
// los agentes lo notan y contestan en consonancia: más cortos, al grano, sin bromas y diciendo qué hacen ya.
// El estado dura un rato (no se le olvida al equipo al siguiente mensaje) y se va calmando solo.
import { ajuste, fijarAjuste } from './db.js';
import { emitir } from './bus.js';

const PALABROTAS = /\b(joder|jod[ie]\w*|co[ñn]o|hostias?|mierda|put[ao]s?|cojones|carajo|me cago|gilipoll\w*|cagad[ao]s?|tomar por culo|por culo|ostias?)\b/gi;
const FRUSTRACION = /(otra vez|vuelvo a repetir|te lo (he )?(dicho|repetido)|ya te (lo )?(he )?dicho|cu[aá]ntas veces|sigue(s|n)? sin|sigo (viendo|sin)|no funciona|no sirve|no me (hac[eé]is|haces) caso|est[aá] mal|ni de co[ñn]a|en serio\b|no puede ser|no tiene sentido|qu[eé] desastre|de nuevo|como te dije|no es lo que (te )?ped[ií])/gi;
const PRISA = /\b(urgente|ya mismo|ahora mismo|cuanto antes|r[aá]pido|inmediatamente|deprisa|para ayer|sin m[aá]s rollo)\b/gi;
const CALMA = /\b(gracias|genial|perfecto|estupendo|me encanta|buen trabajo|muy bien|jaja\w*|jeje\w*|guay|bravo)\b/gi;

/** Lee un mensaje de Dirección y devuelve 0 (tranquilo), 1 (tenso) o 2 (muy estresado), con las señales vistas. */
export function analizar(texto) {
  const t = String(texto || '');
  const senales = [];
  let p = 0;
  const pal = t.match(PALABROTAS) || [], fr = t.match(FRUSTRACION) || [], pr = t.match(PRISA) || [], ca = t.match(CALMA) || [];
  if (pal.length) { p += 2; senales.push('tacos'); }
  if (fr.length) { p += Math.min(3, fr.length); senales.push('repite lo que ya pidió o algo no funciona'); }
  if (pr.length) { p += 1; senales.push('prisa'); }
  if (/[!?]{2,}/.test(t)) { p += 1; senales.push('signos repetidos'); }
  if ((t.match(/\b[A-ZÁÉÍÓÚÑ]{4,}\b/g) || []).filter(w => !/^(CRM|LINKEDIN|API|SEO|URL|HTML|PDF|CSV|IVA|NIF|CIF|WHATSAPP|FACEBOOK)$/.test(w)).length >= 2) { p += 1; senales.push('mayúsculas'); }
  if (ca.length && p < 3) { p = Math.max(0, p - 2); }
  return { nivel: p >= 4 ? 2 : p >= 2 ? 1 : 0, senales, calma: ca.length > 0 };
}

/** Se apunta cada mensaje de Dirección. Un mensaje tenso sube el estado; uno tranquilo lo baja. */
export async function registrar(texto) {
  const a = analizar(texto);
  const previo = await actual();
  let nivel = a.nivel;
  if (nivel < previo.nivel && !a.calma) nivel = previo.nivel;      // un mensaje neutro no borra el enfado de hace un rato
  const minutos = nivel === 2 ? 120 : nivel === 1 ? 60 : 0;
  const estado = nivel ? { nivel, senales: a.senales.length ? a.senales : previo.senales, hasta: Date.now() + minutos * 60_000 } : null;
  await fijarAjuste('tono_dueno', estado);
  if ((estado?.nivel || 0) !== previo.nivel) {
    await emitir({ tipo: 'tono', nivel: estado?.nivel || 0 });
    (await import('./vida.js')).emitirAnimo().catch(() => {});
  }
  return estado || { nivel: 0, senales: [] };
}

export async function actual() {
  const e = await ajuste('tono_dueno', null);
  return e && e.hasta > Date.now() ? e : { nivel: 0, senales: [] };
}

/** Lo que se le dice al agente junto con el encargo, según cómo esté Dirección. */
export function aviso(e) {
  if (!e?.nivel) return '';
  return e.nivel === 2
    ? `[Cómo está Dirección ahora: muy estresado o molesto (${e.senales.join(', ')}). Contesta muy corto y al grano: si algo ha fallado, reconócelo en una frase sin excusas; di qué haces ya y cuándo estará. Nada de bromas, saludos ni personalidad. No le pidas nada que no sea imprescindible.]\n\n`
    : `[Cómo está Dirección ahora: con prisa o algo tenso (${e.senales.join(', ')}). Sé breve y concreto, sin bromas ni rodeos; ve a lo que pide.]\n\n`;
}
