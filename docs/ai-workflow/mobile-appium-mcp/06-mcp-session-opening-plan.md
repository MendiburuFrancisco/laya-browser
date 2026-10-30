# Plan: resolver la apertura de sesión Android desde el MCP

- Fecha: 2026-10-28.
- Estado: implementación y aceptación sobre servidor dedicado ejecutadas; causa histórica de `4723` inconclusa. Ver cierre al final.
- Rama de trabajo: `feature/mobile-appium-mcp`.
- Contexto: prueba solicitada sobre WeHealthy después de implementar el GoalRunner común.
- Referencias: [diagnosis.md](diagnosis.md), [03-build.md](03-build.md), [04-review.md](04-review.md).

## 1. Objetivo

Conseguir que el MCP `laya-browser` cree una sesión Appium propia, abra WeHealthy y pueda seguir observando y actuando sobre la misma sesión, con diagnóstico y cleanup verificables.

La validación funcional posterior debe realizarse mediante las herramientas del MCP:

1. Abrir WeHealthy.
2. Iniciar sesión con las credenciales suministradas por el usuario, recibidas en tiempo de ejecución.
3. Navegar a **Perfil → Planes**.
4. Seleccionar un plan disponible y verificar qué estado produjo la selección.

**Crear una sesión Appium y autenticar un usuario en WeHealthy son operaciones distintas.** El fallo inicial ocurre en la primera, antes del login de la aplicación.

## 2. Evidencia disponible y límites de lo conocido

| Observación | Qué demuestra | Qué no demuestra |
|---|---|---|
| El MCP acepta `browser_create_session` y devuelve `state: idle`. | Se registró una sesión lógica local. | Todavía no existe necesariamente una sesión Appium ni se abrió la app; el lanzamiento es diferido. |
| `browser_open` contra `127.0.0.1:4723` devuelve `Appium POST response unavailable or invalid`, `outcome: unknown`. | El cliente no obtuvo una respuesta válida para confirmar la creación. | No distingue todavía timeout, aborto, conexión perdida, cuerpo inválido o fallo del servidor. Tampoco demuestra que Appium no haya creado una sesión. |
| Reiniciar OpenCode y repetir produjo el mismo fallo. | Ese reinicio no fue suficiente para resolverlo. | No identifica una causa raíz del servidor o del dispositivo. |
| `adb devices` muestra `emulator-5554`; se resolvió la activity de WeHealthy. | Hay conectividad ADB y el paquete está instalado. | No garantiza que UiAutomator2 pueda arrancar ni que el MCP pueda crear sesión. |
| `GET /status` del servidor original respondió ready, Appium 3.2.2. | El proceso HTTP responde. | No prueba la salud del ciclo de creación de UiAutomator2. |
| El E2E anterior de Settings pasó mediante MCP/Code Mode con Appium dedicado en `4725`. | Existe evidencia real histórica de esa superficie con ese target. | No valida la apertura actual de WeHealthy ni el servidor `4723`. |
| Un script temporal abrió WeHealthy con Appium dedicado en `4725`. | Ese recorrido de control pudo crear sesión y observar la app. | No es evidencia de éxito del MCP: utilizó el driver directamente y también ADB para una captura. |
| Ese recorrido recibió después `invalid session id`. | La sesión remota dejó de ser utilizable. | La expiración por inactividad es una hipótesis hasta contrastarla con los logs de Appium. |

Estado funcional alcanzado en el recorrido alternativo: pantalla de acceso y email ingresado. No se confirmó autenticación, ingreso a Planes ni selección de plan.

La causa raíz sigue **inconclusa**. El plan no asume que cambiar el puerto, reiniciar OpenCode o aumentar timeouts constituya una corrección suficiente.

## 3. Reglas de ejecución y evidencia

- Usar un único emulador dedicado y una sola operación por dispositivo a la vez.
- Registrar y cerrar los procesos/sesiones temporales propios antes de iniciar otra reproducción sobre el mismo dispositivo.
- Si una creación termina con resultado desconocido, no repetir `POST /session` automáticamente. Primero resolver ownership y estado remoto con evidencia.
- No liberar el lease local ni borrar el estado incierto solo para permitir otro intento.
- No cerrar sesiones ajenas ni reiniciar el Appium preexistente sin confirmar propiedad y autorización.
- Shell y ADB pueden utilizarse para diagnóstico del entorno. El recorrido de aceptación sobre la app debe usar el MCP; si se cambia de superficie, se registra como control separado y se detiene esa validación de aceptación.
- No persistir las credenciales de WeHealthy en el plan, fixtures, comandos de ejemplo ni logs. Capturar los logs de creación antes del login o aplicar redacción previa al almacenamiento.
- La selección de plan autorizada no incluye confirmar una compra, un pago ni contratar una suscripción de pago adicional.

