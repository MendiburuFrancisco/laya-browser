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

## 6. Ver CPU y RAM de Laya

En otra terminal, desde la raíz del repositorio:

```bash
node local/monitor-laya.mjs
```

Abre `http://127.0.0.1:8792`. El panel muestra gráficos del proceso de Laya,
actualizados cada segundo. El uso de CPU se expresa como porcentaje de un núcleo.

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
