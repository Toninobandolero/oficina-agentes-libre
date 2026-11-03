// Módulos de la edición Pro: existen si están sus archivos. La edición Libre no los lleva y esos puntos se apagan solos.
//   voz        → Lola, la recepcionista de voz (ElevenLabs)
//   centralita → llamar desde la oficina (Zadarma) y el análisis de cada llamada
import fs from 'node:fs';

const hay = (...archivos) => archivos.every(a => fs.existsSync(new URL(`./${a}`, import.meta.url)));

export const PRO = { voz: hay('voz.js', 'elevenlabs.js'), centralita: hay('zadarma.js', 'trasLlamada.js') };
