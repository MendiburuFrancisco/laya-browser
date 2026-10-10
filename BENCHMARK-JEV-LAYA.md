# Comparación de Jev y Laya

Fecha UTC: 2026-10-10T21:05:10.865Z

## Resumen: Jev, Laya CPU y Laya GPU

Se ejecutaron los mismos cinco ejemplos con tres repeticiones por configuración:
**15 tareas por backend**, sin caché, en modo headless y con verificación del DOM.
La prueba de Jev y Laya CPU terminó a las 21:05 UTC; la de Laya GPU terminó a las
21:31 UTC del 10 de octubre de 2026. Las mediciones de GPU son una ejecución
posterior, no parte de la misma corrida de CPU.

| Métrica | Jev — API remota | Laya — CPU local | Laya — AMD GPU local |
|---|---:|---:|---:|
| Decisión media por consulta HTTP | 250,51 ms | 2.715,35 ms | 951,30 ms |
| Mediana | 236,53 ms | 2.657,69 ms | 901,28 ms |
| P95 | 321,81 ms | 3.458,79 ms | 1.183,91 ms |
| Tiempo acumulado de las 15 tareas | 21,38 s | 98,48 s | 40,11 s |
| Consultas medidas | 43 | 33 | 33 |
| Objetivos logrados en el DOM | 15/15 | 9/15 | 9/15 |
| Finalizaciones confirmadas por estado y DOM | 12/15 | 9/15 | 9/15 |
| Tokens de entrada informados — tareas medidas | 52.417 | No medidos | No medidos |
| Tokens de salida informados — tareas medidas | 10.311 | No medidos | No medidos |

La GPU redujo la latencia de Laya aproximadamente **2,85 veces** y el tiempo de
ejecución aproximadamente **2,46 veces** respecto de la CPU. Jev mantuvo una
latencia media aproximadamente **3,80 veces menor** que Laya GPU en estas pruebas.
Los fallos de confirmación de Laya en casillas y búsquedas persistieron en GPU.

La latencia incluye la petición HTTP completa; no es solo tiempo del kernel de
GPU. El tiempo de tareas incluye navegación, acciones, esperas y verificaciones,
pero excluye carga inicial de modelos, calentamiento y creación/cierre de contextos.
Los tokens internos de Laya no están instrumentados: **no medidos no significa cero**.

### Componentes y entorno de la computadora

| Componente | Configuración verificada |
|---|---|
| Sistema operativo | Ubuntu 22.04.5 LTS, Linux x86_64 |
| Kernel | 6.8.0-138-generic |
| CPU | Intel Core i5-11400F, 11.ª generación, frecuencia base de 2,60 GHz |
| Núcleos e hilos | 6 núcleos físicos, 12 hilos; frecuencia máxima anunciada de 4,40 GHz |
| RAM reportada al sistema | 23,31 GiB de memoria total; no es una medición del consumo del benchmark |
| GPU | AMD Radeon RX 6600, Navi 23 / RDNA 2, destino ROCm `gfx1032` |
| VRAM | 8 GB nominales; aproximadamente 7,98 GiB utilizables reportados |
| Driver gráfico | `amdgpu` |
| Python | 3.11.16 |
| Node.js | 24.15.0 |
| Laya | 0.4.2; modelos `cklxx/laya-browser` y `convaiinnovations/laya` |
| PyTorch de la prueba CPU | 2.14.1+cu130, ejecutado explícitamente en CPU |
| PyTorch de la prueba GPU | 2.16.0a0+rocm10.2.0a20261010, build nightly AMD TheRock |
| Dispositivos reales de ambos modelos en GPU | `cuda:0`, acelerador ROCm; aproximadamente 2.854,6 MiB asignados por PyTorch con ambos modelos cargados |

Este equipo ejecutó el navegador y el cliente de los tres benchmarks, y la
inferencia local de Laya. **La inferencia de Jev se ejecutó en TypeSafe; su CPU,
GPU y RAM remotas no están disponibles en este reporte.** Las compilaciones de
PyTorch de CPU y GPU son distintas, por lo que no se atribuye toda la diferencia
exclusivamente al hardware.

