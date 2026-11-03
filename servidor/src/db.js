import fs from 'node:fs';
import pg from 'pg';
import { config } from './config.js';

// Fechas como texto AAAA-MM-DD y numéricos como número
pg.types.setTypeParser(1082, v => v);
pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
pool.on('error', e => console.error('Conexión con Postgres perdida (se reintentará):', e.message));
export const q = (texto, params) => pool.query(texto, params);

export async function migrar() {
  const sql = fs.readFileSync(new URL('./esquema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export async function ajuste(clave, porDefecto = null) {
  const r = await q('SELECT valor FROM ajustes WHERE clave=$1', [clave]);
  return r.rows.length ? r.rows[0].valor : porDefecto;
}
export async function fijarAjuste(clave, valor) {
  await q(`INSERT INTO ajustes(clave, valor) VALUES ($1, $2)
           ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [clave, JSON.stringify(valor)]);
}
