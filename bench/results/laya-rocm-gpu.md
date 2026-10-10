# Comparación de Jev y Laya

Fecha UTC: 2026-10-10T21:31:31.107Z

## Metodología

- Cinco ejemplos locales idénticos, 3 repeticiones por backend; orden: laya.
- Ejecución secuencial, contexto nuevo por ejemplo, navegador headless y caché desactivada.
- Una consulta de calentamiento por backend, excluida de las tablas de tareas; se informa su consumo por separado.
- Verificación determinista del DOM después de cada paso. Se distingue objetivo logrado en el DOM de éxito confirmado por DOM + estado done/likely_done.
- Latencia de decisión: petición HTTP completa medida por el cliente, incluyendo red, inferencia y lectura de respuesta. No es inferencia pura.
- Tiempo de ejecución: navegación + decisiones + acciones + esperas + verificaciones; excluye creación y cierre del contexto.
- Tokens: uso de entrada/salida informado por Jev. Laya devuelve un cero sintético; se registra como no informado, no como cero tokens procesados.
- Caracteres/4 es solo una aproximación del tamaño del JSON de petición, no una medición del tokenizer ni de facturación.
- Los intentos HTTP fallidos y reintentos se conservan en el JSON. Consumo desconocido se mantiene como no informado.

Equipo: 11th Gen Intel(R) Core(TM) i5-11400F @ 2.60GHz; 12 CPUs lógicas; 23.31 GiB RAM; v24.15.0.

## Resumen medido

| Backend | Objetivos DOM | Éxitos confirmados | Consultas HTTP | Decisión media (ms) | Mediana (ms) | P95 (ms) | Ejecución total (s) | Tokens entrada | Tokens salida | JSON petición ≈ tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| laya | 9/15 | 9/15 | 33 | 951.3 | 901.28 | 1183.91 | 40.11 | No informado | No informado | 26799 |

## Resultados por ejemplo

| Backend | Ejemplo | Objetivos DOM | Éxitos confirmados | Tiempo medio (s) | Consultas por ejecución | Decisión media (ms) | Tokens entrada totales |
|---|---|---:|---:|---:|---:|---:|---:|
| laya | fill-field | 3/3 | 3/3 | 2.53 | 2 | 977.68 | No informado |
| laya | checkbox | 0/3 | 0/3 | 1.08 | 1 | 653.43 | No informado |
| laya | select-option | 3/3 | 3/3 | 2.3 | 2 | 926.99 | No informado |
| laya | search | 0/3 | 0/3 | 2.64 | 2 | 1044.62 | No informado |
| laya | add-todo | 3/3 | 3/3 | 4.82 | 4 | 978.08 | No informado |

## Calentamiento, disponibilidad y fallos

### laya

- Modelo: `cklxx/laya-browser`; endpoint: `http://127.0.0.1:8791/v1/systemone`.
- Tiempo completo del proceso: 42.63 s (incluye calentamiento y creación/cierre de contextos).
- Calentamiento: 1 consultas, 1092.47 ms; tokens de entrada: No informado.
- Consumo del proceso completo (incluye calentamiento): entrada No informado, salida No informado tokens.
- Falsos done: 0.
- Laya ejecutado en **cuda:0**; modelo auxiliar: `convaiinnovations/laya`.
- Inferencia informada por el servidor: media 949.54 ms, mediana 899.8 ms, P95 1182.5 ms.
- checkbox, repetición 1: needs_confirmation; DOM verificado: false; the next action looks hard to undo; call again with allow_irreversible to proceed.
- search, repetición 1: needs_confirmation; DOM verificado: true; the next action looks hard to undo; call again with allow_irreversible to proceed.
- checkbox, repetición 2: needs_confirmation; DOM verificado: false; the next action looks hard to undo; call again with allow_irreversible to proceed.
- search, repetición 2: needs_confirmation; DOM verificado: true; the next action looks hard to undo; call again with allow_irreversible to proceed.
- checkbox, repetición 3: needs_confirmation; DOM verificado: false; the next action looks hard to undo; call again with allow_irreversible to proceed.
- search, repetición 3: needs_confirmation; DOM verificado: true; the next action looks hard to undo; call again with allow_irreversible to proceed.

## Interpretación

Comparar latencias junto con la tasa de éxito y el número de decisiones: finalizar antes por error o detenerse prematuramente no equivale a completar una tarea más rápido.
Estos ejemplos sintéticos no representan un benchmark de sitios reales. Laya usa recursos locales; Jev incluye latencia de red. No se mide la descarga ni la carga inicial de los checkpoints.

Los archivos JSON adjuntos contienen las muestras por petición y los resultados de cada paso. No contienen claves API ni cabeceras de autenticación.
