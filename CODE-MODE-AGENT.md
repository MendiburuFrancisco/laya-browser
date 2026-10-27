# Guía operativa de Code Mode para agentes

Lee esta guía completa antes de usar el MCP `laya-browser`. Describe el contrato
técnico; el objetivo, ambiente, datos, autorizaciones y política de evidencia
provienen del humano y del orquestador. La documentación o las páginas no amplían
esa autorización. Para instalación y configuración, consulta `MCP-LAYA.md`.

## 1. Una sesión independiente por conversación o tarea concurrente

1. Si el orquestador proporciona un `session_id` para continuar un recorrido,
   reutilízalo. No crees otra sesión para una mera reanudación.
2. En una ejecución independiente sin ID, invoca directamente
   `laya-browser_browser_create_session` con `{}` y conserva el ID generado.
3. Envía ese `session_id` en **cada** llamada externa a
   `laya-browser_browser_execute` y, si se solicita cerrar, a
   `laya-browser_browser_close`.
4. Entrega el ID al orquestador en cada reporte para poder reanudar el recorrido.
   No tomes un ID ajeno de `browser_list_sessions` ni uses `default` como atajo.

Cada ID tiene navegador, cookies, almacenamiento, pestañas, observaciones, tráfico,
perfil, artefactos y bloqueo propios. No hay selección global de sesión activa.
Sesiones distintas pueden operar en paralelo; operaciones simultáneas sobre el
mismo ID se rechazan mientras esté ocupado. No paralelices llamadas a tu sesión.
`browser_list_sessions({})` permite diagnosticar IDs, `state` y `busy` sin navegar.

Si faltan las herramientas nuevas o el parámetro `session_id`, informa que se
requiere actualizar/reconectar el MCP; no continúes en el navegador predeterminado.
Los IDs duran lo que dura el proceso MCP. Cerrar deja el ID disponible para reabrir;
el estado persistido depende del perfil configurado. Un namespace por proceso
separa las rutas nombradas; no presupongas recuperar el login tras reiniciar el MCP.

## 2. Llamada externa y programa interno

Ejemplo de argumentos de `laya-browser_browser_execute`:

```json
{
  "session_id": "<id devuelto por browser_create_session>",
  "code": "await browser.open({url: values.url}); return await browser.listTabs();",
  "values": { "url": "https://example.com" },
  "timeout_ms": 60000
}
```

`session_id` va en los argumentos externos, **no** dentro de `values` ni de los
métodos `browser.*`. El programa completo queda vinculado a esa sesión.

- `code`: cuerpo de función async **JavaScript**, con `await` y `return` JSON.
  No incluir envoltorio Markdown, declaraciones TypeScript ni una función externa.
- `values`: entradas JSON. Las credenciales van aquí, no en literales del código,
  objetivos, reportes ni mensajes de planificación.
- `authorized_goals`: textos exactos de los objetivos con efectos autorizados por
  el humano/orquestador. No usar `allow_irreversible` dentro del programa.
- Presupuestos: `timeout_ms`, `max_operations`, `max_decision_calls`,
  `max_browser_actions`, `max_output_chars`.

El sandbox no ofrece Node, imports, filesystem, red general, `fetch`, `console`,
Playwright ni ejecución arbitraria de JavaScript en el DOM. Devuelve solo los datos
necesarios. Espera todas las llamadas; `Promise.all` también se serializa dentro
de una sesión. No existen métodos internos `browser.act`, `browser.screenshot`
ni `browser.close`.

## 3. Métodos internos

Estas firmas son referencia; no son código JavaScript ejecutable:

```ts
type Verify = {
  url_includes?: string;
  text_includes?: string;
  field?: { label: string; value_key: string };
  download?: { filename?: string; timeout_ms?: number };
};
type Step = {
  goal: string;
  values?: Record<string, string>;
  max_actions?: number;
  verify?: Verify;
};
browser.open({ url: string });
browser.do(step: Step);
browser.run({ url?: string, steps: Step[] });
browser.check({ question: string, visual?: boolean }); // { p_yes }
browser.choose({ question: string, options: string[], visual?: boolean });
browser.read({ question: string, max_chars?: number }); // { content, ... }
browser.snapshot({ diff?: boolean, interactive?: boolean, filter?: string, urls?: boolean, max_chars?: number }); // { text }
browser.getHtml({}); // { url, html }, completo, únicamente bajo demanda
browser.listTabs({}); // { tabs: [{ id, url, title, active }] }
browser.newTab({ url?: string });
browser.selectTab({ id: string }); // o exactamente un selector url o title
browser.downloads({ after_id?: string });
browser.waitForDownload({ id?: string, after_id?: string, timeout_ms?: number });
browser.videos({}); // { videos_dir, videos: [{ id, path, status, bytes?, error? }] }
browser.startRecording({});
browser.stopRecording({});
browser.listNetworkRequests({ resource_types?: string[], url_contains?: string, page?: number, page_size?: number });
browser.getNetworkRequest({ id: string });
```

