# Ejemplos de comparación: Jev y Laya

Cinco tareas sobre una página local reproducible:

| Ejemplo | Pasos | Comprobación del DOM |
|---|---:|---|
| `fill-field.json` | 1 | El campo de correo contiene el valor solicitado. |
| `checkbox.json` | 1 | La casilla de suscripción está marcada. |
| `select-option.json` | 1 | El país seleccionado es Chile. |
| `search.json` | 2 | Se escribe la consulta y el botón muestra sus resultados. |
| `add-todo.json` | 2 | Se escribe una tarea y el botón la añade exactamente una vez. |

## Ejecutar la comparación

1. Instala las dependencias del proyecto y Chromium (`npm install` y `npm run setup`).
2. Configura `TYPESAFE_API_KEY` en el `.env` local para usar Jev.
3. Inicia Laya: `.venv/bin/python local/laya_server.py --device cpu`.
4. Desde la raíz del repositorio:

```bash
npm run bench:compare -- --repetitions 3
```

El ejecutor sirve `page.html` en un puerto local disponible, adapta las URLs de
los flujos y ejecuta primero Jev y después Laya. Usa contextos nuevos, ejecución
secuencial y caché desactivada. Se conserva cualquier fallo, incluido un `done`
incorrecto según el DOM. El presupuesto es de cuatro acciones por paso.

Las URLs de los JSON usan el puerto 8793 como referencia; el ejecutor las reemplaza
por el puerto real, por lo que no hace falta iniciar un servidor de ejemplos aparte.

Los resultados se guardan en `bench/results/backend-comparison.md` y los JSON
correspondientes. Para cambiar la ubicación:

```bash
npm run bench:compare -- --repetitions 3 --out bench/results/mi-comparacion
```

El reporte incluye media, mediana y P95 de las peticiones de decisión, tiempo de
ejecución, cantidad de consultas, tokens informados y éxito verificado por tarea.
Se informa por separado si el objetivo se logró en el DOM aunque el modelo haya
terminado con un estado incierto.
Una consulta de calentamiento por backend se registra por separado. Los tokens de
Laya figuran como **no informados** porque el adaptador no mide su tokenizer.
El tamaño del JSON dividido por cuatro es una estimación separada, no facturación.

Puedes cambiar los endpoints con `--jev-url` y `--laya-url`. El ejecutor establece
explícitamente backend, endpoint y modelo en cada proceso para evitar que los
valores del `.env` local mezclen Jev con Laya.

Para recorrer y **ver en pantalla los cinco ejemplos con Laya**, inicia primero el
servidor Laya y ejecuta:

```bash
npm run examples:laya
```

El navegador abre una ventana visible por ejemplo, ejecuta cada tarea una vez y
mantiene cada resultado 3 segundos en pantalla antes de cerrar esa ventana. Puedes
cambiar la pausa con `--pause-ms 5000`. El estado y la verificación del DOM aparecen
en la consola. No
necesita `TYPESAFE_API_KEY`. Equivale a:

```bash
node bench/compare-backends.mjs --backend laya --headed --repetitions 1 --pause-ms 3000
```

Para regenerar únicamente el Markdown a partir de los datos medidos, sin gastar
nuevas consultas:

```bash
node bench/compare-backends.mjs --from bench/results/backend-comparison.json --report BENCHMARK-JEV-LAYA.md
```
