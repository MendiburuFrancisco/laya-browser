# Ejecutar laya-browser por MCP con Laya local

Esta guía configura el servidor MCP del código fuente para que las decisiones
se ejecuten con Laya en tu equipo. No necesitas una clave de TypeSafe.

Hay dos procesos que deben estar activos:

1. **Servidor de inferencia Laya:** proceso Python en `http://127.0.0.1:8791`.
2. **Servidor MCP de laya-browser:** proceso Node.js que inicia tu cliente MCP.

El cliente MCP envía objetivos al servidor Node, que lee la página con Playwright,
consulta Laya localmente y ejecuta las acciones en el navegador.

### Visión y selección Box: exclusivas de Jev

Al configurar `JEV_BACKEND=jev`, `browser_do` puede tomar una captura para validar
contenido visual o encontrar un objetivo que no aparece en el DOM. Jev puede
seleccionar el objetivo mediante el primitivo `box` de TypeSafe.

También se exponen `browser_box({target})`, `browser_act_box({box_id,goal,action?})`
y `visual:true` en `browser_check`/`browser_choose`. En Code Mode usa
`browser.box({target})`, `browser.actBox({box_id,goal})` y
`browser.check({question,visual:true})`. Las capturas se envían al proveedor Jev;
los campos de contraseña y secretos conocidos se enmascaran.

La selección exige presencia única y confianza suficiente. Los IDs son de un solo
uso y dejan de ser válidos si cambian los píxeles, scroll, viewport o pestaña.
Los umbrales exclusivos de imágenes se configuran en `.env` o en el entorno del MCP:

```dotenv
JEV_IMAGE_MIN_PRESENCE=0.70
JEV_IMAGE_MIN_CONFIDENCE=0.70
```

El primero controla `p_visible` y el segundo la confianza del Box. Sin configurar,
sus valores son `0.85` y `0.60`. No modifican los umbrales del DOM, las probabilidades
de las validaciones ni las autorizaciones. Las respuestas Box incluyen `thresholds`
con los valores efectivos; reinicia el MCP para cargar código o entorno actualizado.

Se mantienen las autorizaciones de acciones irreversibles y los presupuestos de
Code Mode. Jev 1.14+ es necesario: el alias `jev-latest` se cambia a `jev-preview`
solo en solicitudes visuales; los modelos fijados explícitamente se conservan.

