# Plan de cierre: GoalRunner común y revisión independiente

- Fecha: 2026-10-27
- Estado: implementado y validado el 2026-10-28; cierre en `03-build.md`, revisiones independientes en `04-review.md` y diagnóstico E2E en `diagnosis.md`.
- Referencias: [02-design.md](02-design.md), [03-build.md](03-build.md), [04-review.md](04-review.md).
- Objetivo: completar la extracción arquitectónica pendiente del MVP Android y obtener una revisión independiente.

## 1. Punto de partida

El MVP Android está integrado con MCP y Code Mode y tiene evidencia real sobre `emulator-5554`. La revisión registró:

- Suite completa: 201/201 con concurrencia 2.
- Contratos Android: 23/23.
- E2E Android reales: 2/2, incluido un objetivo Jev por MCP y Code Mode.

Estos resultados son la línea base histórica; deben volver a comprobarse al implementar este plan.

El pendiente principal es que `src/session.mjs` mantiene el loop web y `src/drivers/appium/driver.mjs` mantiene el loop nativo. `PlaywrightDriver` todavía es un adaptador y no sustituye la coordinación web existente. La revisión actual fue interna, en el contexto del implementador.

## 2. Enfoque recomendado

| Alternativa | Ventaja | Riesgo |
|---|---|---|
| **Extracción progresiva — recomendada** | Permite comprobar compatibilidad en cada corte | Necesita adaptadores temporales |
| Reescribir ambos loops de una vez | Arquitectura uniforme desde el inicio | Mayor riesgo de romper caché, diálogos, WebMCP y visión web |

Se propone la extracción progresiva. La implementación comenzará por caracterización y contrato, antes de trasladar los loops.

## 3. Arquitectura objetivo

```text
MCP / Code Mode / API pública
            │
            ▼
Sesión: routing, ownership y lease
            │
            ▼
GoalRunner común
  - observar → decidir → validar → actuar → verificar
  - presupuestos, anti-loop, autorización e historial
            │
            ├── Capa de decisiones tipadas → Jev / Laya
            │
            ▼
AutomationDriver
            ├── PlaywrightDriver
            └── AppiumAndroidDriver
```

### Responsabilidades

| Componente | Responsabilidad |
|---|---|
| Driver | Observar, publicar acciones disponibles, validar freshness, resolver y ejecutar |
| Capa de decisiones | Construir preguntas y resolver respuestas tipadas |
| GoalRunner | Coordinar el ciclo, aplicar políticas y administrar presupuestos, historial y resultados |
| Sesión/API | Compatibilidad pública, ownership, leases, routing y capability gates |

### Reglas del contrato

- `act` ejecuta una acción una sola vez; no inicia otro ciclo de políticas.
- `fresh` diferencia pantalla cambiada, target cambiado y target ausente.
- XPath, UUID Appium, coordenadas y objetos Playwright permanecen dentro del driver.
- El runner no accede a `page`, `context`, XML ni locators nativos.
- Caché, diálogos, WebMCP y visión web se conectan mediante capacidades o estrategias explícitas.
- Las capacidades no soportadas conservan errores estructurados.
- Ninguna migración habilita retries automáticos de mutaciones ni elimina verificaciones o autorizaciones existentes.

## 4. Slices de implementación

### Slice A — Fijar la línea base de comportamiento

**Trabajo**

1. Registrar rama, base y cambios preexistentes antes de editar.
2. Caracterizar ambos loops con respuestas Jev simuladas.
3. Cubrir acciones disponibles, finalización, freshness, caché, diálogos, presupuestos y errores.
4. Clasificar diferencias propias de la plataforma y duplicaciones accidentales.

**Archivos principales**

- `src/session.mjs`.
- `src/drivers/appium/driver.mjs`.
- Pruebas de page, plan, Code Mode, drivers, Android, visión y WebMCP.

**Criterio de salida**

Las diferencias relevantes se pueden detectar sin emulador ni llamadas reales al modelo. No se cambia comportamiento para hacer coincidir artificialmente las caracterizaciones.

### Slice B — Completar el contrato de drivers

