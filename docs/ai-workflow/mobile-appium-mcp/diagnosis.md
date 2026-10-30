# Diagnóstico: creación de sesión E2E Android

- Fecha: 2026-10-28.
- Cambio bajo prueba: extracción del GoalRunner, base `bef6467`.
- Fixture: Android Settings, dispositivo dedicado `emulator-5554`.

## Síntoma y evidencia

La primera ejecución opt-in sobre el servidor Appium preexistente `http://127.0.0.1:4723` falló **0/2**:

1. El caso de navegación directa agotó los **90 s** de creación. El cleanup informó creación de resultado desconocido; no disponía de session ID confirmado para repetirla o cerrarla.
2. El caso MCP Code Mode falló durante navegación/apertura con `Appium POST: unknown error`, **decision_calls=0**. No llegó al loop ni al backend de inferencia.

El diagnóstico no utilizó reintentos automáticos de mutaciones ni modificó los timeouts del cliente o tests.

## Sondas ejecutadas

- `adb devices` → `emulator-5554 device`.
- `adb -s emulator-5554 shell getprop sys.boot_completed` → `1`.
- `pm list instrumentation` → runner UiAutomator2 instalado.
- `pidof` para los procesos UiAutomator2 y `adb forward --list` → sin procesos/forwards reportados al inspeccionar tras el fallo.
- Logcat focalizado de AndroidRuntime/TestRunner → sin error útil en la ventana consultada.
- `GET /status` en `4723` → ready, Appium **3.2.2**. No demuestra que el driver pueda crear sesión.
- `GET /sessions` → ruta no soportada; `/appium/sessions` → descubrimiento de sesiones deshabilitado. No se habilitó esa capacidad en el servidor del usuario.
- Memoria libre observada: aproximadamente **640 MB** de **20 GB**. La carga/contención es una hipótesis, no una causa confirmada.
- `appium --version` tuvo un intento que no respondió en 30 s; una comprobación posterior devolvió `3.2.2`.

## Hipótesis y contraste

| Hipótesis | Evidencia / conclusión |
|---|---|
| Fallo dentro del GoalRunner o de Jev | No alcanzó esas fases; las pruebas sin dispositivo pasaron. No explica el fallo inicial de creación. |
| Emulador no disponible o sin arrancar | ADB y boot_completed lo contradicen. No demuestra salud completa de instrumentación. |
| Estado del servidor preexistente o contención del host | Compatible con los síntomas; faltan logs de creación del servidor original para confirmar causa raíz. |

## Cambio controlado de entorno y resultado

Se lanzó una instancia temporal propia, sin cambiar ni reiniciar el servidor `4723`:

```powershell
node "$env:APPDATA\npm\node_modules\appium\index.js" --address 127.0.0.1 --port 4725 --log "$env:TEMP\opencode\appium-goal-runner.log" --log-no-colors
```

La primera sonda de arranque de esa instancia no observó readiness dentro de 15 s y se detuvo su proceso propio. Tras comprobar la versión, se lanzó de nuevo con una sonda de readiness de hasta 90 s; este límite solo corresponde al arranque del servidor externo, no altera las assertions/timeouts del producto o E2E.

Con el servidor dedicado listo se ejecutó:

```powershell
$env:APPIUM_URL="http://127.0.0.1:4725"
$env:JEV_ANDROID_E2E="1"
$env:JEV_ANDROID_JEV_E2E="1"
$env:ANDROID_UDID="emulator-5554"
npm run test:e2e:android
```

Resultado: **2/2 pasan**, **163,2 s**.

- Navegación directa: About phone, 33 elementos; scroll/back/type/clear verificados, 97,2 s.
- Jev real vía MCP Code Mode: done, completed=1, decision_calls=3, plan=47.708 ms, postcondición `Device name` satisfecha.
- Los E2E cierran sus sesiones propias en finally; el proceso temporal se detuvo por su PID propio al terminar.
- Artefacto local: `C:\Users\franc\AppData\Local\Temp\opencode\appium-goal-runner.log`.

## Conclusión y regresión preventiva

La causa raíz del fallo del servidor original permanece **inconclusa**. La creación y ambos flujos reales sí funcionan con una instancia dedicada, manteniendo las mismas assertions/timeouts. Los resultados fallidos y exitosos se registran por separado.

Los contratos simulados mantienen cobertura de timeout de cuerpo HTTP, creación de resultado desconocido sin retry, cleanup incierto y retención del lease. Para repetir E2E, usar un servidor/dispositivo dedicados con readiness observable y cleanup propio; un resultado de creación desconocido requiere resolver ownership antes de otra creación sobre ese servidor.