## 4. Fases de diagnóstico y corrección

### Fase A — Inventario y ownership

1. Registrar el estado de Git y los cambios preexistentes; la base debe incluir el GoalRunner actual sin sobrescribir trabajo pendiente.
2. Identificar qué proceso MCP está cargado, su ruta de entrada, backend, versión/base y configuración efectiva de Appium.
3. Inventariar los servidores Appium relevantes: endpoint, versión, PID, forma de arranque y disponibilidad de logs.
4. Verificar ADB, boot, instalación de UiAutomator2, paquete y activity de WeHealthy.
5. Registrar las sesiones lógicas del MCP y los leases retenidos por creaciones o cierres inciertos.
6. Conciliar los recursos propios del intento alternativo. Para una sesión sin ID confirmado, usar logs o descubrimiento soportado en un servidor propio; no habilitar descubrimiento global en un servidor ajeno para sortear el problema.

**Salida:** inventario reproducible, recursos propios identificados y una condición explícita de dispositivo disponible. Si no se puede resolver un recurso incierto, se registra el bloqueo antes de crear otra sesión.

### Fase B — Instrumentación mínima de creación

Separar y medir estas etapas:

```text
Solicitud MCP
  → validación de target
  → adquisición del lease
  → construcción del driver
  → POST /session
      → conexión y envío
      → recepción de headers
      → lectura del cuerpo y parseo
  → extracción del session ID
  → primera observación de la app
  → respuesta MCP
```

1. Asignar un ID de correlación por intento y registrar inicio, fin y duración de cada etapa.
2. Distinguir timeout del cliente Appium, timeout de la llamada MCP, timeout de Code Mode, aborto externo y error HTTP remoto.
3. Conservar estado HTTP, fase, código técnico saneado y `outcome`, sin registrar cuerpos completos ni valores sensibles.
4. Registrar las capabilities efectivas mediante una lista segura: plataforma, automation name, UDID, package/activity y parámetros de espera relevantes.
5. Correlacionar esos datos con logs de creación del servidor dedicado y diagnósticos Android del mismo intervalo.
6. Mantener el límite de creación y la lectura del cuerpo bajo control; no ampliar tiempos para ocultar una fase que quedó colgada.

**Salida:** el próximo fallo identifica dónde se detuvo, con una cronología correlacionada. El mensaje genérico actual deja de ser la única evidencia disponible.

### Fase C — Reproducción comparativa controlada

Ejecutar los casos **en serie**, con cleanup entre casos y sin repetir una creación incierta:

| Caso | Superficie | Servidor | Target | Propósito |
|---|---|---|---|---|
| C1 | Herramientas MCP directas | Original `4723`, solo si está disponible y su estado fue conciliado | Settings | Comprobar si el fallo es general de creación. |
| C2 | Herramientas MCP directas | Original `4723`, bajo las mismas condiciones | WeHealthy | Aislar el lanzamiento de la app. |
| C3 | Herramientas MCP directas | Dedicado `4725` | Settings | Control de entorno desde la superficie requerida. |
| C4 | Herramientas MCP directas | Dedicado `4725` | WeHealthy | Validación principal de apertura de WeHealthy por MCP. |
| C5 | MCP Code Mode | Endpoint confirmado operativo | WeHealthy | Comparar routing, presupuestos y errores con las herramientas directas. |

Para cada caso registrar: ID de intento, superficie, configuración, duración, session ID remoto confirmado o ausencia de confirmación, primer snapshot, estado final y resultado del cleanup.

Comparar inicialmente capabilities idénticas. Después cambiar **una variable por vez** si la evidencia lo exige:

- Endpoint/estado del servidor Appium.
- Activity y `appium:appWaitActivity` de WeHealthy; la activity resuelta fue `ar.com.portalsalud.base.MainActivity` en el paquete `ar.com.portalsalud.wehealthy`.
- Tiempo de arranque de instrumentación y de la app.
- Contención del host/emulador.
- Deadline efectivo del transporte MCP frente a los 90 s actuales de creación del cliente Appium.

Un script directo contra el driver solo se admite como control diagnóstico etiquetado; no sustituye C1–C5 ni permite declarar aprobado el MCP.

**Salida:** hipótesis confirmada o refutada con un caso mínimo. Si no hay causa confirmada, el estado sigue siendo diagnóstico inconcluso.

