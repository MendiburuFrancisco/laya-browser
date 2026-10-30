# Revisión de Android y GoalRunner común

- Estado actual (2026-10-28): **VERIFIED → DECIDE**, con revisiones independientes y hallazgos cerrados. Ver sección de cierre al final.

- Base: `88841a1`; revisión contra los archivos reales y las ejecuciones registradas en `03-build.md`.
- Método histórico del MVP: dos pasadas internas consecutivas (cumplimiento y calidad); no era revisión por otro agente/persona.
- Ruta histórica del MVP: **CHECKS_FAIL → BUILD**, por extracción arquitectónica pendiente. Ese pendiente se resuelve en el cierre siguiente.

## Cumplimiento funcional

| AC | Estado | Evidencia / observación |
|---|---|---|
| AC-01 | Verificado | Regresión completa web/MCP/Code Mode: 201/201 con concurrencia 2; target default web. |
| AC-02 | Verificado | Cliente W3C simulado, E2E con cleanup propio y guard contra creación/cierre duplicados. |
| AC-03 | Verificado en corte | Fixtures node/class-tag, redacción, clipping, visibilidad heredada y XML real Settings. No valida toda la variedad de widgets Android. |
| AC-04 | Verificado | Acciones/targets inventados rechazados antes de mutar; locators privados fuera de JSON/modelo. |
| AC-05 | Verificado | Click/type/clear reales en Settings; foco comprobado y fallo de foco simulado. |
| AC-06 | Verificado | Cambio de pantalla → cero mutaciones; stale observado también durante carga real del buscador. |
| AC-07 | Verificado | Respuesta perdida o JSON inválido → una petición, outcome unknown; sin retry implícito. |
| AC-08 | Verificado | Scroll y back en E2E; wait acotado seguido de nueva observación en el loop. |
| AC-09 | Verificado | Modelo irreversible o sin respuesta → needs_confirmation; host autoriza solo el objetivo exacto. |
| AC-10 | Verificado | Falso done → verification_failed; postcondición Device name en E2E MCP Code Mode. |
| AC-11 | Verificado | Gates MCP y Code Mode: HTML, tabs, red, descargas, vídeo, WebMCP y screenshot. |
| AC-12 | Verificado en seams | Estado/snapshots/historial redactados; secretos numéricos conservan índices/bounds numéricos; errores HTTP no reproducen cuerpos del servidor. |
| AC-13 | Verificado en proceso | Segundo target con el mismo UDID rechazado; lease de operación existente. No coordina procesos externos. |
| AC-14 | Verificado | Error de acción y falso done detienen el plan antes del siguiente objetivo. |
| AC-15 | Verificado | Dos E2E opt-in sobre emulator-5554; Jev completó About phone por MCP Code Mode en tres llamadas. |

## Calidad y hallazgos

1. **P2 — refactor pendiente:** `src/session.mjs` y `src/drivers/appium/driver.mjs` conservan loops separados. Esto duplica políticas y no cumple todavía la arquitectura GoalRunner común de la sección 5 del diseño. Requiere otro corte de refactor con suite web verde; no se presenta el diseño integral como terminado.
2. **P2 — sensibilidad temporal de la suite:** npm test con concurrencia automática tuvo cuatro timeouts; el mismo conjunto pasó completo con `--test-concurrency=2`. No se modificó la semántica ni se relajaron pruebas para ocultarlos.
3. **Límite explícito:** leases locales al proceso, sin soporte para sesiones Appium prestadas, iOS, WebView, visión o vídeo nativo.
4. **Revisión independiente pendiente:** esta revisión fue realizada en el mismo contexto del implementador. No equivale a la aprobación independiente prevista antes de habilitar mobile por defecto.

La revisión corrigió antes del cierre: locators absolutos con predicados de identidad para no escoger un duplicado invisible; redacción estructural para no corromper números; timeout que cubre el cuerpo HTTP; errores sin eco de secretos; lease retenido si cleanup falla y coalescencia de cierres concurrentes.

## Comandos y resultados