## Ejecución del plan 06 — apertura MCP y WeHealthy

### Inventario y conciliación

- Base: `bef6467`, rama `feature/mobile-appium-mcp`, con los cambios GoalRunner
  preexistentes del working tree preservados. Se inventariaron Git, procesos,
  puertos y sesiones antes de editar.
- MCP: entrada `bin/laya-browser-mcp.mjs`, paquete 0.2.1. El proceso conectado
  conservaba la sesión lógica `75ce1930-70e2-48b1-bca0-0c174cccc81b` con creación
  desconocida: snapshot informó sesión no abierta y open rechazó otro POST.
  No se liberó ese lease para repetir la creación. El usuario reconectó el MCP
  antes de la aceptación final y se verificó una lista de sesiones vacía.
- `4723`: sin listener ni respuesta de status durante esta ejecución. C1/C2
  quedaron sin ejecutar; no se reinició ni se habilitó descubrimiento en un
  servidor ajeno. Su fallo histórico sigue sin causa confirmada.
- `4725`: se identificó el control alternativo anterior por su script y árbol
  de procesos. Su log confirma `New Command Timeout of 600 seconds expired`
  a las 15:40:13 del reloj del host. Esto confirma la expiración de esa sesión;
  no explica el fallo original de creación. El control terminó por su TTL y se
  comprobó que no quedaban listener, instrumentación ni forwards antes del nuevo caso.
- Android: `emulator-5554`, boot completo, runner UiAutomator2 instalado, paquete
  WeHealthy presente y activity resuelta `ar.com.portalsalud.base.MainActivity`.
- Servidor dedicado nuevo: Appium **3.2.2**, Node **24.14.0**, endpoint explícito
  `http://127.0.0.1:4725`. El PID propio de diagnóstico fue `75880`; se detuvo
  antes del login. La instancia de aceptación `97752` no escribió archivo y
  descartó stdout/stderr. Se detuvo tras el cierre confirmado de la sesión MCP.

### Causas y correcciones sustentadas

| Evidencia | Conclusión / corrección |
|---|---|
| El cliente agrupaba timeout, JSON inválido y conexión perdida en un mensaje. | Se instrumentaron request, headers, cuerpo, extracción del ID y primera observación con correlación/duración. Códigos distintos; cuerpos excluidos de trazas. |
| Code Mode tenía 60 s por defecto frente a 90 s de creación Appium. La apertura MCP final tardó **67.459 ms** y fue válida. | Presupuesto Code Mode predeterminado **120 s**, máximo existente 300 s. Appium conserva 90 s de creación y 15 s por comando/cuerpo; la cancelación explícita se mantiene. No se afirma que esto causara el fallo de `4723`. |
| El log del control alternativo confirma expiración a los 600 s sin comandos. | Default interactivo **600 s**, con overrides preservados y error `appium_session_expired`; no heartbeat ni recreación silenciosa. |
| Revisiones reprodujeron aborto previo, cleanup expirado concurrente y GETs pendientes tras un fallo. | Preflight conocido sin envío; coalescencia del cierre normalizado; aborto y draining de observaciones hermanas, combinado con la señal de ejecución. |
| Un fallo del primer snapshot podía dejar una sesión propia abierta. | Se cierra solo su ID confirmado y se conserva el diagnóstico primario junto con `error.cleanup` si falla el cierre. |

### Reproducción comparativa y aceptación

Toda la interacción de aceptación con la app se realizó mediante herramientas
MCP. Los clientes Node de diagnóstico utilizaron el protocolo MCP stdio, no el
driver directamente ni un puente HTTP de acciones. Después de la reconexión,
el recorrido funcional usó las herramientas `laya-browser` expuestas a OpenCode.

| Caso | Resultado real |
|---|---|
| C1/C2, servidor original | No ejecutados: `4723` no disponible. |
| C3, Settings directo | El primer control sin `forceAppLaunch` conservó WeHealthy y no se contó como Settings aprobado. Con esa única variable habilitada, mostró `com.android.settings/.Settings`, **33 elementos**. |
| C4, WeHealthy directo | Pantalla de bienvenida identificable, **6 elementos**, mismo ID para snapshots sucesivos; **65 s** sin comandos/heartbeat y nuevo snapshot correcto. Cierre confirmado y reapertura limpia correctos. |
| C5, WeHealthy Code Mode | `browser.open` + `browser.snapshot`, **done**, paquete/activity y bienvenida verificados; cero decisiones para apertura/observación. Revalidado tras el hardening de cancelación. |
| Control `forceAppLaunch=true` en WeHealthy | Produjo snapshots vacíos en una ejecución. No se contó como aceptación ni se convirtió en default; se confirmó contenido identificable al volver a las capabilities anteriores. |
| Herramientas MCP tras reconexión | Sesión `d2a5be5f-be1b-4256-b9a1-2b9d852c5d2a`; open **done**, **67.459 ms**, bienvenida identificable y continuidad hasta el checkout. |

