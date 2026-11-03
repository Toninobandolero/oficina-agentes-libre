// Proceso aparte: de la carpeta que le pasan (trabajo.json) saca video.mp4. Lo lanza video.js, que le pone el límite de tiempo.
// Un PNG de fondo fijo y uno transparente por escena (Resvg); cada escena entra subiendo 36 px en 0,4 s y sale en 0,3 s (ffmpeg); y se unen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Resvg } from '@resvg/resvg-js';

const ejecutar = promisify(execFile);
const dir = process.argv[2];
const { font, W, fondo, escenas } = JSON.parse(fs.readFileSync(path.join(dir, 'trabajo.json'), 'utf8'));
const png = (svg, archivo) => fs.writeFileSync(path.join(dir, archivo), new Resvg(svg, { font, fitTo: { mode: 'width', value: W } }).render().asPng());
const ffmpeg = args => ejecutar('ffmpeg', ['-y', '-loglevel', 'error', ...args], { cwd: dir });

os.setPriority(10);   // el servidor va primero; ffmpeg hereda la prioridad
try {
  png(fondo, 'fondo.png');
  const clips = [];
  for (const [i, e] of escenas.entries()) {
    png(e.svg, `texto${i}.png`);
    // La primera escena ya está en el primer fotograma: es la portada del vídeo, en el panel y en las redes
    const d = e.segundos, entra = i ? Math.min(0.4, d / 3) : 0, sale = Math.min(0.3, d / 4);
    // Cada PNG se lee una vez y se repite con «loop» (gasta 300 MB en vez de 1 GB). Se monta en RGB y se marca BT.709: los colores de la marca salen iguales en cualquier reproductor
    await ffmpeg(['-i', 'fondo.png', '-i', `texto${i}.png`,
      '-filter_complex', `[0:v]loop=loop=-1:size=1,fps=30[b];[1:v]loop=loop=-1:size=1,fps=30,format=rgba,${entra ? `fade=t=in:st=0:d=${entra}:alpha=1,` : ''}fade=t=out:st=${(d - sale).toFixed(2)}:d=${sale}:alpha=1[t];[b][t]overlay=0:'${entra ? `36*(1-min(t/${entra}\\,1))` : 0}':format=rgb,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v]`,
      '-map', '[v]', '-t', String(d), '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-threads', '2', '-rc-lookahead', '10', `escena${i}.mp4`]);
    clips.push(`file 'escena${i}.mp4'`);
  }
  fs.writeFileSync(path.join(dir, 'lista.txt'), clips.join('\n'));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'lista.txt', '-c', 'copy', '-movflags', '+faststart', 'video.mp4']);
} catch (e) {
  console.error(e.code === 'ENOENT' ? 'Falta ffmpeg en el servidor.' : String(e.stderr || e.message).trim());
  process.exit(1);
}
