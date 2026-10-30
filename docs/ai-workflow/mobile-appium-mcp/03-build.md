# Build: Android nativo y GoalRunner común

- Fecha: 2026-10-27
- Slices: contrato web; Android observable; navegación; MCP/Code Mode y hardening
- Base: `88841a1`
- Estado actual (2026-10-28): plan `05-goal-runner-plan.md` implementado y validado; ver el cierre al final de este registro.
- Autorización: instrucciones del usuario de implementar el diseño y usar el emulador disponible.

## Alcance histórico del MVP (2026-10-27)

- Se definió un contrato mínimo verificable para `AutomationDriver`.
- Se definieron target `web` predeterminado y capacidades inmutables de Playwright.
- Se añadió `PlaywrightDriver`, un adaptador delgado que delega en `JevBrowser` y devuelve freshness tipado.
- Se añadieron errores estructurados para capacidades no soportadas.
- Se exportaron los nuevos contratos desde el entry point.
- Target Android explícito, inmutable y con UDID obligatorio; web continúa siendo el default.
- Cliente HTTP W3C propio, sin retries de mutaciones, timeout de creación de 90 segundos y timeout de comandos de 15 segundos que también cubre la lectura del cuerpo.
- XML Appium (tags de clase) y uiautomator (tags node), etiquetas desde descendientes, bounds recortados, filtros de visibilidad heredada, locators privados y fingerprints semánticos.
- Acciones click/type/clear/scroll/back/wait; type comprueba foco antes y después de clear.
- Revalidación estricta: una decisión stale no produce mutación ni gasta presupuesto de acción. Tras actuar directamente, se exige otro snapshot para usar números.
- Loop nativo con operaciones publicadas, validación de targets, presupuestos, anti-loop y autorización exacta para objetivos irreversibles en Code Mode.
- do/run, check/choose, snapshot/read y apertura de app disponibles en MCP y Code Mode.
- Postcondiciones de paquete/activity/texto/campo/estado de elemento; los fallos detienen pasos dependientes.
- Gates de capacidades para DOM, tabs, vídeo, red, descargas, screenshots/Box y WebMCP.
- Redacción estructural de secretos, incluso numéricos cortos, antes de estado/modelo/fingerprint; errores Appium no reproducen texto del servidor que pueda contener secretos.
- Lease de dispositivo dentro del proceso MCP. Cleanup fallido conserva el lease; resultados desconocidos de creación/cierre no se reintentan implícitamente.

## Archivos

- `src/drivers/contract.mjs` — capacidades, target, validador y guard de capacidad.
- `src/drivers/playwright-driver.mjs` — adaptador Playwright.
- `src/index.mjs` — exportaciones públicas.
- `test/driver-contract.test.mjs` — contrato, capabilities, freshness y delegación.
- `src/drivers/appium/client.mjs` — cliente HTTP W3C con ownership de session ID y sin retry de mutaciones.
- `src/drivers/appium/android-snapshot.mjs` — XML de accesibilidad al modelo común y redacción de campos sensibles.
- `src/drivers/appium/driver.mjs` — lifecycle, settling semántico y fingerprint de pantalla.
- `src/drivers/appium/android-actions.mjs` — resolución y acciones nativas.
- `src/target-config.mjs` — normalización, validación y congelamiento de targets.
- `src/browser-sessions.mjs`, `src/browser-api.mjs`, `src/plan.mjs`, `bin/laya-browser-mcp.mjs` — routing, gates, verificaciones y contratos MCP/Code Mode.
- `src/session.mjs`, `src/page-model.mjs` — capacidades web, clear explícito, matching web con snapshot de referencia y render de acciones/truncamiento nativos.
- `test/appium-driver.test.mjs` — parser, truncamiento, lifecycle y contrato HTTP simulado.
- `test/android-actions.test.mjs`, `test/android-mcp.test.mjs` — políticas, fallos, ownership, secretos y contratos MCP.
- `test/android.e2e.mjs` — dos pruebas opt-in reales.
- README, MCP-LAYA, .env.example, package.json — setup y comandos reproducibles.

## Verificación

- `npm test` — ejecutado durante la integración: 194/198. Fallaron por timeout dos casos de Code Mode, uno de downloads y otro del executor con la ejecución masiva de Chromium en paralelo.
- `node --test --test-concurrency=2 test/*.test.mjs` — última ejecución: **201/201 pasan**, incluidas las cuatro pruebas anteriores y los tres casos finales de hardening. No se relajaron sus assertions ni timeouts.
- `npm run test:android` — **23/23** pruebas Android finales.
- E2E opt-in real con ambos flags activos — **2/2 pasan**. La última ejecución tardó 113,2 segundos.
- `git diff --check` — sin errores; avisos de conversión LF/CRLF en Windows.