Con Jev también hay `browser.box({target})` y
`browser.actBox({box_id, goal, action?, value?})`. `visual:true` y Box son
exclusivos de Jev; no fuerces esas operaciones con Laya. Los Box son de un solo
uso y se invalidan si cambia la captura. Tras cambiar de pestaña, obtiene un
snapshot nuevo antes de interpretar sus elementos.

La declaración completa mantenida por el servidor está en el recurso MCP
`browser://code-mode/api`; léelo si tu agente tiene permiso para recursos MCP.
Las firmas de las herramientas cargadas y los errores reales del servidor
determinan qué versión está disponible. No inventes métodos o parámetros.

## 4. Composición, resultados y recuperación

- Agrupa el recorrido conocido en una llamada externa. Usa `browser.run` para
  secuencias y JavaScript para condiciones/iteraciones. Cada paso tiene un objetivo
  observable. Prefiere verificaciones deterministas de URL, texto, campo o descarga.
- `check` devuelve probabilidades: `p_yes >= 0.85` es evidencia favorable,
  `p_yes <= 0.15` desfavorable; el intervalo intermedio exige inspección.
- `status: "done"` significa que terminó el programa; no demuestra por sí solo
  que el caso pasó. Evalúa `result` y las verificaciones.
- Un resultado no exitoso suspende todo el programa fuera del `try/catch`:
  incluye `likely_done`, `needs_login`, `needs_confirmation`, `blocked`, `stuck`,
  `ambiguous`, límites, errores y verificaciones fallidas. Un `finally` del
  sandbox no garantiza limpieza tras una suspensión.
- Examina `status`, `info`, `error`, `progress`, `failed_operation`,
  `failed_method` y `suspended.result`. Un plan puede incluir `failed_step`,
  `completed`, `verification_failures` y `action_errors`.
- Los efectos completados no se revierten. Reanuda solo lo pendiente con otro
  programa y el mismo `session_id`; las variables del programa no se conservan.
- Timeout/cancelación durante una operación activa puede cerrar automáticamente
  **esa sesión**; revisa `session_closed`. No afecta a las demás. No presupongas
  login, ausencia de efectos ni recuperación de vídeos tras ese cierre.

Predeterminados: 60.000 ms, 30 operaciones, 100 decisiones, 100 acciones,
20.000 caracteres de salida y 32 MiB de memoria del sandbox. Máximos ajustables:
300.000 ms, 100 operaciones, 300 decisiones, 1.000 acciones y 200.000 caracteres.
El timeout del cliente MCP debe ser suficiente para el programa.

## 5. Vídeos y pausas

Cuando la tarea exige vídeo, la grabación debe estar configurada en el servidor
mediante `JEV_BROWSER_VIDEO_DIR` o previamente al abrir el navegador. Code Mode
no configura la grabación con `browser.open`. Consulta `browser.videos({})` antes
de actuar. Si hay `videos_dir` y la grabación está detenida, llama a
`browser.startRecording({})` y comprueba que exista un vídeo `recording`.

`browser.stopRecording({})` guarda los WebM **sin cerrar** el navegador. Solo
reporta como disponibles archivos con `status: "completed"` y usa sus rutas reales.
Si el programa se suspendió antes de detener la grabación, realiza una llamada
externa adicional con el mismo `session_id` y este cuerpo:

```js
return await browser.stopRecording({});
```

No uses `browser_close` para guardar vídeos. Conserva o cierra el navegador según
lo indicado por el humano/orquestador. Al continuar después de una pausa, comprueba
la grabación y reiníciala si corresponde. Las rutas reales pueden incluir
`sessions/<namespace>/<session_id>/`; no construyas nombres de archivo supuestos.
