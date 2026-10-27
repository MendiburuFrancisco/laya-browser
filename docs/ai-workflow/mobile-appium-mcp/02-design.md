# Diseño propuesto: MCP móvil con Appium para Laya Browser

- Fecha: 2026-10-27
- Rama: `feature/mobile-appium-mcp`
- Base local: `88841a1` (`Add sessions, vision, network, and test executor`)
- Estado: propuesta para revisión; no aprobada para Build
- Decisión humana: pendiente
- Publicación remota: no realizada

## 1. Objetivo

Extender el MCP actual para que Jev pueda navegar aplicaciones móviles mediante el mismo modelo de trabajo usado en web:

```text
objetivo → observar → decidir una acción grounded → revalidar → ejecutar → verificar
```

El primer corte vertical debe permitir, sobre Android nativo:

1. Crear una sesión Appium UiAutomator2.
2. Abrir una aplicación.
3. Observar su árbol de accesibilidad.
4. Pedir a Jev una acción y un target observado.
5. Ejecutar tap, escritura, clear, scroll, back y wait.
6. Verificar el resultado mediante MCP y Code Mode.
7. Cerrar solamente los recursos pertenecientes a la sesión.

La arquitectura web actual debe seguir funcionando sin cambios de comportamiento ni obligación de instalar Appium.

## 2. Evidencia y alcance de la investigación

### Repositorios analizados

- `vankhangfet/jev-automation-testing`, commit `6700b460208bea474d173ec28fb2af88a1a70ec1`.
  - Android mediante UiAutomator2.
  - Flujos YAML deterministas.
  - Jev se utiliza para evaluar pantallas, no para elegir la navegación.
  - Licencia MIT.
- `aldouus/jevium`, commit `7ca22c4f5798498de4358d75a7ebc9a021ecd207`.
  - iOS mediante XCUITest.
  - Navegación autónoma con `Observe`, `Fresh`, `Act` y `Close`.
  - Action space basado en elementos observados.
  - Revalidación de estado, protección contra acciones stale y ausencia de retries en mutaciones.
  - No se encontró licencia; se reimplementarán conceptos, sin copiar código literal.

### Arquitectura local relevante

- Loop de navegación y políticas: `src/session.mjs`.
- Transporte System One: `src/jev.mjs`.
- API compartida MCP/Code Mode: `src/browser-api.mjs`.
- Sesiones y aislamiento: `src/browser-sessions.mjs` y `src/code-mode.mjs`.
- Verificaciones: `src/plan.mjs`.
- Entrada MCP: `bin/laya-browser-mcp.mjs`.

### No verificado todavía

- No se ejecutó Appium contra un emulador o dispositivo.
- No se midió la calidad de Jev con árboles Android reales.
- No se validó Safari, WebView, iOS, OCR ni coordenadas visuales nativas.
- No se comparó mediante pruebas un cliente Appium HTTP propio con WebdriverIO.

## 3. Alternativas

| Criterio | A. Driver Appium integrado, recomendado | B. Adaptar el CLI de Jevium | C. Portar los flujos YAML de jev-automation-testing |
|---|---|---|---|
| Navegación autónoma con Jev | Sí | Sí | No |
| Reutiliza MCP, Code Mode y sesiones | Sí | Parcialmente, mediante procesos y traducción | Parcialmente |
| Compatibilidad web | Alta | Media | Alta |
| Android inicial | Sí | Requiere implementar otro backend | Sí, pero sin agente |
| Seguridad y freshness | Integradas en el loop | Duplicadas o adaptadas | Insuficientes |
| Mantenibilidad | Una arquitectura común | Dos agentes y dos modelos de estado | Dos formas de ejecución |
| Complejidad inicial | Media/alta | Media | Baja |
| Riesgo de regresión web | Controlable con contratos y flags | Bajo en web, alto en integración | Bajo |
| Licencia | Reimplementación limpia | Sin licencia identificada | MIT |
| Recomendación | **Sí** | No para el MCP principal | Solo para una futura auditoría QA |