La instalación AMD y la verificación de los dispositivos reales están documentadas
en [ROCM-AMD.md](ROCM-AMD.md). El detalle de GPU está en
`bench/results/laya-rocm-gpu.md`, con sus muestras en los JSON correspondientes.

## Metodología

- Cinco ejemplos locales idénticos, 3 repeticiones por backend; orden: Jev, luego Laya.
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
| jev | 15/15 | 12/15 | 43 | 250.51 | 236.53 | 321.81 | 21.38 | 52417 | 10311 | 34735.75 |
| laya | 9/15 | 9/15 | 33 | 2715.35 | 2657.69 | 3458.79 | 98.48 | No informado | No informado | 26799 |

## Resultados por ejemplo

| Backend | Ejemplo | Objetivos DOM | Éxitos confirmados | Tiempo medio (s) | Consultas por ejecución | Decisión media (ms) | Tokens entrada totales |
|---|---|---:|---:|---:|---:|---:|---:|
| jev | fill-field | 3/3 | 3/3 | 1.05 | 2 | 227.51 | 7323 |
| jev | checkbox | 3/3 | 3/3 | 0.98 | 2 | 243.84 | 6657 |
| jev | select-option | 3/3 | 3/3 | 0.96 | 2 | 250.77 | 7407 |
| jev | search | 3/3 | 3/3 | 2.05 | 4 | 259.74 | 15093 |
| jev | add-todo | 3/3 | 0/3 | 2.08 | 4.33 | 255.57 | 15937 |
| laya | fill-field | 3/3 | 3/3 | 6.37 | 2 | 2892.87 | No informado |
| laya | checkbox | 0/3 | 0/3 | 2.1 | 1 | 1668.24 | No informado |
| laya | select-option | 3/3 | 3/3 | 5.84 | 2 | 2694.91 | No informado |
| laya | search | 0/3 | 0/3 | 6.75 | 2 | 3092.72 | No informado |
| laya | add-todo | 3/3 | 3/3 | 11.77 | 4 | 2709.92 | No informado |

## Calentamiento, disponibilidad y fallos

### jev

- Modelo: `jev-latest`; endpoint: `https://api.typesafe.ai/v1/systemone`.
- Tiempo completo del proceso: 22.84 s (incluye calentamiento y creación/cierre de contextos).
- Calentamiento: 1 consultas, 308.74 ms; tokens de entrada: 281.
- Consumo del proceso completo (incluye calentamiento): entrada 52698, salida 10331 tokens.
- Falsos done: 0.
- add-todo, repetición 1: stuck; DOM verificado: true.
- add-todo, repetición 2: ambiguous; DOM verificado: true; target confidence too low; refine the goal or act on a candidate directly.
- add-todo, repetición 3: ambiguous; DOM verificado: true; target confidence too low; refine the goal or act on a candidate directly.

### laya

- Modelo: `cklxx/laya-browser`; endpoint: `http://127.0.0.1:8791/v1/systemone`.
- Tiempo completo del proceso: 99.84 s (incluye calentamiento y creación/cierre de contextos).
- Calentamiento: 1 consultas, 195.53 ms; tokens de entrada: No informado.
- Consumo del proceso completo (incluye calentamiento): entrada No informado, salida No informado tokens.
- Falsos done: 0.
- Laya ejecutado en **cpu**; modelo auxiliar: `convaiinnovations/laya`.
- Inferencia informada por el servidor: media 2713.27 ms, mediana 2655 ms, P95 3456.9 ms.
- checkbox, repetición 1: needs_confirmation; DOM verificado: false; the next action looks hard to undo; call again with allow_irreversible to proceed.
- search, repetición 1: needs_confirmation; DOM verificado: true; the next action looks hard to undo; call again with allow_irreversible to proceed.
- checkbox, repetición 2: needs_confirmation; DOM verificado: false; the next action looks hard to undo; call again with allow_irreversible to proceed.
- search, repetición 2: needs_confirmation; DOM verificado: true; the next action looks hard to undo; call again with allow_irreversible to proceed.
- checkbox, repetición 3: needs_confirmation; DOM verificado: false; the next action looks hard to undo; call again with allow_irreversible to proceed.
- search, repetición 3: needs_confirmation; DOM verificado: true; the next action looks hard to undo; call again with allow_irreversible to proceed.

