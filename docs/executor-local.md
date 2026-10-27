# Executor local de pruebas

Servicio local para el backend: ejecuta suites cerradas de Playwright dentro de Docker y expone estado, logs, resultados y evidencias mediante HTTP. No incluye frontend.

## Requisitos e inicio

- Docker Engine y Docker Compose plugin.
- Node.js 20+ sólo si se ejecuta el cliente MCP fuera de Docker.
- Token API de al menos 24 caracteres.

En Bash:

```bash
export EXECUTOR_API_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
docker compose -f compose.executor.yml build
docker compose -f compose.executor.yml up -d
docker compose -f compose.executor.yml ps
```

En PowerShell:

```powershell
$env:EXECUTOR_API_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
docker compose -f compose.executor.yml build
docker compose -f compose.executor.yml up -d
docker compose -f compose.executor.yml ps
```

El puerto del host es `127.0.0.1:8787`; se puede cambiar con `EXECUTOR_PORT`. `GET /healthz` es público y mínimo; `GET /readyz` informa disponibilidad sin datos sensibles.

## API para backend

Todas las rutas `/v1` requieren `Authorization: Bearer $EXECUTOR_API_TOKEN`. El cliente elige suites autorizadas y proporciona un `Idempotency-Key` por petición lógica.

```bash
curl -s http://127.0.0.1:8787/v1/suites \
  -H "Authorization: Bearer $EXECUTOR_API_TOKEN"

curl -s -X POST http://127.0.0.1:8787/v1/runs \
  -H "Authorization: Bearer $EXECUTOR_API_TOKEN" \
  -H "Idempotency-Key: backend-demo-form-0001" \
  -H "Content-Type: application/json" \
  -d '{"suiteId":"demo-form"}'
```

La respuesta inicial es `202 Accepted` con `runId` y enlaces:

```bash
curl -s "http://127.0.0.1:8787/v1/runs/<runId>" -H "Authorization: Bearer $EXECUTOR_API_TOKEN"
curl -s "http://127.0.0.1:8787/v1/runs/<runId>/logs?after=0&limit=100" -H "Authorization: Bearer $EXECUTOR_API_TOKEN"
curl -s "http://127.0.0.1:8787/v1/runs/<runId>/results" -H "Authorization: Bearer $EXECUTOR_API_TOKEN"
curl -L "http://127.0.0.1:8787/v1/runs/<runId>/artifacts/<artifactId>" -H "Authorization: Bearer $EXECUTOR_API_TOKEN" -o evidence.webm
```

`results` responde `202` si aún no está listo. Logs usan cursores numéricos, con tamaño máximo 200 por consulta. Desde otro servicio Compose en una red compartida, usar `http://executor:8787`. No enviar el token a un navegador ni registrarlo en logs del backend.

### Suites iniciales

| ID | Resultado esperado |
|---|---|
| `demo-form` | Pasa: completa y verifica el email en una fixture local. |
| `demo-controls` | Pasa: verifica checkbox y selección. |
| `demo-failure` | Falla intencionalmente una comprobación. |

El `JevBrowser` de este repositorio y Chromium ejecutan un DOM local. El runner habla con un endpoint de decisiones determinista incluido sólo para la demo; no se necesitan claves de IA. El resultado declara `decisionBackend: "fixture"`: esto valida el framework, navegador, cola, API y reporte, pero no es una evaluación de calidad de Jev/Laya.

## MCP opcional

El backend puede invocar HTTP directamente. Para ofrecer una interfaz MCP limitada a un agente confiable:

```bash
EXECUTOR_API_URL=http://127.0.0.1:8787 EXECUTOR_API_TOKEN="$EXECUTOR_API_TOKEN" npm run executor:mcp
```

Sólo registra `tests_run`, `tests_logs` y `tests_results`. No registra el MCP general `laya-browser`, no acepta shell/código ni URLs y no tiene acceso al volumen Docker.

## Persistencia y configuración

El volumen `executor-data` guarda un directorio por run: metadatos, `logs.ndjson`, `result.json` y artefactos. Retención por defecto: 24 horas (`EXECUTOR_RETENTION_HOURS`). La misma clave idempotente y el mismo payload retornan el run original; usarla con otro payload produce `409`. El servicio soporta una instancia por volumen. Tras reinicio, runs `running` se marcan `interrupted`; los queued se recuperan; no se repite automáticamente un run que ya comenzó.

| Variable | Default | Uso |
|---|---:|---|
| `EXECUTOR_API_TOKEN` | requerido | Bearer token; mínimo 24 caracteres. |
| `EXECUTOR_PORT` | `8787` | Puerto host, publicado en loopback. |
| `EXECUTOR_MAX_QUEUED` | `10` | Máximo de ejecuciones en espera, adicional a la activa. |
| `EXECUTOR_RUN_TIMEOUT_MS` | `120000` | Timeout por suite. |
| `EXECUTOR_SHUTDOWN_GRACE_MS` | `10000` | Espera de apagado de procesos. |
| `EXECUTOR_MAX_BODY_BYTES` | `16384` | Tamaño máximo del JSON. |
| `EXECUTOR_MAX_LOG_BYTES` | `5242880` | Límite de logs por ejecución. |
| `EXECUTOR_MAX_ARTIFACT_BYTES` | `52428800` | Tamaño máximo admitido por evidencia. |
| `EXECUTOR_RETENTION_HOURS` | `24` | Retención de runs terminales. |

## Controles de seguridad

- El agente habla con la API por HTTP y no requiere Docker ni el socket Docker.
- El executor no controla el daemon ni crea contenedores; lanza procesos Node fijos dentro de su contenedor.
- El puerto sólo se publica en `127.0.0.1`; el contenedor es no-root, `read_only`, `init`, `no-new-privileges`, sin capabilities y con límites de CPU/memoria/PIDs.
- Schemas estrictos, catálogo cerrado, body limitado, cola acotada, comparación constante del token y nombres seguros para artefactos.
- No se escriben headers de autorización en logs. Usar datos sintéticos: videos y snapshots pueden mostrar información de página.
- Mantener token en secretos del backend; no incorporarlo al código ni a la imagen.
- El runner comparte kernel y filesystem del contenedor. Sólo es adecuado para suites confiables incluidas en la imagen, no código de usuario hostil.
- No exponer directamente a Internet sin identidad, TLS, controles de abuso y gestión de secretos adecuados.

## Validación

```bash
npm test
docker compose -f compose.executor.yml build
docker compose -f compose.executor.yml up -d
```

Lanzar las tres suites por HTTP: `demo-form` y `demo-controls` terminan `passed`; `demo-failure` termina `failed`. Revisar logs con `docker compose -f compose.executor.yml logs executor`.

Al cambiar Playwright, actualizar lockfile y reconstruir: Chromium se instala desde la versión del paquete resuelta por `package-lock.json`.