### Enfoque recomendado

Adoptar la opción A con separación progresiva, no una reescritura completa:

1. Definir un contrato de driver para las operaciones que necesita el loop.
2. Extraer ese loop detrás del contrato conservando Playwright como implementación existente.
3. Añadir Appium como una segunda implementación.
4. Exponer capacidades para que herramientas DOM-only no se invoquen sobre apps nativas.

La elección final y el inicio de Build quedan pendientes de aprobación humana.

## 4. Alcance y no objetivos

### MVP: Android nativo

- Appium Server y UiAutomator2.
- Emulador o dispositivo Android explícitamente configurado.
- Aplicaciones nativas.
- Árbol XML de accesibilidad como observación principal.
- Acciones `click` —tap semántico—, `type`, `clear`, `scroll`, `back` y `wait`.
- Jev elige únicamente acciones y elementos publicados por el driver.
- Freshness antes de mutar.
- Verificación de texto, aplicación, activity y estados de elementos.
- Sesiones MCP y Code Mode con lease por dispositivo.

### Fuera del MVP

- iOS/XCUITest; requerirá macOS, Xcode y WebDriverAgent.
- Mobile web emulado con Playwright; es un trabajo independiente y más pequeño.
- DOM dentro de Safari, Chrome móvil o WebView.
- OCR, Jev Box y acciones por coordenadas.
- Gestos avanzados, sliders, pickers, pinch y drag.
- Granjas de dispositivos y ejecución paralela sobre un mismo dispositivo.
- Red, descargas, WebMCP, HTML y vídeo nativo.
- Auditoría visual y reglas de `jev-automation-testing`.
- Copia de código de Jevium sin una licencia explícita.

## 5. Arquitectura propuesta

```text
MCP tools / Code Mode
          │
          ▼
API estructurada + capability gates
          │
          ▼
Session registry + lease por sesión/dispositivo
          │
          ▼
GoalRunner
  - decide / resolve
  - done / blocked / error / stuck
  - presupuestos y anti-loop
  - irreversibilidad y secretos
  - historial y verificación
          │
          ▼
AutomationDriver
  - open / settle / snapshot
  - fresh / act / readValue
  - capabilities / close
          │
          ├─ PlaywrightDriver → Chromium web
          │
          └─ AppiumDriver
                    ├─ Appium HTTP client
                    ├─ Android snapshot parser
                    ├─ Native action resolver
                    └─ UiAutomator2
```

### Regla de dependencia

`GoalRunner`, MCP y Code Mode no deben acceder directamente a `page`, `context`, `Page.locator`, XML, coordenadas Appium o identificadores internos de elementos. Esos detalles pertenecen al driver.

## 6. Contratos

### 6.1 Driver común

Contrato conceptual; los nombres definitivos se fijarán durante Build:

```js
{
  open(target),
  settle(options),
  snapshot(options),
  fresh(snapshot, action),
  act(action),
  readValue(element),
  capabilities(),
  close()
}
```

Opcionales por capacidad:

```js
{
  captureVision(),
  getHtml(),
  listTabs(),
  listNetworkRequests(),
  downloads(),
  videos()
}
```

`fresh` devuelve un resultado tipado, no un booleano ambiguo:

```js
{ fresh: true }
{ fresh: false, reason: "page_changed" | "target_changed" | "target_missing" }
```

Una acción stale no se ejecuta ni consume un reintento de mutación; el loop vuelve a observar y decidir.

### 6.2 Modelo de observación común

Se conservarán los campos que el loop ya entiende y se añadirán metadatos nativos sin obligar a reescribir el render web:

```json
{
  "platform": "android",
  "url": "app://com.android.settings/.Settings",
  "title": "Settings",
  "text": "Texto visible redactado",
  "elements": [],
  "metrics": {},
  "fingerprint": "sha256-del-estado-semantico",
  "activity": ".Settings",
  "package": "com.android.settings"
}
```