### Fase D — Corrección mínima según la causa

| Causa demostrada | Corrección a evaluar |
|---|---|
| Desalineación entre deadline MCP y creación Appium | Coordinar cancelación/deadlines y cleanup; exponer un diagnóstico inequívoco. Ajustar configuración solo con tiempos medidos y límites acotados. |
| Espera de activity incorrecta | Configurar la espera de lanzamiento observada para WeHealthy y comprobar que las capabilities atraviesan MCP sin alteración. |
| Estado degradado del servidor original | Recuperar únicamente recursos propios o usar un endpoint dedicado explícito en el target MCP. Documentar la causa y el requisito operativo; no cambiar silenciosamente el endpoint predeterminado. |
| Fallo de instrumentación o dispositivo | Corregir el componente identificado y repetir el caso mínimo desde MCP. |
| Creación válida seguida de fallo del primer snapshot | Preservar el ID confirmado, informar fase de observación y cerrar solo esa sesión propia. |
| Sesión expirada durante pausas interactivas | Confirmar el timeout remoto real, configurar una duración acotada apropiada al uso interactivo y reportar expiración de forma explícita. No recrear la sesión ni repetir acciones pendientes de manera implícita. |
| Lease retenido por estado desconocido | Diseñar una recuperación explícita basada en ownership comprobado, sin convertir el resultado desconocido en una liberación automática. |

**Salida:** prueba que falla antes y pasa después de la corrección, acompañada de una reproducción real desde MCP.

### Fase E — Pruebas de contrato y regresión

Ampliar los seams existentes para cubrir:

1. Creación lenta pero válida dentro del presupuesto acordado.
2. Headers recibidos con cuerpo bloqueado, cuerpo inválido y conexión perdida.
3. Aborto/timeout en creación: una sola petición, resultado desconocido cuando corresponde y lease retenido.
4. Creación con ID confirmado seguida de fallo de observación: diagnóstico y cleanup de ese ID.
5. Sesión remota expirada: error estructurado, sin recreación silenciosa y sin replay de acciones.
6. Equivalencia de fases, códigos y outcomes entre MCP directo y Code Mode.
7. Preservación de `appium:appWaitActivity` y `appium:newCommandTimeout` suministrados explícitamente en el target.
8. Redacción de secretos en respuestas, errores y trazas nuevas.
9. Un fallo de apertura impide ejecutar login y pasos dependientes.
10. Cleanup fallido no oculta el error primario de creación/apertura; ambos resultados quedan disponibles para diagnóstico.

Ejecutar los tests focalizados después de cada cambio y, al terminar, la regresión completa:

```powershell
node --test --test-concurrency=2 test/driver-contract.test.mjs test/appium-driver.test.mjs test/android-actions.test.mjs test/android-mcp.test.mjs test/plan.test.mjs
npm run test:android
node --test --test-concurrency=2 test/*.test.mjs
```

La ubicación de pruebas adicionales se decidirá según el seam corregido. No se relajarán assertions ni se convertirán fallos reales en skips.

### Fase F — Aceptación real desde MCP

1. Crear una sesión lógica nueva con target Android explícito y el endpoint verificado.
2. Abrir WeHealthy mediante `browser_open` y obtener `browser_snapshot` con el mismo `session_id`.
3. Comprobar que la sesión sigue operativa después de una pausa representativa dentro del timeout declarado, sin heartbeat que oculte el escenario evaluado.
4. Repetir una apertura limpia después de cerrar la sesión propia. La repetición ocurre después de un cierre confirmado, no como retry de una creación incierta.
5. Ejecutar apertura y observación también desde `browser_execute`, verificando la equivalencia con la superficie directa.
6. Con la apertura estable, continuar el flujo solicitado: login → Perfil → Planes → selección de un plan.
7. Verificar el estado real después de cada transición; una respuesta de clic exitosa no prueba que la pantalla haya cambiado ni que el login haya terminado.
8. Si aparece confirmación de pago o contratación adicional, detenerse e informar el estado alcanzado.
9. Cerrar la sesión y los procesos propios al finalizar, o registrar expresamente si se conserva la sesión para inspección del usuario.

Toda la interacción con la app en esta fase debe quedar en llamadas MCP. No se admiten el puente HTTP temporal, invocaciones directas al driver o comandos ADB de interacción como sustitutos.

## 5. Archivos candidatos

Inspeccionar y modificar únicamente los que la causa demostrada requiera:

