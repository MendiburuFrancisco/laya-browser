# Revisión del MVP Android

- Base: `88841a1`; revisión contra los archivos reales y las ejecuciones registradas en `03-build.md`.
- Método: dos pasadas internas consecutivas (cumplimiento y calidad); no es revisión por otro agente/persona.
- Ruta principal para el diseño completo: **CHECKS_FAIL → BUILD**, por extracción arquitectónica pendiente. El corte funcional Android sí tiene evidencia real.

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