En nativo, `url` es una ubicación sintética para mantener compatibilidad; no representa una página web ni habilita verificaciones web.

Elemento nativo:

```json
{
  "i": 1,
  "tag": "android.widget.TextView",
  "role": "text",
  "label": "About phone",
  "text": "About phone",
  "value": null,
  "enabled": true,
  "checked": null,
  "selected": null,
  "clickable": true,
  "bounds": { "x": 0, "y": 120, "width": 1080, "height": 180 },
  "actions": ["click"]
}
```

El identificador `i` solo es válido para la observación mostrada. El modelo nunca recibe XPath, UUID Appium ni coordenadas como instrucciones ejecutables.

### 6.3 Action space

El driver publica las acciones realmente soportadas por cada elemento:

```text
page.elements[].actions → preguntas operation/target → acción interna del driver
```

MVP:

| Acción común | Implementación Android |
|---|---|
| `click` | Tap sobre el elemento observado o su centro validado |
| `type` | Focus, comprobación del campo activo y entrada de texto |
| `clear` | Focus, comprobación y clear |
| `scroll` | Swipe dentro del contenedor observado |
| `back` | Android Back, sin target |
| `wait` | Espera acotada y nueva observación |
| `none` | Sin acción; usado por done/blocked/stuck |

La política de irreversibilidad existente se aplica antes de `act`. Las acciones nuevas deben clasificarse explícitamente como seguras o guarded; no se hereda una clasificación permisiva por defecto.

### 6.4 Capacidades

Cada sesión expone un conjunto inmutable de capacidades:

```json
{
  "driver": "appium",
  "platform": "android",
  "native": true,
  "dom": false,
  "tabs": false,
  "network": false,
  "downloads": false,
  "video": false,
  "vision": false
}
```

Las llamadas incompatibles devuelven un error estructurado `unsupported_capability`, sin provocar un fallo accidental por ausencia de `b.page`.

## 7. Flujo móvil detallado

### 7.1 Apertura

1. `browser_create_session` recibe un target opcional; si se omite, se crea una sesión web como hasta ahora.
2. El target `android` guarda Appium URL, capabilities y ownership.
3. `browser_open` activa la aplicación indicada.
4. El driver valida plataforma, automation name, servidor y dispositivo antes de crear recursos.
5. La sesión queda asociada al dispositivo y al lease; no puede cambiar de driver posteriormente.

Ejemplo conceptual:

```json
{
  "session_id": "android-settings",
  "target": {
    "kind": "android",
    "appium_url": "http://127.0.0.1:4723",
    "capabilities": {
      "platformName": "Android",
      "appium:automationName": "UiAutomator2",
      "appium:udid": "emulator-5554",
      "appium:noReset": true
    }
  }
}
```

```json
{
  "app": {
    "package": "com.android.settings",
    "activity": ".Settings"
  }
}
```

### 7.2 Observación y settling

1. Leer `page_source`, paquete/activity y métricas de ventana.
2. Normalizar XML al modelo común.
3. Excluir elementos invisibles, deshabilitados para la acción correspondiente o fuera de pantalla.
4. Recortar bounds contra su ventana y conservar contenedores scrollables.
5. Redactar valores sensibles antes de crear texto, historial o fingerprints.
6. Esperar estabilidad semántica con polling acotado; no usar únicamente sleeps fijos.
7. Limitar texto y número de elementos, informando cualquier truncamiento.

La observación inicial no necesita screenshot. Esto evita filtraciones visuales y problemas DPR durante el MVP.

### 7.3 Decisión

1. Reutilizar `src/jev.mjs` y las preguntas comunes de done/blocked/error/login/irreversible.
2. Construir las operaciones desde `elements[].actions`, no desde una lista web global.
3. Enviar una pregunta de operación y preguntas target por operación cuando sea viable.
4. Validar que la opción elegida exista y que el target sea compatible con la acción.
5. Mantener `minTarget`, presupuestos, anti-loop y política de secretos actuales.