**Trabajo**

1. Precisar observación, action space, freshness, ejecución y lectura de valores.
2. Separar ejecución de políticas para evitar una segunda revalidación o consumo de presupuesto ocultos dentro del adaptador.
3. Alinear `PlaywrightDriver` y `AppiumAndroidDriver` con el contrato.
4. Definir las extensiones web mediante capacidades o estrategias.

**Archivos principales**

- `src/drivers/contract.mjs`.
- `src/drivers/playwright-driver.mjs`.
- `src/drivers/appium/driver.mjs`.
- Pruebas compartidas de contrato.

**Criterio de salida**

El mismo conjunto de pruebas de contrato pasa para ambos drivers. Los detalles ejecutables de cada plataforma no aparecen en los datos públicos del runner.

### Slice C — Extraer el runner con Android como primer consumidor

**Trabajo**

1. Crear `src/goal-runner.mjs`.
2. Mover la coordinación observar → decidir → validar → actuar → verificar.
3. Centralizar presupuestos, stale sin mutación, anti-loop y autorización.
4. Centralizar historial, estados de salida y propagación de `outcome: "unknown"`.
5. Mantener lifecycle, XML, locators, foco y HTTP dentro del driver Android.

**Criterio de salida**

Android utiliza el runner común y conserva sus contratos y E2E. El driver ya no contiene un loop autónomo equivalente.

### Slice D — Migrar web al mismo runner

**Trabajo, en este orden**

1. Conectar observación y acciones DOM de `PlaywrightDriver`.
2. Migrar decisiones y estados de salida.
3. Incorporar caché y replay.
4. Incorporar diálogos y WebMCP.
5. Incorporar visión y Box.
6. Mantener `JevBrowser` y `LayaBrowser` como fachadas públicas compatibles.

**Control especial**

El replay de caché debe respetar autorización, freshness y presupuestos. No debe convertirse en un camino alternativo que omita los guards del runner.

**Criterio de salida**

Web y Android ejecutan un único loop de orquestación. No queda un segundo algoritmo equivalente en `session.mjs` o en el driver Android. Las funcionalidades web existentes conservan su comportamiento caracterizado.

### Slice E — Unificar MCP y Code Mode

**Trabajo**

1. Enrutar operaciones mediante sesión y contrato común.
2. Eliminar accesos directos a `b.page` en la API compartida y en la coordinación de planes.
3. Centralizar capability gates y verificaciones.
4. Sincronizar esquemas Zod, `CODE_API_TYPES` y herramientas MCP.
5. Retirar adaptadores temporales cuando todos sus consumidores estén migrados.

**Archivos principales**

- `src/browser-api.mjs`.
- `src/browser-sessions.mjs`.
- `src/plan.mjs`.
- `bin/laya-browser-mcp.mjs`.
- `src/index.mjs`.

**Criterio de salida**

Las herramientas directas y Code Mode aplican las mismas reglas y producen errores equivalentes. Las exportaciones y contratos públicos existentes siguen disponibles.

### Slice F — Validación final y revisión independiente

**Trabajo**

1. Ejecutar la regresión completa y los contratos de ambos drivers.
2. Ejecutar los E2E Android sobre un emulador dedicado con cleanup propio.
3. Realizar una revisión de cumplimiento y otra de calidad en contextos independientes del implementador.
4. Resolver hallazgos bloqueantes y volver a ejecutar las verificaciones afectadas.
5. Actualizar `03-build.md` y `04-review.md` con resultados y evidencia reproducible.

**Criterio de salida**

No quedan hallazgos bloqueantes, la arquitectura se contrasta contra el diseño y la revisión distingue evidencia simulada de evidencia real.

## 5. Matriz de aceptación