Con Laya estas herramientas no se registran y las llamadas visuales desde Code
Mode se rechazan antes de consultar al modelo. Consulta los ejemplos completos en
[README.md](README.md#jev-screenshot-validation-and-box-targets).

## Android nativo con Appium (experimental)

Usa el mismo MCP Node del repositorio. Para cargar los esquemas nuevos, reinicia
su conexión en tu cliente MCP después de actualizar el código.

Requisitos: Appium instalado, driver UiAutomator2 instalado y un emulador dedicado
visible en `adb devices -l`. En otra terminal:

```powershell
appium --address 127.0.0.1 --port 4723
```

No requiere un proceso MCP móvil adicional. Para navegar con Jev, configura
`JEV_BACKEND=jev` y sus credenciales como en web. Con Laya se utiliza su servidor
local. La navegación nativa con inferencia real se ha probado con Jev.

Primero crea una sesión con dispositivo explícito:

```json
{
  "target": {
    "kind": "android",
    "appium_url": "http://127.0.0.1:4723",
    "capabilities": {
      "platformName": "Android",
      "appium:automationName": "UiAutomator2",
      "appium:udid": "emulator-5554",
      "appium:noReset": true,
      "appium:forceAppLaunch": true
    }
  }
}
```

Pasa ese objeto a `browser_create_session` y conserva el `session_id`:

```text
browser_open({session_id, app:{package:"com.android.settings",activity:".Settings"}})
browser_snapshot({session_id})
browser_do({session_id, goal:"Open About phone showing Device name", max_actions:10,
  verify:{app_package:"com.android.settings",text_includes:"Device name"}})
browser_close({session_id})
```

En Code Mode, después de crear la sesión Android, también puedes abrir y navegar:

```js
return await browser.run({
  app: { package: "com.android.settings", activity: ".Settings" },
  steps: [{
    goal: "Open About phone showing Device name; scroll if necessary",
    max_actions: 10,
    verify: {
      app_package: "com.android.settings",
      text_includes: "Device name"
    }
  }]
});
```

`open` exige `url` para web o `app` para Android; `run` permite una de ellas o
ninguna. Cierra antes de volver a abrir una aplicación dentro de la misma sesión.
Cada target es inmutable. Los IDs de elementos pertenecen al snapshot mostrado;
una acción stale exige reobservar. `browser_act` admite `click`, `type`, `clear`,
`scroll` (value `up`/`down`), `back` y `wait` en Android. Después de actuar, toma un
nuevo snapshot antes de volver a usar números. `type` reemplaza el contenido y
comprueba foco antes y después de clear.

Verificaciones adicionales: `activity_includes`, `field:{label,value_key}` y
`element:{label,state}` con estados `enabled`, `disabled`, `checked`, `unchecked`,
`selected` o `clickable`. Las verificaciones solo reportan nombres de condiciones
fallidas, sin valores secretos. Usa claves como `password`/`token` para secretos
en `values`; nunca incluyas secretos en el texto del objetivo.

### Límites y recuperación

- Android nativo UiAutomator2: sin iOS, WebView, OCR, coordenadas libres ni gestos avanzados.
- HTML, tabs, red, descargas, vídeo y visión/Box devuelven `unsupported_capability`.
- Snapshot limitado a 240 elementos y 12000 caracteres de texto; informa truncamiento.
- El lease por UDID coordina sesiones del mismo proceso MCP, no clientes externos.
- No hay retries de POST/DELETE. Si se pierde una respuesta, el resultado incluye
  `outcome: "unknown"`. Inspecciona Appium antes de repetir el objetivo.
- Si se desconoce el resultado de creación/cierre, el cliente no recrea ni repite
  el cierre. Un fallo de cleanup conserva el lease; resolverlo puede requerir
  reiniciar el servidor Appium y el MCP.
- Desactivar Android: `JEV_MOBILE_ENABLED=0` en el entorno del proceso MCP.

### Pruebas reproducibles

```powershell
npm run test:android
$env:JEV_ANDROID_E2E="1"
$env:JEV_ANDROID_JEV_E2E="1"
$env:ANDROID_UDID="emulator-5554"
npm run test:e2e:android
```

El E2E abre Settings, navega sin cambiar ajustes, escribe/limpia una búsqueda y
cierra sus sesiones propias. El segundo caso usa Jev por MCP/Code Mode y verifica
la pantalla independientemente. Sin flags, los E2E se omiten; la suite por defecto
usa fixtures/mocks. Para reducir contención de Chromium en equipos ocupados:
`node --test --test-concurrency=2 test/*.test.mjs`.

## Ejecutar conversaciones en navegadores independientes

El MCP admite varias sesiones dentro del mismo proceso, con Laya y con Jev.
Cada conversación debe invocar **una vez** `browser_create_session` con `{}` y
conservar el `session_id` generado. Después debe enviarlo en **todas** sus llamadas
al navegador. No existe una selección global de sesión activa.

Ejemplo de llamadas MCP para una conversación:

```text
browser_create_session({}) → {session_id: "<id-A>", state: "idle"}
browser_open({session_id: "<id-A>", url: "https://example.com"})
browser_snapshot({session_id: "<id-A>"})
browser_do({session_id: "<id-A>", goal: "Iniciar sesión", values: {...}})
browser_execute({session_id: "<id-A>", code: "return await browser.listTabs();"})
browser_close({session_id: "<id-A>"})
```

La otra conversación crea su propio ID y utiliza el mismo patrón. Se puede
proporcionar un nombre único en `browser_create_session({session_id: "prueba-A"})`;
un nombre duplicado se rechaza para evitar compartir un navegador por accidente.
Los nombres admiten 1–80 letras ASCII, números, guiones y guiones bajos;
`default` está reservado. Es preferible dejar que el servidor genere los IDs.

- Cada sesión inicia su propio proceso de navegador al primer uso y tiene cookies,
  almacenamiento, pestañas, snapshots, tráfico de red y bloqueo de ejecución propios.
- Sesiones distintas pueden trabajar simultáneamente. Dos operaciones simultáneas
  sobre la misma sesión se rechazan explícitamente mientras esté ocupada.
- `browser_execute` fija la sesión para todo el programa: las llamadas internas
  `browser.*` no necesitan `session_id` ni pueden cambiar de sesión.
- Cerrar o cancelar una sesión no afecta a las otras. `browser_close` finaliza sus
  vídeos y deja el ID disponible para volver a abrir un navegador limpio; si hay
  perfil persistente, conserva el almacenamiento que Chromium persista en disco.
- `browser_list_sessions({})` muestra IDs, estado (`idle`/`started`) y `busy` sin
  cambiar de navegador. Los IDs pertenecen a la instancia del servidor MCP.
- Con sesiones nombradas, perfiles, descargas, vídeos y caché se separan bajo
  `sessions/<id-del-proceso>/<session_id>/` dentro de las rutas configuradas
  (para la caché, dentro de la carpeta que contiene el archivo configurado).
  El namespace del proceso evita conflictos entre procesos MCP que usen las mismas
  rutas base. Los perfiles nombrados se reutilizan al reabrir el mismo ID en ese
  proceso, pero no se recuperan automáticamente tras reiniciar el MCP.

Por compatibilidad, sin crear sesiones nombradas las llamadas sin `session_id`
siguen usando el navegador predeterminado y las rutas originales. Desde que se
crea una sesión nombrada, omitir el selector produce un error: no se elige un
navegador ajeno silenciosamente. Si ya existía `default`, se puede seguir usando
explícitamente con `session_id: "default"`.

**Reinicia/reconecta el MCP tras actualizar** para cargar el código y descubrir los
parámetros nuevos. Instrucción sugerida para cada conversación:

> Crea una sesión independiente con browser_create_session, conserva el ID y
> pásalo como session_id en todas las herramientas del navegador. Ejecuta el caso
> de prueba en esa sesión y ciérrala al terminar.

## Cambiar entre pestañas

Para crear y activar una pestaña usa `browser_new_tab` con `{"url":"https://example.com/"}`,
o `{}` para abrir `about:blank`. En Code Mode: `await browser.newTab({ url })`
o `await browser.newTab()`. Devuelve `{status,id,url,title,active}`, comparte cookies
y almacenamiento del contexto actual y no consulta al modelo.

Invoca `browser_list_tabs` con `{}` para obtener `{tabs:[{id,url,title,active}]}`.
Usa `browser_select_tab` con un único selector: `{"id":"tab-1"}`,
`{"url":"https://example.com/"}` o `{"title":"Example"}`. URL y título deben
coincidir exactamente con una sola pestaña; si hay varias coincidencias, usa el ID.
Los IDs son estables durante la sesión y no se reutilizan al cerrar pestañas.
Ambas herramientas funcionan sin consultar al modelo.

En Code Mode:

```js
const { tabs } = await browser.listTabs();
const target = tabs.find(tab => tab.id === values.tab_id);
if (!target) return { found: false };
await browser.selectTab({ id: target.id });
return await browser.snapshot();
```

Después de cambiar, toma un snapshot nuevo antes de usar números de elementos.
Las pestañas nuevas siguen activándose automáticamente; al cerrar la activa se
selecciona la última restante. `browser_open` navega la pestaña activa y
`browser_close` cierra la sesión completa. Reinicia o reconecta el cliente MCP
para descubrir las herramientas nuevas.

## Obtener el HTML completo bajo demanda

Invoca `browser_get_html` con `{}` para recibir `{url, html}` con el DOM actual
completo de la página principal, incluido el doctype y los cambios de JavaScript.
Se devuelve únicamente al solicitarlo, sin truncamiento ni consultas al modelo;
no se adjunta a snapshots ni a prompts de decisión. No incorpora el contenido
interno de iframes, shadow roots ni recursos externos. Puede contener datos sensibles.

En Code Mode usa `await browser.getHtml()`. Los límites generales de memoria y
salida de `browser_execute` siguen aplicándose; ajusta `max_output_chars` si necesitas
devolver un documento grande. Reinicia o reconecta el MCP para descubrir la herramienta.

## Inspeccionar llamadas API de la sesión actual

Las herramientas `list_network_requests` y `get_network_request` observan el tráfico
del mismo navegador que controla Laya. La captura comienza al iniciar la sesión y
se conserva entre navegaciones y pestañas; no hace falta reproducir el estado.

1. Navega y realiza la acción con las herramientas habituales.
2. Llama a `list_network_requests` con `{"resource_types":["fetch","xhr"]}`.
   Puedes añadir `url_contains`, `page` y `page_size` (máximo 100).
3. Pasa un `id` de la lista a `get_network_request`: `{"id":"<id observado>"}`.

El detalle incluye headers completos, payload y cuerpo de respuesta. Los cuerpos
indican `encoding` (`utf8` o `base64`), tamaño y truncamiento; los que todavía no
terminaron o no están disponibles se identifican explícitamente. Se conservan las
últimas 500 solicitudes en memoria; `dropped` indica descartes. Cada cuerpo devuelto
tiene un límite de 1 MiB. No se capturan mensajes WebSocket.

También están disponibles en `browser_execute` como
`browser.listNetworkRequests({...})` y `browser.getNetworkRequest({id})`, sin
consultar al modelo. Los headers y cuerpos pueden contener credenciales o datos
sensibles y se devuelven al cliente MCP; no se añaden automáticamente a los prompts
de decisión. Reinicia o reconecta el MCP para descubrir las herramientas nuevas.

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

### Diagnóstico de fallos en Code Mode y planes

Cuando una ejecución se detiene, revisa estos campos antes de volver a intentarlo:

- `info`: explicación del motivo de parada.
- `failed_operation` y `failed_method`: número de llamada y método de Code Mode que falló.
- `error`: mensaje multilínea original y causas encadenadas, con `phase`, `name`,
  `code` cuando existe y `hint` para fallos reconocidos. Los detalles se limitan a
  6000 caracteres, indicando explícitamente si se recortaron.
- `suspended.result`: en un `browser.run`, contiene `failed_step`, `goal`,
  `completed`, `remaining` y la fase (`navigation`, `step` o `verification`).
  `verification_failures` identifica las condiciones incumplidas sin devolver
  valores de campos; `action_errors` conserva hasta tres errores de acciones recientes.
- `progress[].plan`: progreso del plan anidado, también disponible si vence el
  tiempo durante un paso. `cleanup_error` informa por separado si falla la limpieza.

Por ejemplo, un ejecutable inexistente se informa en la fase `browser_launch`
con la causa de Playwright y una indicación para revisar `JEV_BROWSER` o instalar
Chromium. Un perfil ocupado conserva los logs de lanzamiento y orienta a cerrar
el proceso que lo usa o elegir otro perfil. Los fallos de conexión al modelo
incluyen el proveedor, endpoint, modelo y número de intentos.

Las llamadas consecutivas conservan su propio resultado en `progress`: si la
segunda falla, reanuda únicamente el trabajo pendiente según `resume`. No repitas
automáticamente los pasos completados. En herramientas MCP directas, las
excepciones se devuelven como `isError: true` con un objeto JSON de diagnóstico.

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

### Grabar vídeo de la sesión

En una sesión nueva, llama a `browser_open` con:

```json
{
  "url": "https://example.com",
  "record_video": {
    "dir": "./videos",
    "size": { "width": 1280, "height": 800 }
  }
}
```

También se admite `record_video` en `browser_run`. Se graba un WebM sin audio por pestaña, incluidas las ventanas emergentes, tanto en modo visible como headless. `size` es opcional; por defecto Playwright ajusta el viewport para que quepa dentro de 800×800. La grabación empieza al lanzar la sesión y requiere cerrarla para cambiar su configuración.

Consulta el estado con `browser_videos` o `await browser.videos({})` desde Code Mode. Para guardar la evidencia, llama a **`browser_stop_recording`** o `await browser.stopRecording({})`: espera a finalizar los vídeos y devuelve sus rutas absolutas en `videos`, junto con el estado y tamaño de cada archivo, **sin cerrar el navegador, las pestañas ni la sesión autenticada**. Solo el estado `completed` indica que está listo. Los archivos se guardan en la máquina donde corre el servidor MCP.

Para grabar otro tramo de la misma sesión, usa `browser_start_recording` o `await browser.startRecording({})`. Genera un nuevo archivo por pestaña abierta usando la carpeta y resolución configuradas; los archivos anteriores se conservan. Ambos controles son idempotentes: iniciar mientras ya se graba no duplica vídeos y detener de nuevo devuelve los resultados guardados. Mientras esté detenida, tampoco se graban pestañas nuevas. `browser_close` sigue guardando las grabaciones activas al cerrar, pero ya no es necesario para finalizar un vídeo.

```js
const saved = await browser.stopRecording({});
await browser.startRecording({}); // opcional: otro tramo, conservando el login
return saved;
```

Para grabar automáticamente cada sesión, configura `JEV_BROWSER_VIDEO_DIR` en el entorno del servidor MCP. `record_video: null` desactiva ese valor para una sesión. Reinicia o reconecta el cliente MCP para descubrir los nuevos controles de grabación. Si falta el ejecutable de FFmpeg de Playwright, ejecuta `npx playwright install ffmpeg`.

### No aparece el parámetro `viewport`

Reinicia el servidor MCP y actualiza las herramientas del cliente. Comprueba que
la configuración use `bin/laya-browser-mcp.mjs` de este checkout.

### La página indica que es necesario iniciar sesión

Inicia sesión en el navegador visible y configura `JEV_BROWSER_PROFILE` para
conservarla. Si el modelo devuelve `needs_login` aunque ya estés autenticado,
inspecciona la página con `browser_snapshot` antes de continuar.