- `src/drivers/appium/client.mjs`: transporte, deadlines, creación, errores y ownership.
- `src/drivers/appium/driver.mjs`: lanzamiento, primera observación y lifecycle.
- `src/browser-sessions.mjs`: leases y recuperación explícita de estados inciertos.
- `src/target-config.mjs`: capabilities y validación del target.
- `src/browser-api.mjs`: routing y contratos compartidos.
- `src/plan.mjs`: detención antes de pasos dependientes y diagnóstico de navegación.
- `bin/laya-browser-mcp.mjs`: factory, fases de error y límites de la operación MCP.
- Tests Android/MCP/Code Mode y `test/android.e2e.mjs`.
- Documentación MCP y este directorio para registrar diagnóstico, corrección y evidencia.

## 6. Criterios de aceptación

| ID | Criterio | Evidencia exigida |
|---|---|---|
| SO-01 | Se identifica la fase y causa técnica de los fallos de apertura reproducidos. | Cronología cliente/servidor correlacionada; hipótesis y contraste. |
| SO-02 | WeHealthy abre desde MCP directo y permite obtener snapshots sucesivos con la misma sesión. | Respuestas MCP reales y pantalla identificable de la app. |
| SO-03 | La misma apertura funciona desde MCP Code Mode. | `browser_execute` con resultado confirmado y observación posterior. |
| SO-04 | Una pausa dentro del timeout declarado no invalida inesperadamente la sesión. | Caso interactivo reproducible, duración y timeout remoto registrados. |
| SO-05 | Una creación incierta no produce otra creación automática ni libera indebidamente el dispositivo. | Tests de petición única, ownership y lease. |
| SO-06 | Sesiones expiradas y errores de cleanup son explícitos y no ocultan el fallo primario. | Contratos negativos y diagnóstico completo saneado. |
| SO-07 | Las trazas nuevas no filtran credenciales. | Tests de redacción e inspección de artefactos. |
| SO-08 | La corrección conserva la regresión web/Android. | Suites focalizadas y completa verdes. |
| SO-09 | Se completa el flujo login → Perfil → Planes → selección desde MCP. | Historial de herramientas MCP y estado posterior verificado; sin confirmar pagos adicionales. |
| SO-10 | Un tercero puede repetir el setup y el caso. | Endpoint, versiones, capabilities, comandos y cleanup documentados. |

## 7. Entregables y condición de cierre

- Diagnóstico actualizado que distingue causa confirmada, hipótesis descartadas y cualquier incertidumbre restante del servidor original.
- Corrección mínima con pruebas negativas y positivas.
- Evidencia real de apertura, continuidad y cleanup por MCP directo y Code Mode.
- Resultado del recorrido WeHealthy solicitado, separado de la reparación técnica del lifecycle.
- Registro de la revisión del cambio y de los riesgos residuales.

**No se considera resuelto por abrir la app mediante un script alternativo, por obtener únicamente `state: idle` ni por aumentar un timeout sin demostrar la causa.**

Las secciones anteriores conservan el plan original. La ejecución y sus límites se registran en el cierre siguiente.

## 8. Cierre de ejecución

- Implementación: diagnóstico HTTP correlacionado, cancelación/draining, cleanup
  propio con preservación del error primario, expiración explícita y defaults
  interactivos acotados. Los límites Appium de creación/comando siguen en 90/15 s.
- Validación: suite Android **43/43**, regresión completa **252/252**, sin skips;
  dos revisiones independientes con hallazgos corregidos y revalidados.
- C3: Settings desde MCP directo, 33 elementos, con `forceAppLaunch=true`.
- C4: WeHealthy desde MCP directo, snapshots sucesivos, pausa de 65 s y reapertura
  después de cierre confirmado. Apertura posterior desde herramientas MCP: 67,459 s.
- C5: apertura y snapshot de WeHealthy desde MCP Code Mode, `status: done`.
- Aceptación funcional: login confirmado → Cuenta/Perfil → Planes → Mejorar mi
  plan → Pack personal → Elegir nuevo plan. Estado posterior: resumen de pago,
  Pack gratuito actual, Pack personal nuevo y $20 a pagar. Se detuvo antes de
  Continuar con Mercado Pago; no hubo confirmación de compra.
- Cleanup: sesión MCP final cerrada y procesos Appium temporales propios detenidos.
- C1/C2: no ejecutados porque `4723` no estaba disponible. No se declara resuelta
  su causa histórica ni se atribuye a un timeout sin logs del servidor original.
- Detalles, límites observados y setup repetible: `diagnosis.md`, `03-build.md`
  y `04-review.md`.