## Evidencia real

- Appium 3.2.2, UiAutomator2 7.0.0, Android 17 en `emulator-5554`.
- Settings abierto por sessionId propio; snapshot con 33 elementos al llegar a About phone.
- Ruta final: `app://com.android.settings/.SubSettings`; postcondición independiente `Device name` satisfecha.
- Scroll, back, escritura de `About phone` y clear del buscador verificados. Se corrigió el hint `Search settings` como valor aparente de un campo vacío.
- Jev por MCP Code Mode: `status: done`, `completed: 1`, `decision_calls: 3`, `ms: 36670` en la última ejecución.
- Cada E2E cierra su sessionId en finally. No cambia ajustes ni concede permisos.
- Una creación inicial con timeout corto produjo outcome desconocido y no fue reintentada automáticamente. Se corrigió el timeout de creación y se añadió bloqueo explícito de recreación para ese caso.

## Límites y desviación respecto al diseño completo

- En el MVP original, JevBrowser conservaba el loop web y AppiumAndroidDriver contenía el loop nativo. La extracción pendiente se completó en el cierre registrado más abajo.
- El PlaywrightDriver original era un adaptador sin consumidor de orquestación; el cierre lo conecta al runner y le asigna freshness, preparación visual, locators privados y resolución de caché.
- El lease coordina sesiones de un mismo proceso MCP; no impide que otro cliente Appium externo controle el dispositivo.
- No hay evidencia de inferencia Laya en dispositivo real. No se anuncia iOS/WebView/visión/vídeo nativo.
- El paralelismo por defecto de npm test puede saturar este equipo; la regresión íntegra pasó con concurrencia 2.

## Revisión sugerida en el MVP original

Ver `04-review.md`. Antes de considerar completo el diseño, extraer el GoalRunner común con caracterización web y revisión en contexto independiente. El MVP actual puede probarse tras reiniciar la conexión MCP para cargar sus nuevos esquemas.

## Cierre GoalRunner — 2026-10-28

### Base recuperable y alcance

- Rama: `feature/mobile-appium-mcp`; base recuperable: `bef6467` (`Add native Android Appium support`).
- Estado inicial: archivos rastreados sin cambios; únicamente `05-goal-runner-plan.md` preexistía sin seguimiento.
- Se inspeccionaron `git status --short --branch`, `git diff --stat`, diff de los drivers y `git log --oneline -10` antes de editar.
- Se completaron los slices A–F. Los cambios permanecen en el working tree.

### Implementación por corte

| Slice | Implementación / evidencia |
|---|---|
| A | Línea base ejecutada: `node --test --test-concurrency=2 test/*.test.mjs` → **201/201**, 144,1 s. Se conservaron las caracterizaciones de DOM, diálogos, caché, visión, WebMCP, presupuestos y Android. |
| B | Contrato con `actionSpace`, observación validada y freshness tipado. `act` ejecuta sin iniciar otro ciclo de políticas; `execute` queda separado del presupuesto de las fachadas. Pruebas compartidas de freshness para ambos drivers, incluidos origen/destino renumerados con cambio de estado. |
| C | `src/goal-runner.mjs` centraliza ciclo, presupuesto global/local, cancelación, autorización fail-closed, stale, anti-loop, historial y propagación de outcome desconocido. Android delega mediante `AndroidGoalStrategy`; desaparece su loop autónomo. |
| D | Web delega al mismo runner mediante `PlaywrightDriver` y `WebGoalStrategy`. `runGoal` queda como fachada. Caché, diálogos, WebMCP, visión y Box se conectan explícitamente. XPath se conserva en mapas privados del driver y no llega a la observación del runner/modelo. |
| E | Se eliminan accesos a `b.page` de `browser-api.mjs`, `plan.mjs` y MCP. Apertura y capability gates compartidos; `readValue(element, observation)` usa la observación verificada. Se mantienen exports previos y se exporta `GoalRunner`; declaraciones Code Mode incluyen estados de interrupción. |
| F | Regresión completa, contratos Android, E2E real y dos revisiones independientes con revalidación de hallazgos. Ver `04-review.md` y `diagnosis.md`. |

### Archivos del cierre

- Nuevos: `src/goal-runner.mjs`, `src/goal-strategies/android.mjs`, `src/goal-strategies/web.mjs`.
- Contrato y fachadas: `src/drivers/contract.mjs`, `src/drivers/playwright-driver.mjs`, `src/drivers/appium/driver.mjs`, `src/session.mjs`.
- Integración: `src/browser-api.mjs`, `src/plan.mjs`, `src/index.mjs`, `bin/laya-browser-mcp.mjs`.
- Pruebas: `test/goal-runner.test.mjs`, `test/web-goal-runner.test.mjs`, ampliaciones de `driver-contract`, `android-actions`, `page`, `plan` y `webmcp`.