- Regresión íntegra: `node --test --test-concurrency=2 test/*.test.mjs` → 201/201.
- Contratos Android finales: `npm run test:android` → 23/23.
- E2E: `JEV_ANDROID_E2E=1`, `JEV_ANDROID_JEV_E2E=1`, `npm run test:e2e:android` → 2/2.
- Último E2E Jev: completed=1, decision_calls=3, url=app://com.android.settings/.SubSettings.
- No se realizaron commit, push, merge ni publicación.

## Cierre independiente del GoalRunner — 2026-10-28

### Alcance y método

- Base de comparación: `bef6467`, rama `feature/mobile-appium-mcp`; se revisaron el diff y los archivos nuevos sin seguimiento.
- Dos contextos de revisión independientes del implementador, exclusivamente de lectura. Cada uno entregó hallazgos reproducibles y revalidó las correcciones.
- Cumplimiento: tarea `ses_e7d2356cbffe3B9bRDLODWjuOJ`. Revisión inicial F1–F6; segunda pasada encontró F7 (retry interno de select); tercera pasada confirmó cierre F1–F7, **16/16** pruebas web del runner.
- Calidad: tarea `ses_e7d23563fffegoKr5t2zDjHWct`. Revisión de seguridad/regresiones; revalidación encontró retención de caché y luego cancelación durante resolución de opciones; cierre focalizado confirmó **1/1** y ningún bloqueante pendiente de sus hallazgos.
- Los revisores ejecutaron contratos/pruebas pequeñas y reproducciones con objetos simulados. No ejecutaron el emulador; el E2E real indicado abajo fue ejecutado por el implementador.

### Matriz de aceptación del cierre

| ID | Estado | Evidencia |
|---|---|---|
| GR-01 | Verificado | `JevBrowser.runGoal` y `AppiumAndroidDriver.do` delegan a `GoalRunner`; estrategias sin loops autónomos equivalentes. |
| GR-02 | Verificado | Runner sin imports/acceso a Playwright, Appium, XML o locators ejecutables. Pruebas con driver falso y observación web sin XPath. |
| GR-03 | Verificado con hardening explícito | Regresión **231/231**: DOM, caché, diálogos, WebMCP, visión/Box, tabs, red, vídeo y downloads. Cambios seguros de error/retry/redacción enumerados en Build. |
| GR-04 | Verificado | Matriz de freshness común en ambos drivers; cambio de estado origen/destino, caché stale y Box stale: cero mutaciones y presupuesto intacto. |
| GR-05 | Verificado | HTTP Android perdido/JSON inválido: petición única. WebMCP timeout y select con respuesta perdida: `unknown`, una invocación y plan detenido. Type no repite escritura correctiva. |
| GR-06 | Verificado | Autorización exacta del host, incluida caché web; respuesta irreversible ausente rechazada antes de mutar. |
| GR-07 | Verificado | Cancelación antes/durante inferencia y durante lectura previa de select; presupuestos globales/locales, replay y recuperación de overlay. Cleanup y supervisión Code Mode conservados. |
| GR-08 | Verificado en seams | Redacción estructural de secretos cortos; inferencia, resultado, error y callback de log; índices/bounds numéricos conservados. |
| GR-09 | Verificado | Error web/nativo, outcome desconocido y falso done detienen dependientes. Verificación de campo usa su propia observación, sin confundir índices anteriores. |
| GR-10 | Verificado | Apertura y gates compartidos, API/plan sin `b.page`, esquemas y tipos sincronizados; contratos MCP/Code Mode con backends Jev y Laya simulados. |
| GR-11 | Verificado en entorno real | E2E **2/2** sobre Settings en `emulator-5554`, Appium dedicado `4725`, Jev real mediante MCP Code Mode, postcondición `Device name`. |
| GR-12 | Verificado | Informes independientes identificados arriba, correcciones con pruebas de regresión y revalidaciones explícitas. |

### Hallazgos y resolución