| ID | Criterio | Prueba / evidencia |
|---|---|---|
| GR-01 | Web y Android usan el mismo loop | Inspección de consumidores de GoalRunner y pruebas de ambos drivers |
| GR-02 | El runner no conoce detalles Playwright/Appium | Revisión de imports, dependencias y contrato; drivers falsos en pruebas unitarias |
| GR-03 | Se preserva el comportamiento web | Caracterización, suite web, caché, diálogos, WebMCP, visión y Box |
| GR-04 | Stale no muta ni gasta presupuesto de acción | Pruebas de contrato con cambio de pantalla/target y contador de mutaciones |
| GR-05 | Una respuesta perdida no duplica acciones | Fallos HTTP simulados, petición única y outcome desconocido |
| GR-06 | La autorización exige el objetivo exacto | Pruebas del host y runner, incluidas rutas de caché web |
| GR-07 | Cancelación y presupuestos detienen la ejecución | Pruebas de Code Mode, inferencia, acción y cleanup |
| GR-08 | Los secretos no aparecen en estado ni diagnósticos | Pruebas de observaciones, historial y errores; valores numéricos cortos incluidos |
| GR-09 | Un fallo o falso done detiene el plan | Pruebas de run/do con postcondiciones y pasos dependientes no ejecutados |
| GR-10 | MCP y Code Mode comparten guards y errores | Pruebas de contrato de ambas superficies y capability gates |
| GR-11 | Android sigue funcionando en entorno real | E2E Settings con navegación directa y Jev por MCP Code Mode |
| GR-12 | Existe revisión independiente verificable | Informes de cumplimiento/calidad y resolución de hallazgos |

## 6. Comandos de verificación

Regresión local con concurrencia acotada:

```powershell
node --test --test-concurrency=2 test/*.test.mjs
npm run test:android
```

E2E opt-in, con Appium y el emulador dedicado activos:

```powershell
$env:JEV_ANDROID_E2E="1"
$env:JEV_ANDROID_JEV_E2E="1"
$env:ANDROID_UDID="emulator-5554"
npm run test:e2e:android
```

Las pruebas nuevas ampliarán el conteo histórico de 201. Cada corte debe registrar comandos ejecutados, resultados, pruebas omitidas y sus motivos. No se relajarán assertions ni timeouts para ocultar regresiones.

## 7. Riesgos y rollback

| Riesgo | Mitigación |
|---|---|
| Cambio accidental de semántica al unificar loops | Caracterización previa y migración por slices |
| Caché o extensiones web omiten políticas comunes | Pruebas específicas de replay y autorización |
| Doble freshness o doble consumo de presupuesto | Responsabilidades explícitas entre runner y driver |
| Una excepción provoca repetición de una mutación | Ejecución única, outcome desconocido y detención de pasos dependientes |
| Contención temporal de Chromium | Regresión con concurrencia 2, conservando las assertions |
| Dos implementaciones quedan activas indefinidamente | Retirar el loop anterior al completar cada migración; no ejecutar mutaciones en modo sombra |

Cada slice debe ser revisable y reversible mediante un diff acotado. Antes de empezar se fijará una base recuperable que incluya el MVP actual, respetando los cambios preexistentes. No se harán resets destructivos, publicaciones ni modificaciones de configuración del usuario como parte del rollback.

## 8. Definición de terminado

- Un solo GoalRunner utilizado por web y Android.
- Runner sin acceso a detalles internos de Playwright o Appium.
- Funcionalidades web preservadas y fachadas públicas compatibles.
- Contratos y E2E Android verdes.
- MCP y Code Mode con las mismas políticas y verificaciones.
- Hallazgos bloqueantes de la revisión independiente resueltos.
- Documentación de Build y Review actualizada con evidencia real.

**Primer corte a implementar:** slices A y B — caracterización y contrato — antes de trasladar los loops.

## 9. Resultado de ejecución — 2026-10-28

- Slices A–F completados sobre base `bef6467`, respetando el plan preexistente sin seguimiento.
- Web y Android consumen el mismo `GoalRunner`; se retiraron los loops anteriores de sus fachadas.
- Regresión final **231/231**, contratos Android **24/24**, E2E Android real **2/2** con Appium dedicado `4725`.
- Dos revisiones independientes, correcciones con pruebas de regresión y revalidaciones sin bloqueantes pendientes.
- El fallo inicial de creación E2E en `4723` y su diagnóstico inconcluso permanecen documentados.