En un control de Settings, el cliente de diagnóstico intentó parsear un snapshot
de texto como JSON después de recibirlo. Se detuvo ese control, se identificó su
ID propio `1844adf3-117e-42e3-acaf-81254841cab4` en el log y se cerró por DELETE
confirmado antes del siguiente caso. La repetición MCP de Settings cerró luego
su sesión mediante `browser_close`; no fue retry de una creación incierta.

### Resultado funcional WeHealthy

1. Bienvenida → email → contraseña → pantalla principal autenticada, confirmada
   por el saludo al usuario y la navegación de cuenta.
2. Se completó el tutorial de tres pasos mediante MCP.
3. Cuenta abrió **Perfil**; **Planes** mostró **Pack gratuito**, **Activo**, **$0/mes**.
4. **Mejorar mi plan** abrió el catálogo. Se abrió el detalle de **Pack personal,
   $20/mes** y se pulsó **Elegir nuevo plan**, dentro de la selección autorizada.
5. Snapshot posterior: **Adquirí tu nuevo plan → Resumen de pago**, Pack gratuito
   **Actual $0**, Pack personal **Nuevo $20**, diferencia **$20**, total a pagar hoy
   **$20**, botón **Continuar con Mercado Pago**. Check complementario: `p_yes=0.98`.
6. Se detuvo antes de Mercado Pago. No se confirmó pago ni contratación. El resumen
   todavía identificaba el Pack gratuito como actual.
7. `browser_close` devolvió `closed: true`; después se detuvo el Appium propio.

Las credenciales fueron recibidas como valores de runtime en las herramientas;
no se copiaron a este informe, fixtures, scripts ni comandos de shell. Se usó una
clave sensible `secret_email` para redactar también el identificador en las
observaciones posteriores. No se guardaron logs Appium del tramo autenticado.

### Setup repetible

Iniciar un servidor dedicado en un puerto libre y verificar `/status` antes de
crear la sesión lógica. Para el tramo autenticado, evitar logs HTTP que incluyan
cuerpos o descartarlos en el proceso lanzador:

```powershell
appium --address 127.0.0.1 --port 4725 --log-level error
```

Target de WeHealthy probado:

```json
{
  "kind": "android",
  "appium_url": "http://127.0.0.1:4725",
  "capabilities": {
    "platformName": "Android",
    "appium:automationName": "UiAutomator2",
    "appium:udid": "emulator-5554",
    "appium:noReset": true,
    "appium:appWaitActivity": "*",
    "appium:newCommandTimeout": 600
  }
}
```

Crear sesión → abrir con `{package:"ar.com.portalsalud.wehealthy",
activity:"ar.com.portalsalud.base.MainActivity"}` → snapshot con el mismo
`session_id`. Para Code Mode, usar `browser.open` y `browser.snapshot` dentro de
`browser_execute`; pasar credenciales solo en `values`. Finalizar con
`browser_close`, confirmar el resultado y detener únicamente el proceso propio.

### Límites observados

- La causa histórica de `4723` continúa inconclusa; el endpoint predeterminado no cambió.
- `browser_do` devolvió `needs_login` aun con valores suministrados. El acceso se
  completó con `browser_act` sobre snapshots MCP, no como login autónomo del modelo.
- El autofill de Android interrumpió una escritura con `stale element reference`.
  Se reobservó, canceló la sugerencia y se continuó sobre un snapshot nuevo.
- El modelo eligió un enlace `Mi plan` del árbol previo y quedó `stuck`; la ruta
  confirmada fue Cuenta → Perfil → Planes. Estas limitaciones de decisión/árbol
  nativo no se presentan como reparadas por el cambio de apertura.
- No hay recuperación automática de ownership incierto ni coordinación entre procesos.
- Logs de creación anteriores al login: `C:\Users\franc\AppData\Local\Temp\opencode\mcp-session-opening-appium.log`.