Jev no genera texto libre para selectores, gestos, XML, coordenadas o código.

### 7.4 Freshness y ejecución

1. Volver a observar antes de ejecutar.
2. Comparar fingerprint semántico de pantalla.
3. Comprobar que el target conserva acción, rol, identidad textual y bounds.
4. Si cambió, devolver stale y reobservar sin actuar.
5. Si sigue fresco, resolver el elemento nativo actual y ejecutar una sola vez.
6. Para escritura, verificar foco antes y después de clear cuando corresponda.
7. Reobservar y verificar el resultado.

### 7.5 Errores y reintentos

- GET de solo lectura: como máximo un retry con backoff corto.
- POST o comandos de mutación: nunca se repiten automáticamente.
- Respuesta perdida tras una mutación: `status: "error"`, `outcome: "unknown"` y fase `mobile_action`.
- Stale: no es un fallo de dispositivo; fuerza una nueva observación.
- Sesión inválida o dispositivo desconectado: diagnóstico específico; no recrear ni repetir acciones implícitamente.
- Una acción fallida impide continuar automáticamente los pasos dependientes del plan.

## 8. Superficie MCP y Code Mode

### Conservar

- `browser_create_session`, `browser_list_sessions`.
- `browser_open`, `browser_do`, `browser_run`.
- `browser_snapshot`, `browser_check`, `browser_choose`, `browser_act`.
- `browser_screenshot` solo cuando exista la capacidad.
- `browser_close`.
- `browser_execute` y el recurso `browser://code-mode/api`.

### Extender

- `browser_create_session`: target opcional `web | android`; web sigue siendo el default.
- `browser.open({ url })`: comportamiento actual.
- `browser.open({ app })`: apertura nativa.
- `browser.run`: acepta `url` o `app`, nunca ambos.
- `verify`: añade condiciones nativas sin incluir secretos en la respuesta.

Verificación nativa propuesta:

```json
{
  "text_includes": "About phone",
  "app_package": "com.android.settings",
  "activity_includes": "Settings",
  "element": {
    "label": "About phone",
    "state": "enabled"
  }
}
```

### Restringir por capacidad

En una sesión nativa del MVP, las siguientes operaciones devuelven `unsupported_capability`:

- `getHtml`, tabs, WebMCP y lectura DOM.
- Red y descargas Playwright.
- Vídeo Playwright.
- Box/visión hasta que exista un modelo de coordenadas nativo.

### Contratos a mantener sincronizados

1. Esquemas Zod de `src/browser-api.mjs`.
2. Declaraciones `CODE_API_TYPES`.
3. Herramientas directas de `bin/laya-browser-mcp.mjs`.
4. Documentación MCP y `.env.example`.

## 9. Archivos previstos

### Refactor controlado

- `src/session.mjs`: separar progresivamente GoalRunner del driver Playwright.
- `src/browser-api.mjs`: targets, capabilities, verificaciones y eliminación de accesos directos a `b.page`.
- `src/plan.mjs`: verificaciones mediante driver.
- `src/browser-sessions.mjs`: target, dispositivo, capabilities y ownership.
- `bin/laya-browser-mcp.mjs`: factory y registro según capacidades.
- `src/index.mjs`: exportaciones nuevas sin romper `JevBrowser`/`LayaBrowser`.

### Módulos nuevos sugeridos

```text
src/drivers/
  contract.mjs
  playwright-driver.mjs
  appium/
    driver.mjs
    client.mjs
    errors.mjs
    android-snapshot.mjs
    android-actions.mjs
src/target-config.mjs
```

No se crearán abstracciones iOS vacías durante el MVP. El contrato debe quedar preparado para ellas, pero el soporte solo se anunciará cuando exista una implementación probada.

### Configuración y documentación

