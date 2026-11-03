// El tiempo que hace donde está la empresa (Open-Meteo, sin clave). Lo pide el servidor y lo ven igual todas las pantallas.
// El sitio sale de «Mi empresa» (campo «localidad de la oficina»); si no está, el de config.empresa.localidad.
import { ajuste, fijarAjuste } from './db.js';
import { config } from './config.js';
import * as perfil from './perfil.js';

const POR_DEFECTO = config.empresa.localidad;
let cache = null;

async function lugar() {
  const nombre = String(perfil.leer?.()?.empresa?.localidad || '').trim();
  if (!nombre) return POR_DEFECTO;
  const g = await ajuste('clima_lugar', null);
  if (g?.buscado === nombre) return g;
  try {
    const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(nombre)}&count=1&language=es&countryCode=ES`, { signal: AbortSignal.timeout(8000) })).json();
    const x = r.results?.[0];
    if (!x) return POR_DEFECTO;
    const l = { buscado: nombre, nombre: x.name, lat: x.latitude, lon: x.longitude };
    await fijarAjuste('clima_lugar', l);
    return l;
  } catch { return POR_DEFECTO; }
}

const TIPO = c => c === 0 ? 'despejado' : c <= 3 ? 'nubes' : c <= 48 ? 'niebla' : c <= 67 || (c >= 80 && c <= 82) ? 'lluvia' : c <= 77 || c === 85 || c === 86 ? 'nieve' : c >= 95 ? 'tormenta' : 'nubes';

export async function actual() {
  if (cache && Date.now() - cache.t < 15 * 60_000) return cache.d;
  const l = await lugar();
  if (!l) return null;   // aún no se sabe dónde está la oficina
  try {
    const r = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${l.lat}&longitude=${l.lon}&current=weather_code,temperature_2m,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation&timezone=Europe%2FMadrid`, { signal: AbortSignal.timeout(8000) })).json();
    const c = r.current;
    const d = { lugar: l.nombre, tipo: TIPO(c.weather_code), codigo: c.weather_code, temp: Math.round(c.temperature_2m), nubes: c.cloud_cover, viento: Math.round(c.wind_speed_10m), rachas: Math.round(c.wind_gusts_10m), direccion: c.wind_direction_10m, lluvia: c.precipitation };
    cache = { t: Date.now(), d };
    return d;
  } catch { return cache?.d || null; }
}