| Hallazgo reproducido | Severidad de revisión | Resolución y prueba |
|---|---|---|
| Error web/timeout WebMCP podía repetirse o convertirse después en done | P1 | Errores detienen el objetivo; WebMCP propaga unknown. Tests `ordinary web action failure` y `timed out WebMCP mutation`. |
| Verificación podía leer otro campo por índices de `shown` | P1 | `readValue(element, observation)`; test `field verification uses its own observation`. |
| Etiquetas/errores filtraban secretos al logger | P1 | Redacción antes del callback; test `web logs redact echoed credentials`. |
| Freshness permitía estados cambiados del origen/destino | P1 | Comparación de estado antes del remapeo; test compartido `web freshness remaps indices`. |
| Box stale consumía acciones antes de validarse | P2 | Preparación privada en freshness; test `stale Box ... before consuming`. |
| Cierre de overlay excedía maxActions local | P2 | Auxiliares comprueban e incrementan ambos presupuestos; test `overlay recovery cannot exceed`. |
| Scroll nativo recibía una respuesta de value propia de type | P2 | Valor real solo para type; test `Android scroll ignores a value-key answer`. |
| Wait se detenía por anti-loop tras dos esperas | P2 | Política de loading separada; test `successive waits use their loading policy`. |
| Cancelación durante inferencia podía terminar en done | P2 | Comprobaciones post-await y antes de finalizar; test `cancellation during inference`. |
| Select reintentaba cualquier fallo por valor tras intento por label | Alta | Resolución read-only antes de una única selección; test `select resolves label or value ... never retries`. |
| Replay fatal retenía entrada de caché | P2 | Hook de invalidación anterior al stop; test `fatal cache replay evicts its entry`. |
| Cancelación durante lectura de opciones aún enviaba select | P2 | Guard inmediatamente antes de la mutación; test `select cancellation during option resolution`. |

Todos estos hallazgos están cerrados. No se rebajaron assertions/timeouts para conseguir los resultados.

### Verificaciones finales y evidencia

- Implementador: `node --test --test-concurrency=2 test/*.test.mjs` → **231/231**, 160,1 s; sin skips.
- Implementador: `npm run test:android` → **24/24**.
- Implementador: E2E opt-in con Appium dedicado `4725` → **2/2**, 163,2 s. Plan Jev: **completed=1, decision_calls=3**, 47.708 ms; `app://com.android.settings/.SubSettings` y `Device name` verificado.
- Revisores: suites focalizadas **56/56**, **29/29**, selección de nuevos casos **3/3**, revisión web posterior **16/16** y cierre de cancelación **1/1**, según sus informes separados.
- `git diff --check` sin errores; avisos LF/CRLF.
- Fallo previo real en `4723`: creación/navegación, **0/2**, sin llamadas al modelo. No se elimina del registro ni se presenta el diagnóstico como causa raíz confirmada; ver `diagnosis.md`.

### Riesgo residual y ruta

- La inferencia real de dispositivo se comprobó con Jev; las rutas Laya tienen evidencia simulada de contrato/integración, no inferencia real Android.
- Una herramienta WebMCP ya iniciada puede seguir ejecutándose en la página tras perder su respuesta. El runner se detiene con outcome desconocido y no repite la llamada ni continúa dependientes.
- La disponibilidad/contención del servidor Appium externo queda fuera del control del runner. La instancia dedicada proporciona evidencia reproducible sin modificar timeouts del producto.
- El lease sigue siendo local al proceso y no coordina clientes Appium externos.
- Ruta principal final: **VERIFIED → DECIDE**. Implementación validada y revisada; no se realizó publicación.

## Revisión del plan 06 — apertura MCP

### Base y método

- Alcance: slice de lifecycle/diagnóstico descrito en el cierre de `03-build.md`,
  sobre el working tree GoalRunner preexistente. Se preservó su trabajo pendiente.
- Cumplimiento independiente: `ses_e7cb72c1bfferExa4Ncjy37Cti`; encontró clasificación
  post-headers y timeline incompleto, luego confirmó ambos cerrados, **22/22**.
