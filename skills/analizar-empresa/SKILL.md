---
name: analizar-empresa
description: Investiga una empresa, la puntúa de 0 a 100 (encaje, necesidad, capacidad de pago, acceso) y, si es A o B, prepara su dossier comercial. Úsala cuando Dirección pida valorar, puntuar o preparar una empresa o una lista.
---

# Analizar empresa (Mateo y Carmen · calificación e investigación de cuentas)

## Objetivo
Decidir si merece la pena contactar a una empresa y, si sí, dar a Dirección todo lo necesario para hacerlo bien en 2 minutos de lectura.

## Antes de nada
Lo que vendemos, a quién y en qué zona está en la ficha «La empresa y su dueño». Puntúa siempre frente a esa ficha. Si le falta algo que necesitas para puntuar, dilo y no lo supongas.

## Entrada
Nombre y/o web de una empresa, o varias empresas de la base con `estado=nueva`.

## Investigación
No hay una fuente obligatoria: hay seis preguntas. Cada una se contesta con lo más barato que sirva, y se para en cuanto hay bastante para decidir.

| Pregunta | Dónde mirar, de lo más barato a lo más caro |
|---|---|
| **¿Quiénes son? ¿Siguen abiertos?** | Su web; `consultar_borme`; Empresite; `buscar_maps` si lo tienes |
| **¿Qué tamaño tienen?** | Su web (equipo, locales); ofertas de empleo; Empresite o Infoempresa; cuentas, si aparecen |
| **¿Quién decide la compra de lo que vendemos?** | Su web (quiénes somos, aviso legal, prensa); `consultar_borme` (administradores); prensa local; LinkedIn si está |
| **¿Les hace falta lo que vendemos?** | Reseñas (según el sector, abajo); ofertas de empleo que delaten esa necesidad; su web y sus redes |
| **¿Qué usan ya?** | Muchos programas no se ven al leer la web: `programas_detectados` solo ve algunos. Abre su página de reservas, citas o contacto y haz una búsqueda con su nombre y «reservas», «cita» o «chat». Si es un grupo con varios locales, mira la web de al menos dos y busca el nombre de cada uno con lo que use su sector («thefork», «covermanager», «doctoralia»). Si no lo has podido comprobar, escribe «sin comprobar», no «no tienen» |
| **¿Cómo llegar?** | LinkedIn si está; teléfono de la empresa; dirección para ir o escribir; un contacto en común; su asociación |

**Según el sector:**
- Hostelería: TripAdvisor, TheFork, Google, Instagram.
- Alquiler vacacional e inmobiliarias: Booking, Airbnb, Idealista, Fotocasa.
- Clínicas: Doctoralia, Top Doctors.
- Talleres, comercio y academias: Google, Facebook, Instagram.
- Constructoras e instaladoras: ofertas de empleo, licitaciones, Empresite.

**Por tandas.** Primero una pasada barata: su web y una búsqueda. A fondo solo si promete (A o B, o una C al límite) o si hay dudas: dos fuentes que se contradicen, una empresa que no sabes si existe, un decisor sin confirmar. Si dos fuentes se contradicen, manda la más oficial (BORME, luego su web, luego un directorio), y se apunta. Hay sitios que no se abren con `leer_web` (Google Maps, TripAdvisor, TheFork, Idealista, Indeed, InfoJobs): busca «<empresa> opiniones <sitio>» con `buscar_web` y usa el extracto.

**Señales que también valen:** apertura, contratación, reforma, inversión, ayudas, cambios en el BORME (ampliación de capital, nuevo administrador).

## Puntuación (0–100)

**Encaje (0–25)**
- Tamaño: dentro del cliente ideal → 10 · cerca → 5 · resto o desconocido → 2
- Sector: prioritario → 10 · relacionado → 5 · fuera → 0
- Zona: dentro de la zona de la ficha → 5 · cerca → 3

**Necesidad (0–25)**: suma lo que veas, siempre frente a lo que vendemos
- El problema que resolvemos es evidente en su web o en su forma de trabajar → 8
- Ofertas de empleo que delatan esa necesidad → 5
- Reseñas que apuntan a ese problema → 5
- Usa una alternativa peor o ninguna → 4
- Crece y esa necesidad va a más → 3

**Capacidad de pago (0–25)**
- Facturación frente al precio de lo que vendemos: holgada → 10 · justa → 6 · escasa → 3 · sin dato → 4
- Tendencia: creciente → 7 · estable → 4 · decreciente → 0 · sin dato → 3
- Resultado positivo → 5 (sin dato → 2)
- Inversión reciente visible → 3

**Acceso (0–25)**
- Decisor identificado con nombre → 8
- Contacto en común o vínculo con la red de Dirección → 7
- Hay una vía clara para llegar a quien decide (LinkedIn, teléfono de la empresa, o dirección donde ir o escribir) → 5
- Reunión o visita viable → 5

**Categoría:** A ≥ 75 · B 55–74 · C 35–54 · D < 35

Cada punto debe tener una **evidencia** (qué se vio y dónde). Sin evidencia, no hay punto. Si faltan muchos datos, indica `confianza: baja`.

## Dossier (solo A y B)

```
# <Empresa> — <categoría> (<puntuación>/100) · confianza <alta|media|baja>

## En una frase
Qué hacen y por qué son buen candidato.

**Ya usan:** una línea con lo que tienen para reservas, citas, chat, clientes o tienda, o «nada detectado». Lo que ya tienen resuelto no es un dolor: nadie les va a vender lo que ya usan.

## Decisor
Nombre, cargo y de dónde sale (su web, BORME…).

**Cómo llegar:** las vías que haya, de mejor a peor: contacto en común, LinkedIn, teléfono de la empresa, correo. Sin LinkedIn también hay dossier: lo que hace falta es al menos una vía. Si no hay ninguna, se dice.

**LinkedIn (mirarlo una vez, si está):**
- **Perfil del decisor**: busca «<nombre> <empresa> LinkedIn». Solo es **verificado** si el resultado coincide en nombre completo **y** empresa o cargo. Entonces va a `linkedin_url`.
- Si hay homónimos o no coincide la empresa, **no** lo pongas en `linkedin_url`: escribe en el dossier «Posibles perfiles (sin verificar)» con cada URL y por qué podría ser o no.
- **Página de empresa** (`linkedin.com/company/...`) en `linkedin_empresa`, si existe.
- En el dossier, una línea al principio: `LinkedIn: <perfil verificado, «sin verificar» o «no tiene»> · Empresa: <página o «no tiene»>`.

## Dónde les duele
3 problemas concretos, cada uno con su evidencia.

## Qué les ofreceríamos
| Lo que vendemos | Problema que resuelve | Beneficio estimado | Precio orientativo si está en la ficha |
Máximo 3. Estimaciones prudentes y explicadas.

## Gancho para el primer contacto
Una observación específica y verificable que demuestre que se ha mirado su negocio.

## Oferta de entrada
Lo más pequeño que se les puede vender o regalar primero, según la ficha.

## Riesgos / dudas
Lo que no sabemos y conviene preguntar.
```

## Al terminar
- Actualiza en la base: puntuación, cada eje, categoría, decisor, cargo y `estado` (`puntuada` o `dossier`).
- Responde con una tabla corta: empresa, puntuación, categoría, motivo principal.

## Reglas
- No inventes cifras, nombres ni reseñas. «Sin dato» es una respuesta válida.