- `.env.example`: Appium URL, UDID y flag de activación, sin secretos.
- `MCP-LAYA.md` y `README.md`: setup Android, capacidades y limitaciones.
- `docs/ai-workflow/mobile-appium-mcp/`: diseño y evidencias de slices.

## 10. Plan de slices verticales

### Slice 0 — Contrato y caracterización web

- Añadir tests de caracterización para snapshot, do/run, verify, close y herramientas DOM.
- Definir capabilities y target default web.
- Extraer el contrato mínimo sin cambiar comportamiento.
- Criterio de salida: toda la suite web conserva su comportamiento y no existe configuración Appium activa por defecto.

### Slice 1 — Android observable

- Cliente Appium de solo lectura y ciclo de vida de sesión.
- Crear/reutilizar/cerrar sesión con ownership explícito.
- Parser XML → modelo común, redacción, clipping, fingerprint y truncamiento.
- `browser_open({ app })` y `browser_snapshot` sobre una app Android.
- Evidencia: snapshot real de Android Settings y pruebas con XML/mocks.

### Slice 2 — Primer objetivo navegable

- Action space nativo.
- `click` y `type` con freshness y foco.
- Integración con GoalRunner y `browser_do`.
- Sin retries de mutaciones.
- Corte vertical: “abrir About phone en Android Settings” ejecutado por Jev y verificado.

### Slice 3 — Acciones y verificación MCP/Code Mode

- `clear`, `scroll`, `back`, `wait`.
- Verificación de app/activity/texto/elemento.
- `browser_run`, `browser_act` y `browser_execute` con los mismos contratos.
- Capability gates para herramientas no soportadas.
- Evidencia: recorrido con scroll, back y postcondiciones desde Code Mode.

### Slice 4 — Hardening y release candidate

- Secretos, logs y artefactos redactados.
- Timeouts, cancelación, desconexión, WDA/Appium no disponible y outcome desconocido.
- Anti-loop y pruebas de no duplicación.
- E2E opt-in en emulador limpio.
- Documentación, diagnósticos y rollback.
- Revisión independiente antes de habilitar mobile por defecto.

## 11. Matriz de aceptación y pruebas

| ID | Criterio de aceptación | Test seam | Evidencia esperada |
|---|---|---|---|
| AC-01 | Una sesión sin target sigue usando Playwright | Unitarias + suite actual | Sin regresiones web |
| AC-02 | El target Android crea y cierra solo su sesión | Contrato HTTP + E2E | Session ID propio y DELETE único al cerrar |
| AC-03 | El snapshot contiene solo elementos utilizables y redactados | Fixtures XML | Índices, roles, bounds, estados y truncamiento correctos |
| AC-04 | Jev solo puede elegir acciones/targets observados | Unitarias de action space | Un target inventado se rechaza antes de Appium |
| AC-05 | Click y type actúan sobre el elemento actual | Mock Appium + E2E | Acción única y campo con foco verificado |
| AC-06 | Un cambio de pantalla invalida la decisión | Contrato freshness | Cero mutaciones y nueva observación |
| AC-07 | Un POST con respuesta perdida no se repite | Fallos HTTP simulados | Una sola llamada y `outcome: unknown` |
| AC-08 | Scroll, back y wait producen una nueva observación | Contrato + E2E | Historial y fingerprint posterior coherentes |
| AC-09 | Una acción irreversible requiere autorización exacta | Unitarias + MCP | `needs_confirmation`; sin mutación previa |
| AC-10 | `do/run` no depende de DONE sin postcondiciones | Plan + Code Mode | `verification_failed` cuando corresponda |
| AC-11 | Herramientas DOM-only fallan de forma explícita | MCP contract | `unsupported_capability`, no TypeError |
| AC-12 | Secretos no aparecen en estado, logs ni artefactos | Unitarias y revisión de salida | Solo claves/redacción; nunca valores |
| AC-13 | Un dispositivo no admite operaciones concurrentes | Sesiones/lease | Segunda operación espera o se rechaza claramente |
| AC-14 | Un fallo de acción detiene los pasos dependientes | Plan | Pasos restantes no ejecutados |
| AC-15 | El objetivo Android funciona en un entorno real | E2E opt-in | Evidencia en Android Settings, snapshot y resultado |