## Interpretación

En esta máquina y con este adaptador, **Jev fue 10,84 veces más rápido por consulta**
que Laya en CPU (250,51 ms frente a 2.715,35 ms). El tiempo acumulado de ejecución
de las tareas fue **4,61 veces menor** con Jev (21,38 s frente a 98,48 s).

El resultado de calidad no es idéntico:

- **Jev:** 15/15 objetivos logrados en el DOM, pero solo 12/15 finalizaciones
  confirmadas por el modelo. En las tres ejecuciones de `add-todo`, la tarea se
  añadió correctamente, pero el backend terminó con `stuck` o `ambiguous`.
- **Laya:** 9/15 objetivos logrados y confirmados. En `checkbox` consideró marcar
  una casilla como irreversible y se detuvo antes de actuar. En `search` escribió
  la consulta, pero pidió confirmación antes de continuar, por lo que nunca se
  ejecutó el segundo paso de búsqueda. Son seis ejecuciones incompletas, no seis
  falsos estados `done`.

Las reglas de confirmación se mantuvieron iguales para ambos backends. No se
desactivaron para mejorar artificialmente la tasa de éxito de Laya.

### Consumo de tokens de esta sesión

| Concepto | Entrada Jev | Salida Jev | Total |
|---|---:|---:|---:|
| Tareas medidas | 52.417 | 10.311 | 62.728 |
| Calentamiento de la ejecución completa | 281 | 20 | 301 |
| Consulta preliminar adicional | 281 | 20 | 301 |
| **Total informado en esta sesión** | **52.979** | **10.351** | **63.330** |

La consulta preliminar fue un calentamiento en un intento de ejecución interrumpido
por el lanzador. No produjo decisiones de tareas válidas y está excluida de las
tablas de rendimiento. Se incluye aquí para contabilizar su consumo real.

Laya ejecutó los modelos localmente y **no consumió tokens de la API de TypeSafe**.
Sus tokens internos procesados no están medidos: el adaptador devuelve un cero
fijo en `usage.input_tokens`. No se puede comparar el consumo de su tokenizer con
los tokens facturables de Jev a partir de ese valor. Tampoco se calcula un coste
monetario sin una tarifa de API y una medición del consumo del equipo.

Comparar latencias junto con la tasa de éxito y el número de decisiones: finalizar antes por error o detenerse prematuramente no equivale a completar una tarea más rápido.
Estos ejemplos sintéticos no representan un benchmark de sitios reales. Laya usa recursos locales; Jev incluye latencia de red. No se mide la descarga ni la carga inicial de los checkpoints.

Estas cifras describen **Laya en CPU con este adaptador y dos checkpoints**, no
su velocidad en GPU ni los resultados publicados del harness `jev-ultrafast`.

## Reproducir y consultar los datos

```bash
npm run bench:compare -- --repetitions 3 --out bench/results/backend-comparison-complete
```

- Ejemplos: [examples/comparison/README.md](examples/comparison/README.md).
- Ejecutor: [bench/compare-backends.mjs](bench/compare-backends.mjs).
- Datos completos: [backend-comparison-complete.json](bench/results/backend-comparison-complete.json).
- Jev: [backend-comparison-complete-jev.json](bench/results/backend-comparison-complete-jev.json).
- Laya: [backend-comparison-complete-laya.json](bench/results/backend-comparison-complete-laya.json).
- Intento preliminar interrumpido, excluido de las métricas: [backend-comparison-jev.json](bench/results/backend-comparison-jev.json).

Los JSON contienen las muestras por petición y los resultados de cada paso.
No contienen claves API ni cabeceras de autenticación. El reporte automático puede
regenerarse sin nuevas consultas con `--from` y `--report`; la interpretación y la
contabilidad de la consulta preliminar de esta sesión se añadieron a este informe.
