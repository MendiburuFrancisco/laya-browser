# Comparación de Jev y Laya

Fecha UTC: 2026-10-10T21:41:46.010Z

## Metodología

- Cinco ejemplos locales idénticos, 3 repeticiones por backend; orden: laya.
- Ejecución secuencial, contexto nuevo por ejemplo y caché desactivada.
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
| laya | 15/15 | 15/15 | 45 | 958.64 | 898.21 | 1379.97 | 54.42 | No informado | No informado | 36753.75 |

## Resultados por ejemplo

| Backend | Ejemplo | Objetivos DOM | Éxitos confirmados | Tiempo medio (s) | Consultas por ejecución | Decisión media (ms) | Tokens entrada totales |
|---|---|---:|---:|---:|---:|---:|---:|
| laya | fill-field | 3/3 | 3/3 | 2.5 | 2 | 965.14 | No informado |
| laya | checkbox | 3/3 | 3/3 | 1.93 | 2 | 735.32 | No informado |
| laya | select-option | 3/3 | 3/3 | 2.29 | 2 | 923.91 | No informado |
| laya | search | 3/3 | 3/3 | 6.6 | 5 | 1045.63 | No informado |
| laya | add-todo | 3/3 | 3/3 | 4.81 | 4 | 975.69 | No informado |

## Calentamiento, disponibilidad y fallos

### laya

- Modelo: `cklxx/laya-browser`; endpoint: `http://127.0.0.1:8791/v1/systemone`.
- Navegador: headless; allow_irreversible: **true**.
- Tiempo completo del proceso: 55.86 s (incluye calentamiento y creación/cierre de contextos).
- Calentamiento: 1 consultas, 98.77 ms; tokens de entrada: No informado.
- Consumo del proceso completo (incluye calentamiento): entrada No informado, salida No informado tokens.
- Falsos done: 0.
- Laya ejecutado en **cuda:0**; modelo auxiliar: `convaiinnovations/laya`.
- Inferencia informada por el servidor: media 956.96 ms, mediana 896.8 ms, P95 1378.6 ms.

## Interpretación

Con las mismas comprobaciones existentes, activar `allowIrreversible` mejoró el
resultado de 9/15 a 15/15. El tiempo aumentó de 40,11 s a 54,42 s y las consultas
de 33 a 45 porque se ejecutaron tareas que antes se detenían solicitando confirmación.

El 15/15 no demuestra cumplimiento de todas las restricciones: en `search`, el
primer paso pide escribir sin enviar, pero la traza registra Enter sobre el botón
Search antes del segundo paso. La assertion de ese primer paso solo verifica el
texto del campo y no detecta el envío anticipado. Todos los estados del DOM que
se comprobaron pasaron; la conducta intermedia requiere una verificación más estricta.

Comparar latencias junto con la tasa de éxito y el número de decisiones: finalizar antes por error o detenerse prematuramente no equivale a completar una tarea más rápido.
Estos ejemplos sintéticos no representan un benchmark de sitios reales. Laya usa recursos locales; Jev incluye latencia de red. No se mide la descarga ni la carga inicial de los checkpoints.

Los archivos JSON adjuntos contienen las muestras por petición y los resultados de cada paso. No contienen claves API ni cabeceras de autenticación.
