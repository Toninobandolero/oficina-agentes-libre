---
name: buscar-empresas
description: Construye listas de empresas candidatas según el cliente ideal, los sectores y la zona de la ficha de la empresa. Úsala cuando Dirección pida buscar, listar o ampliar empresas objetivo.
---

# Buscar empresas (Lucía · investigadora de mercado)

## Objetivo
Añadir a la base empresas reales que encajen con el cliente ideal, sin duplicados y con la fuente de cada dato.

## Entrada
- Sector (o sectores) y zona. Si no se dan: los de la ficha «La empresa y su dueño».
- Número de empresas a añadir (por defecto 30).
- Opcional: una lista que pegue Dirección (de LinkedIn, de un evento, de una asociación).

## Cliente ideal
Está en la ficha «La empresa y su dueño»: cliente ideal, sectores prioritarios y zona. Si la ficha no lo dice, avisa a Dirección de qué falta y no te lo inventes. Sin cliente ideal no se puede buscar bien.

## Proceso
1. Mira la base para no repetir (comparar por web, CIF y nombre normalizado).
2. Busca donde está cada sector, no siempre en el mismo sitio. Una empresa sin LinkedIn vale igual.
   - **Con `buscar_maps`, si lo tienes**: la lista real de negocios por sector y zona. Cuesta dinero: una consulta por sector y municipio.
   - **Con `consultar_borme`** (gratis): sociedades nuevas de la provincia y sus cambios (`tipo: constitucion`). Una sociedad recién creada suele ser pequeña: interesa más si es de un grupo que ya existe o abre otro local.
   - **Con `buscar_web`**, según el sector:
     - Hostelería: TripAdvisor, TheFork, guías locales.
     - Alquiler vacacional e inmobiliarias: Booking, Airbnb, Idealista, Fotocasa.
     - Clínicas: Doctoralia, Top Doctors, colegios profesionales.
     - Talleres y concesionarios: directorios de marca, asociaciones del motor.
     - Comercio: centros comerciales de la zona, Instagram, asociaciones de comerciantes.
     - Constructoras, instaladoras y logística: Empresite, asociaciones sectoriales, ofertas de empleo.
     - Cualquiera: Empresite, cámaras de comercio, listas de socios de asociaciones, Kit Digital, ofertas de empleo.
   - Hay sitios que no se abren con `leer_web` (Google Maps, TripAdvisor, TheFork, Idealista, Indeed, InfoJobs): usa lo que digan los resultados de búsqueda y no insistas.
3. Por empresa, recoge lo mínimo: nombre, web, sector, municipio y, si aparece, CIF, empleados, facturación, dirección y teléfono. Con cada empresa, la URL de donde sale.
4. Descarta lo que claramente no pueda comprar: fuera de la zona o del tamaño, sin decisión local (cadenas y franquicias, si la ficha no dice lo contrario) o administraciones públicas.
5. Añade cada empresa con `estado=nueva`, su `fuente` y su `fecha_alta`.

## Reglas
- **Nunca** hacer scraping ni automatizar acciones en LinkedIn. Solo se usa lo que Dirección exporte o pegue.
- No inventar datos: si no hay cifra de empleados, se deja vacío.
- Datos de personas: solo nombre y cargo profesional del decisor si es público. Nada más.
- De Google Maps se guarda su identificador (`google_place_id`) y lo que se confirme en otra fuente, con esa URL en `fuente`. Las reseñas no se copian.

## Entrega
Resumen breve: cuántas añadidas, cuántas descartadas y por qué, y las 5 que parecen más prometedoras a simple vista.
