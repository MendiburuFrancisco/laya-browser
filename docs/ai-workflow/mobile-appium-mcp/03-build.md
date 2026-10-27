# Build: MVP Android nativo por MCP y Code Mode

- Fecha: 2026-10-27
- Slices: contrato web; Android observable; navegación; MCP/Code Mode y hardening
- Base: `88841a1`
- Estado: MVP funcional validado; experimental, con refactor arquitectónico pendiente
- Autorización: instrucciones del usuario de implementar el diseño y usar el emulador disponible.

## Alcance cubierto

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

- El soporte funcional Android del MVP está conectado y probado. La extracción completa del loop web a un GoalRunner común aún no se hizo: JevBrowser conserva el loop web y AppiumAndroidDriver contiene el loop nativo. Comparten transporte de inferencia, dispatch MCP/Code Mode, políticas de autorización del host y verificación, pero no una única implementación del loop.
- PlaywrightDriver es todavía un adaptador disponible para el siguiente refactor; no sustituye el lanzamiento web existente. No se afirma completado el diseño arquitectónico integral.
- El lease coordina sesiones de un mismo proceso MCP; no impide que otro cliente Appium externo controle el dispositivo.
- No hay evidencia de inferencia Laya en dispositivo real. No se anuncia iOS/WebView/visión/vídeo nativo.
- El paralelismo por defecto de npm test puede saturar este equipo; la regresión íntegra pasó con concurrencia 2.

## Revisión sugerida

Ver `04-review.md`. Antes de considerar completo el diseño, extraer el GoalRunner común con caracterización web y revisión en contexto independiente. El MVP actual puede probarse tras reiniciar la conexión MCP para cargar sus nuevos esquemas.