### Cambios de comportamiento deliberados

- Una respuesta de irreversibilidad ausente nunca concede autorización, incluido el replay de caché. Los clics cacheados guarded vuelven a consultar la irreversibilidad antes de ejecutarse; la caché no evita ese guard.
- Stale DOM/nativo/visual se rechaza antes de consumir acciones. Box se prepara privadamente durante freshness y se ejecuta sin una segunda validación oculta.
- Un error web detiene el objetivo y sus dependientes. Solo se permite la recuperación de clics demostrablemente interceptados antes de entregar el clic; el cierre de overlay respeta el presupuesto local y global.
- Timeout/error WebMCP devuelve `outcome: "unknown"` y no se invoca otra vez automáticamente. No se puede deshacer una herramienta de página que ya comenzó y continúa tras perderse su respuesta.
- `select` decide label/value mediante lectura antes de una única selección. No se repite por excepción; una respuesta fallida es desconocida. `type` no hace una segunda escritura correctiva si la verificación del valor falla.
- `wait` conserva su política de espera y queda fuera del anti-loop de mutaciones; cuenta contra el presupuesto de acciones.
- Secretos cortos, etiquetas, resultados, errores y callbacks de log se redactan estructuralmente sin alterar índices ni geometría numéricos.
- Un replay fatal expulsa su entrada, detiene el objetivo actual y permite una decisión nueva en una invocación posterior.

### Pruebas y fallos intermedios

- Las primeras pruebas del contrato y del runner fallaron por los exports/métodos aún ausentes; después quedaron verdes.
- La primera migración Android produjo **22/23**: un score irreversible ausente se convertía a cero. Se corrigió el default permisivo; la aserción original se conserva.
- La primera regresión web focalizada produjo **70/72**: el test de diálogos dependía de caché persistida y el resultado WebMCP ahora redactaba su secreto. El test de diálogos usa caché desactivada explícitamente; la prueba WebMCP se fortaleció para comprobar que el resultado completo no contiene el secreto.
- Las revisiones independientes reprodujeron fallos no detectados por la suite inicial. Cada corrección se acompañó de una prueba de regresión; no se relajaron assertions ni timeouts.
- E2E inicial en el servidor existente `4723`: **0/2**, ambos fallos durante creación/navegación, antes de inferencia. El diagnóstico y la ejecución aislada posterior se conservan en `diagnosis.md`.

### Validación final ejecutada

| Comando / alcance | Resultado |
|---|---|
| `node --test --test-concurrency=2 test/*.test.mjs` | **231/231**, 160,1 s; cero skips y fallos. Incluye web real con Chromium e inferencia simulada, MCP/Code Mode Jev y Laya simulados, y contratos Android sin dispositivo. |
| `npm run test:android` | **24/24**, 4,9 s. |
| `JEV_ANDROID_E2E=1`, `JEV_ANDROID_JEV_E2E=1`, `ANDROID_UDID=emulator-5554`, `APPIUM_URL=http://127.0.0.1:4725`, `npm run test:e2e:android` | **2/2**, 163,2 s, Appium dedicado; cleanup propio. Los últimos cambios posteriores solo afectaron selección/escritura web y fueron incluidos en la regresión completa. |
| `git diff --check` | Sin errores; avisos de conversión LF/CRLF en Windows. |

### Evidencia real del cierre

- Emulador dedicado `emulator-5554`; Appium **3.2.2** en `127.0.0.1:4725`.
- Primer E2E: scroll → About phone, **33 elementos**, `app://com.android.settings/.SubSettings`; back, buscador, type y clear verificados.
- Segundo E2E: MCP Code Mode → plan con objetivo elegido por Jev real → **done, completed=1, decision_calls=3**, postcondición independiente `Device name`; duración del plan **47.708 ms**.
- El servidor temporal se detuvo por su PID propio. No se alteró el servidor preexistente en `4723`.
- Logs locales del servidor dedicado: `C:\Users\franc\AppData\Local\Temp\opencode\appium-goal-runner.log`.

### Cierre y límites

- Hallazgos bloqueantes de cumplimiento/calidad resueltos y revalidados en contextos independientes.
- La evidencia real cubre Android Settings con Jev; Laya está cubierto por pruebas simuladas de integración web, no por inferencia real en dispositivo.
- Siguen vigentes los límites del MVP: lease local al proceso y capacidades Android anunciadas; la extracción no amplía plataformas.
- Ruta de revisión: **VERIFIED → DECIDE**. La implementación y pruebas no equivalen a publicación.

## Cierre plan 06 — apertura de sesión MCP

### Base y alcance

