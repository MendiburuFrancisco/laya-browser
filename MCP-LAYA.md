# Ejecutar laya-browser por MCP con Laya local

Esta guía configura el servidor MCP del código fuente para que las decisiones
se ejecuten con Laya en tu equipo. No necesitas una clave de TypeSafe.

Hay dos procesos que deben estar activos:

1. **Servidor de inferencia Laya:** proceso Python en `http://127.0.0.1:8791`.
2. **Servidor MCP de laya-browser:** proceso Node.js que inicia tu cliente MCP.

El cliente MCP envía objetivos al servidor Node, que lee la página con Playwright,
consulta Laya localmente y ejecuta las acciones en el navegador.

## 1. Requisitos e instalación

- Node.js 20 o superior.
- Python 3.11 o superior y [uv](https://docs.astral.sh/uv/getting-started/installation/).
- Acceso a Internet para instalar dependencias y descargar inicialmente los modelos.

Desde la raíz del repositorio:

```bash
npm install
npm run setup
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r local/requirements.txt
```

Si ya instalaste las dependencias en este proyecto, puedes pasar al siguiente paso.

## 2. Iniciar Laya

En una terminal, desde la raíz del repositorio:

```bash
.venv/bin/python local/laya_server.py --device cpu
```

Para una GPU NVIDIA compatible con CUDA:

```bash
.venv/bin/python local/laya_server.py --device cuda
```

El primer inicio descarga dos checkpoints:

- `cklxx/laya-browser`: selecciona operaciones y elementos.
- `convaiinnovations/laya`: responde preguntas auxiliares, como valores, errores,
  inicio de sesión y acciones difíciles de deshacer.

En los siguientes inicios se reutilizan los archivos descargados. Espera a que
termine de cargar; no interrumpas el proceso durante la carga del tokenizador.
El servidor debe quedar escuchando, por lo que la terminal no devuelve el prompt.

Comprueba que esté listo desde otra terminal:

```bash
curl http://127.0.0.1:8791/health
```

Debe responder con `"ok": true`. Mantén esta terminal abierta mientras usas el MCP.
Para detener Laya, presiona `Ctrl+C` en la terminal donde lo iniciaste.

## 3. Configurar el cliente MCP

En el archivo de configuración MCP de tu cliente, agrega esta entrada. Sustituye
las rutas de ejemplo por **rutas absolutas** de tu equipo:

```json
{
  "mcpServers": {
    "laya-browser": {
      "command": "/ruta/absoluta/a/node",
      "args": ["/ruta/absoluta/a/laya-browser/bin/laya-browser-mcp.mjs"],
      "env": {
        "JEV_BACKEND": "laya",
        "JEV_API_URL": "http://127.0.0.1:8791/v1/systemone",
        "JEV_BROWSER_HEADED": "1",
        "JEV_BROWSER_VIEWPORT": "null",
        "JEV_CACHE": "0"
      }
    }
  }
}
```

Obtén la ruta de Node con:

```bash
command -v node
```

Por ejemplo, la ruta al servidor MCP en este checkout es:

```text
/ruta/absoluta/a/laya-browser/bin/laya-browser-mcp.mjs
```

Usa el servidor del checkout local para tener disponibles los cambios de Laya y
viewport de este proyecto. Reinicia o reconecta el cliente MCP después de guardar
la configuración. El cliente inicia el proceso Node automáticamente; Laya se
inicia por separado con el comando del paso 2.

### Alternativa: registrar en Claude Code

Desde la raíz del proyecto, reemplaza la ruta por la de tu checkout:

```bash
claude mcp add laya-browser \
  -e JEV_BACKEND=laya \
  -e JEV_API_URL=http://127.0.0.1:8791/v1/systemone \
  -e JEV_BROWSER_HEADED=1 \
  -e JEV_BROWSER_VIEWPORT=null \
  -e JEV_CACHE=0 \
  -- node /ruta/absoluta/a/laya-browser/bin/laya-browser-mcp.mjs
```

## 4. Configurar el navegador

| Variable del proceso MCP | Comportamiento |
| --- | --- |
| `JEV_BACKEND=laya` | Usa el backend local sin clave de TypeSafe. |
| `JEV_API_URL` | Endpoint completo del servidor Laya. |
| `JEV_BROWSER_HEADED=1` | Abre el navegador visible. |
| `JEV_BROWSER_VIEWPORT=null` | La página se ajusta al tamaño de la ventana. |
| `JEV_BROWSER_PROFILE=/ruta/absoluta/perfil` | Conserva sesiones de inicio de sesión entre ejecuciones. |
| `JEV_CACHE=0` | Desactiva la caché para que las decisiones se consulten al modelo. |
| `JEV_BROWSER_LOG=1` | Imprime decisiones por ronda en stderr del servidor MCP. |

Para una resolución fija, usa esta cadena JSON en el `env` del MCP:

```json
{
  "JEV_BROWSER_VIEWPORT": "{\"width\":1280,\"height\":800}"
}
```

También puedes elegir el viewport en la primera llamada a `browser_open`:

```json
{
  "url": "https://example.com",
  "viewport": { "width": 1280, "height": 800 }
}
```

O permitir el redimensionamiento de la ventana:

```json
{
  "url": "https://example.com",
  "viewport": null
}
```

El parámetro de la herramienta tiene prioridad sobre la variable de entorno.
Si no configuras ninguno, el tamaño predeterminado es 1280×800. Para cambiarlo
en una sesión existente, llama a `browser_close` antes de abrir la nueva sesión.

Para habilitar la caché con un archivo separado de Jev, elimina `JEV_CACHE=0`
y configura `JEV_CACHE_FILE` con una ruta absoluta, por ejemplo
`/ruta/absoluta/a/laya-browser/.laya-cache.json`.

## 5. Probar las herramientas MCP

### Agente de navegación local (opcional)

Si tienes un agente personal en `.opencode/agents/navegador.md`, inicia OpenCode
desde este repositorio y selecciona **navegador** con `Tab`, o inicia directamente.
Los archivos de configuración personal de `.opencode/` no se distribuyen con el fork:

```bash
opencode --agent navegador
```

Si OpenCode ya estaba abierto al crear el archivo, ciérralo y vuelve a iniciarlo
para que descubra el agente. El MCP y el servidor Laya deben estar configurados
según los pasos anteriores. Este agente usa las herramientas `laya-browser_*`,
verifica los resultados y puede tomar control directo cuando Laya se equivoca.
No tiene acceso a shell ni edición de archivos.

El agente solicita primero una ruta ordenada y sus datos. Envía todo a
`browser_run`: los pasos se ejecutan dentro del MCP, sin regresar al LLM después
de cada éxito. Solo vuelve al terminar o ante problemas. Si ya proporcionaste
un plan completo, no vuelve a pedirlo.

Ejemplo de argumentos:

```json
{
  "url": "https://demo.playwright.dev/todomvc/",
  "viewport": null,
  "steps": [
    {
      "goal": "Enter the supplied todo text into the 'What needs to be done?' field without submitting it",
      "values": { "todo": "primer paso" },
      "verify": { "field": { "label": "What needs to be done?", "value_key": "todo" } }
    },
    {
      "goal": "Enter the supplied todo text into the 'What needs to be done?' field without submitting it",
      "values": { "todo": "segundo paso" },
      "verify": { "field": { "label": "What needs to be done?", "value_key": "todo" } }
    }
  ]
}
```

La respuesta incluye `completed`, `total`, `decision_calls` y, si hay problemas,
`failed_step`, estado y contexto. El navegador permanece abierto. Para reanudar,
envía el paso pendiente y los posteriores, sin repetir el prefijo completado.
`likely_done` también detiene la secuencia. Puedes verificar condiciones con
`verify.url_includes`, `verify.text_includes` o `verify.field`; sin condiciones,
el éxito de cada paso depende de la decisión del modelo.

Para rutas largas, aumenta el `timeout` del MCP `laya-browser` en la configuración
de OpenCode (por ejemplo, `600000` milisegundos). El límite de 120 segundos puede
ser insuficiente para un plan completo. No envíes llamadas simultáneas a otras
herramientas de navegador mientras se ejecuta el plan.

Prueba dos pasos en una única llamada MCP con Laya real:

```bash
node --env-file=.env local/laya-mcp-smoke.mjs --plan
```

Pídele a tu asistente conectado al MCP que realice estos pasos:

1. Abra `https://demo.playwright.dev/todomvc/` con `browser_open`.
2. Use `browser_do` para introducir texto sin enviarlo.
3. Tome un `browser_snapshot` para comprobar el contenido del campo.

Argumentos para el segundo paso:

```json
{
  "goal": "Enter the supplied todo text into the 'What needs to be done?' field without submitting it",
  "values": { "todo": "buy milk" },
  "explain": true
}
```

También puedes comprobar la inferencia y el navegador sin el cliente MCP:

```bash
JEV_BACKEND=laya JEV_CACHE=0 \
node bin/laya-browser.mjs run examples/flows/laya-smoke.json --headed
```

Este ejemplo incluye una comprobación del DOM para verificar que el texto realmente
se haya escrito. Laya puede detenerse demasiado pronto o clasificar incorrectamente
algunas páginas; usa objetivos cortos y verifica el resultado con snapshots o
comprobaciones de la página. El flujo completo de TodoMVC no es actualmente un
benchmark que este backend supere.

Las operaciones propuestas por el modelo de navegador son click, escritura,
select, Enter, scroll, espera y estados de finalización/bloqueo. Otras acciones,
como hover, arrastrar o subir archivos, siguen disponibles mediante `browser_act`.

### Code Mode: condiciones y bucles en una llamada

`browser_execute` permite que el LLM cliente escriba un programa JavaScript y
ejecute varios pasos sin volver al LLM entre operaciones. Funciona con
`JEV_BACKEND=laya` y `JEV_BACKEND=jev`: ambos siguen tomando decisiones de
navegación, sin generar código. Reinicia el proceso MCP para descubrir la nueva
herramienta después de actualizar.

Ejemplo de argumentos sobre una página con un campo `Name`:

```json
{
  "values": { "names": ["Ada", "Grace"] },
  "code": "const completed = []; for (const name of values.names) { await browser.do({goal: 'Enter the supplied name into Name', values: {name}, verify: {field: {label: 'Name', value_key: 'name'}}}); completed.push(name); } return completed;",
  "timeout_ms": 120000
}
```

El código es el cuerpo de una función `async`: puede usar `await`, condiciones,
bucles y `return` con datos JSON. La interfaz tipada está en el recurso MCP
`browser://code-mode/api`; los programas usan JavaScript, no sintaxis TypeScript.
Métodos: `browser.open`, `do`, `run`, `check`, `choose`, `read`, `snapshot`,
`downloads` y `waitForDownload`. Todos reciben objetos. `read` devuelve `content`,
`check` devuelve `p_yes` y `snapshot` devuelve `text`.

Se ejecuta en QuickJS/WASM dentro de un worker aislado, sin acceso directo a Node,
archivos, claves del backend, red general ni objetos Playwright. Las operaciones
validadas pasan al navegador del servidor. Espera cada llamada con `await`; la
sesión se usa en serie incluso con `Promise.all`.

Límites predeterminados: 60 segundos, 30 llamadas a la interfaz, 100 llamadas de
decisión, 100 acciones de navegador, 32 MiB de memoria y 20.000 caracteres de
salida JSON. Puedes ajustar `timeout_ms`, `max_operations`, `max_decision_calls`,
`max_browser_actions` y `max_output_chars` dentro de los límites publicados en
`README.md`.

Un estado como `likely_done`, `needs_confirmation`, `blocked` o
`verification_failed` suspende todo el programa, incluso si contiene `try/catch`.
Consulta `progress` y `suspended` para continuar solo el trabajo pendiente. Los
efectos ya realizados no se revierten. Si vence el tiempo o se cancela durante
una operación activa, se cierra la sesión para detener acciones pendientes; una
suspensión normal conserva el navegador abierto.

Para acciones irreversibles autorizadas por el usuario, pasa
`authorized_goals: ["Objetivo exacto autorizado"]` fuera del código. El programa
no puede activar `allow_irreversible`. Las comprobaciones `check` son probabilidades;
usa `verify` para las condiciones deterministas disponibles.

Prueba con el backend real configurado en `.env`:

```bash
node --env-file=.env examples/code-mode.mjs
```

La suite `npm test` usa MCP y Chromium reales con respuestas HTTP simuladas para
ambas configuraciones. El ejemplo anterior consulta el modelo real y verifica
los campos del DOM. Code Mode no cambia la precisión ni la latencia de inferencia
de Laya/Jev. Para rutas lineales, puedes seguir usando `browser_run`.

## Descargas del navegador

Las descargas se guardan en `~/Downloads/laya-browser` por defecto. Configura
`JEV_BROWSER_DOWNLOADS_DIR` en el entorno del proceso MCP para cambiar el destino.
`browser_act` y `browser_do` incluyen las descargas de la sesión; usa
`browser_wait_for_download` para esperar el fin de una transferencia y
`browser_downloads` para consultar su estado, tamaño y ruta persistente. La ruta
corresponde al equipo donde se ejecuta el servidor MCP.

En `browser_run`, un paso puede exigir que termine una descarga nueva:

```json
{
  "goal": "Descargar el CSV de errores",
  "verify": { "download": { "filename": "errores.csv", "timeout_ms": 30000 } }
}
```

## 6. Ver CPU y RAM de Laya

En otra terminal, desde la raíz del repositorio:

```bash
node local/monitor-laya.mjs
```

Abre `http://127.0.0.1:8792`. El panel muestra gráficos del proceso de Laya,
actualizados cada segundo. El uso de CPU se expresa como porcentaje de un núcleo.
El historial se toma en el servidor del monitor, incluso si la pestaña está en
segundo plano. Si hay varios servidores Python, selecciona el proceso con
`LAYA_MONITOR_PID=<pid> node local/monitor-laya.mjs`; `/health` informa su PID.

### Verificar que el MCP realmente consulta Laya

Las respuestas de `browser_open`, `browser_do`, `browser_check` y `browser_choose`
incluyen `backend`, `decision_endpoint` y `decision_model`. Las operaciones de
inferencia también informan `decision_calls`; `jev_calls` se conserva en
`browser_do` por compatibilidad.

`browser_open`, `browser_snapshot`, `browser_act` y `browser_screenshot` no
consultan al modelo. `browser_do`, `browser_check` y `browser_choose` sí lo hacen,
salvo decisiones que se repliquen desde la caché en `browser_do`.

El endpoint `/health` incluye `inference_requests`, `inference_completed`,
`inference_errors`, `last_inference_ms` y `last_inference_cpu_ms`. Estos contadores
permiten confirmar la inferencia aunque el CPU ya haya vuelto a estar en reposo.
El tiempo de CPU suma el trabajo de los hilos y puede superar el tiempo real.

Con Laya activo, ejecuta una prueba real MCP → Laya → navegador:

```bash
node --env-file=.env local/laya-mcp-smoke.mjs
```

Comprueba la configuración del MCP, una decisión sin caché, el texto realmente
escrito y el incremento de inferencias del servidor Python. Si el monitor está
activo, también muestra el pico de CPU del proceso durante la prueba.

## Problemas frecuentes

### Aparece `jev_calls` en la respuesta

Es el nombre heredado del contador de llamadas al backend. No significa que se
esté consultando la API remota. Para comprobar la configuración de conexión desde
la raíz del proyecto:

```bash
JEV_BACKEND=laya node --input-type=module \
  -e 'import { BACKEND, API_URL } from "./src/jev.mjs"; console.log({ BACKEND, API_URL });'
```

Debe mostrar `laya` y el endpoint local. El proceso iniciado por tu cliente MCP
debe recibir esas mismas variables en su configuración `env`.

### `fetch failed` o conexión rechazada

Verifica que Laya haya terminado de cargar y que `/health` responda. Comprueba
también `JEV_API_URL`. Si el MCP corre en un contenedor o en otra máquina,
`127.0.0.1` apunta a ese entorno: la URL debe ser accesible desde el proceso MCP.

### `Address already in use`

Puede haber un servidor Laya activo. Comprueba `/health` antes de iniciar otro.
Para usar otro puerto, inicia Laya con `--port 8795` y cambia `JEV_API_URL` a
`http://127.0.0.1:8795/v1/systemone`.

### No aparece el parámetro `viewport`

Reinicia el servidor MCP y actualiza las herramientas del cliente. Comprueba que
la configuración use `bin/laya-browser-mcp.mjs` de este checkout.

### La página indica que es necesario iniciar sesión

Inicia sesión en el navegador visible y configura `JEV_BROWSER_PROFILE` para
conservarla. Si el modelo devuelve `needs_login` aunque ya estés autenticado,
inspecciona la página con `browser_snapshot` antes de continuar.