- Calidad independiente: `ses_e7cb71623ffejVi6DxWaPUqGH7`; reprodujo carreras de
  cleanup, pre-aborto y observación. La revalidación añadió señal de ejecución
  y SyntaxError; cierre final **24/24**, sin bloqueante en esas correcciones.
- La aceptación real y los resultados **43/43** Android / **252/252** de regresión
  fueron ejecutados por el implementador. Los revisores no repitieron el emulador.

### Matriz de aceptación

| ID | Estado | Evidencia / límite |
|---|---|---|
| SO-01 | Parcial, incertidumbre explícita | Fases/códigos/cronología nuevos y expiración remota confirmada. El fallo histórico de `4723` no pudo root-causarse porque el servidor no estaba disponible. |
| SO-02 | Verificado en dedicado | Herramientas MCP directas, bienvenida WeHealthy identificable y snapshots sucesivos con el mismo ID; apertura final de 67,459 s. |
| SO-03 | Verificado | MCP Code Mode abre y observa WeHealthy, `done`, revalidado tras hardening. |
| SO-04 | Verificado para el intervalo probado | 65 s sin comandos ni heartbeat, timeout declarado 600 s, snapshot posterior correcto. No demuestra pausas arbitrarias. |
| SO-05 | Verificado en contratos y operación | Una petición ante creación incierta, lease retenido y rechazo de recreación en la sesión MCP anterior; pre-aborto conocido sin envío. |
| SO-06 | Verificado | Expiración estructurada, cleanup normalizado concurrente, ownership y error primario+cleanup conservados. |
| SO-07 | Verificado para las trazas añadidas | Lista segura, sin cuerpos; tests de redacción. Tramo autenticado con Appium sin archivo/stdout/stderr y valores sensibles de runtime. Un identificador no marcado sensible puede aparecer en snapshot; se usó `secret_email` para redactarlo. |
| SO-08 | Verificado | Android 43/43, regresión íntegra 252/252 sin skips. |
| SO-09 | Verificado dentro del límite autorizado | Login confirmado → Perfil/Planes → selección Pack personal → resumen $20; se detuvo antes de Mercado Pago. El plan actual seguía siendo gratuito. |
| SO-10 | Verificado en dedicado | Versiones, endpoint, target, comandos y cleanup registrados en `diagnosis.md`. |

### Hallazgos cerrados

| Hallazgo | Corrección / evidencia |
|---|---|
| Desconexión en lectura del cuerpo parecía JSON inválido | Clasificación de transporte con prueba post-headers; SyntaxError excluido del matching de red. |
| Timeline sin terminal al faltar ID y sin duración de observación | Terminal de creación/ID-extraction y trazas de primera observación correlacionadas. |
| Dos cierres expirados podían devolver éxito y error distintos | Coalescencia del cierre completo normalizado. |
| Señal ya abortada retenía ownership desconocido sin envío | Preflight conocido, cero solicitudes y sin `creationUnknown`. |
| Primera observación fallida dejaba GETs en vuelo durante DELETE | Aborto y `allSettled` antes del cleanup. |
| Señal local de snapshot ocultaba la cancelación Code Mode | Combinación de controlador local, señal de ejecución y señal explícita; tres GETs abortados y drenados en prueba. |

### Riesgos residuales y ruta

- Ruta del **slice implementado: VERIFIED → DECIDE**, con los límites anteriores.
  El diagnóstico histórico de `4723` sigue abierto y no se convierte en una causa
  confirmada por el éxito del servidor dedicado.
- El modelo devolvió `needs_login` con credenciales y eligió navegación de un
  árbol previo sin progreso; se completó con controles MCP observados. No se
  afirma autonomía completa del login ni se corrigió esa política en este slice.
- Autofill requirió cancelar una sugerencia tras un stale; `forceAppLaunch=true`
  produjo una pantalla vacía en un control WeHealthy. El target final probado
  conserva `noReset` y `appWaitActivity=*`, sin imponer forceAppLaunch.
- Lease local al proceso; ownership incierto requiere conciliación explícita.
  No se añadió descubrimiento global ni recuperación automática insegura.
- No se realizó commit, push, merge ni despliegue.