## 12. Estrategia de pruebas

### Por defecto, sin dispositivo ni APIs externas

- Fixtures Android XML propios.
- Servidor Appium HTTP simulado.
- Respuestas Jev simuladas mediante el seam `ask` existente.
- Contratos MCP y Code Mode.
- Cancelación, timeout, stale, secretos y no-duplicación.
- Suite web completa como regresión.

### E2E opt-in

Variables separadas, por ejemplo:

```text
JEV_ANDROID_E2E=1
APPIUM_URL=http://127.0.0.1:4723
ANDROID_UDID=emulator-5554
```

Condiciones:

- Emulador dedicado, nunca un teléfono personal por defecto.
- Android Settings como fixture inicial, sin cambiar ajustes del dispositivo.
- Una sesión por dispositivo.
- Sin compras, permisos, borrados ni cambios persistentes.
- Cleanup de sesión propia incluso tras fallos.
- Screenshots solo cuando el caso los necesite y sin datos sensibles.

## 13. Flags, despliegue y rollback

- `JEV_MOBILE_ENABLED=0` por defecto durante los slices.
- Las herramientas móviles solo se activan mediante target explícito o flag de desarrollo.
- Appium es opcional; una instalación web no debe requerir servidor Android.
- Cada slice se fusiona con tests web verdes y pruebas móviles de contrato.
- Rollback inmediato: desactivar mobile; Playwright y el MCP actual permanecen intactos.
- No se anuncia soporte iOS, WebView o visión hasta disponer de implementación y evidencia propias.

## 14. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Regresión al extraer GoalRunner | Caracterización previa y slices pequeños |
| Acciones duplicadas por timeout | Prohibir retries de mutaciones y reportar outcome desconocido |
| Elemento cambia entre decisión y tap | Fingerprint + identidad + bounds + resolución actual |
| Árboles Android grandes o ruidosos | Límites, filtrado, agrupación y truncamiento explícito |
| Mala accesibilidad | Reportar blocked/unsupported; no inventar coordenadas |
| Filtración de secretos | Redacción antes de Jev, fingerprints, logs e historial |
| Herramientas web llamadas en nativo | Capability gates centralizados |
| Sesiones concurrentes sobre un dispositivo | Lease y ownership por sesión |
| Dependencia de código sin licencia | Reimplementación limpia de conceptos |
| Tests inestables por tiempos | Polling semántico acotado, mocks deterministas y E2E aislado |

## 15. Decisiones necesarias antes de Build

1. Aprobar la opción A: driver Appium integrado.
2. Confirmar Android nativo como primer target.
3. Elegir el transporte Appium:
   - Recomendación inicial: cliente HTTP interno pequeño para controlar retries, errores y ownership.
   - Alternativa: WebdriverIO detrás del mismo contrato si el prototipo demuestra mayor mantenibilidad.
4. Confirmar que OCR, Box, WebView e iOS quedan fuera del MVP.
5. Designar un emulador Android de prueba y una aplicación fixture segura.

## 16. Definición de listo del MVP

El MCP móvil se considerará listo para revisión cuando:

- El recorrido Android del corte vertical funcione con Jev y verificación independiente.
- Las decisiones stale nunca produzcan una mutación.
- Ninguna mutación se repita automáticamente.
- MCP y Code Mode compartan los mismos contratos y guards.
- Las herramientas incompatibles devuelvan errores explícitos.
- La suite web no presente regresiones atribuibles al cambio.
- Las pruebas unitarias/contrato sean deterministas y el E2E real sea reproducible.
- La documentación indique claramente plataforma, setup, límites y rollback.