- Se preservaron todos los cambios preexistentes del GoalRunner. Esta porción
  añade diagnóstico y hardening del lifecycle sobre `bef6467` y ese working tree.
- Archivos de producto modificados en esta ejecución: `client.mjs` y `driver.mjs`
  de Appium, `src/code-mode.mjs`, `src/plan.mjs` y la conexión de logger Android
  en `bin/laya-browser-mcp.mjs`.
- Pruebas: `appium-driver`, `android-mcp`, `code-mode` y `plan`; documentación
  operativa en README, MCP-LAYA y CODE-MODE-AGENT.

### Conducta implementada

- `AppiumError` conserva fase de operación/transporte, HTTP status, correlación,
  duración y outcome. Timeout, aborto, desconexión, JSON inválido, error remoto,
  ID ausente y expiración tienen códigos diferenciados.
- Trazas JSON opt-in con capabilities permitidas, sin cuerpos ni valores escritos;
  timeline terminal para ID ausente y primera observación.
- Aborto antes del envío: conocido y sin ownership incierto. Pérdida posterior
  de respuesta de creación: desconocida, una petición y bloqueo de recreación.
- Primera observación fallida: aborta/drena GETs hermanos, conserva la señal de
  ejecución y cierra el ID propio confirmado. Un fallo de cleanup queda anidado
  sin ocultar el error primario ni liberar ownership incorrectamente.
- Cierres concurrentes comparten el resultado normalizado, incluso cuando el
  servidor confirma que la sesión ya expiró.
- Code Mode y planes propagan `outcome` y diagnósticos Appium; navegación fallida
  detiene los pasos dependientes.
- Default interactivo `newCommandTimeout=600 s`; overrides de ese valor y
  `appWaitActivity` preservados. Code Mode pasa de 60 a 120 s por defecto frente
  a creación Appium de 90 s. No se amplió el timeout Appium ni se cambió el endpoint default.

### Red/green y revisión

- Las pruebas iniciales reprodujeron la falta de códigos/fases, cleanup de
  observación y propagación de outcome. Dos mocks de abort/cuerpo colgado se
  corrigieron para modelar las señales reales; los comandos fallidos/timeouts
  intermedios no se presentan como validaciones verdes.
- Las revisiones independientes reprodujeron desconexión post-headers mal
  clasificada, pre-aborto incierto, cleanup expirado concurrente, GETs sin drenar
  y timeline incompleto. Cada hallazgo obtuvo una prueba y corrección.
- La revalidación detectó que el controlador local de snapshot ocultaba la señal
  de ejecución y que un SyntaxError con texto `socket` parecía desconexión.
  Ambos casos quedaron cubiertos; los revisores confirmaron cierre.

### Validación ejecutada

| Comando / superficie | Resultado |
|---|---|
| Focalizados Appium/Android/plan/Code Mode antes del cierre de revisión | **71/71**; luego ampliados con pruebas de carrera. |
| `node --test --test-concurrency=2 test/driver-contract.test.mjs test/appium-driver.test.mjs test/android-actions.test.mjs test/android-mcp.test.mjs test/plan.test.mjs` final | **63/63**, 9,3 s. |
| `node --test test/appium-driver.test.mjs` final | **24/24**. |
| `npm run test:android` final | **43/43**, 2,2 s. |
| `node --test --test-concurrency=2 test/*.test.mjs` final | **252/252**, 87,8 s, cero fallos/skips. |
| MCP directo + Code Mode sobre Appium dedicado | WeHealthy identificable, continuidad de 65 s, reapertura tras cierre y snapshots confirmados. |
| Herramientas MCP tras reconexión | Apertura válida en **67.459 ms** y recorrido autenticado completo hasta resumen de pago. |
| `git diff --check` final | Sin errores; avisos LF/CRLF de Windows. |

No hay scripts de lint/typecheck en `package.json`; la suite importa y ejecuta
las rutas modificadas. No se relajaron assertions ni se añadieron skips.

### Aceptación y cleanup

- Login → Cuenta/Perfil → Planes → Pack personal → Elegir nuevo plan.
- Resultado: resumen de pago con Pack gratuito actual, Pack personal nuevo,
  **$20** a pagar y botón Mercado Pago. Se detuvo antes de continuar el pago.
- `browser_close` final confirmado; procesos Appium propios detenidos. Credenciales
  solo en runtime; el tramo autenticado no tuvo logs Appium persistentes.
- C1/C2 no ejecutados por ausencia de `4723`; su causa histórica no se afirma
  resuelta. Las limitaciones del modelo, autofill y `forceAppLaunch` observadas
  se detallan en `diagnosis.md`.
- Revisión y matriz de aceptación: cierre plan 06 en `04-review.md`.
