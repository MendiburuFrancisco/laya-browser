# Laya en AMD ROCm: instalación verificada

Se verificó este proyecto con una **AMD Radeon RX 6600 (gfx1032, 8 GB)** en
Ubuntu 22.04.5, Python 3.11 y el driver `amdgpu`.

## Entorno instalado

- Entorno virtual: `.venv-rocm/`.
- PyTorch: `2.16.0a0+rocm10.2.0a20261010`.
- Paquete de kernels: `amd-torch-device-gfx1032`.
- Laya: `0.4.2`.
- Paquetes de GPU procedentes del índice nightly de AMD TheRock.

La instalación se realizó en este orden:

```bash
.venv/bin/python -m venv .venv-rocm
.venv-rocm/bin/python -m pip install --upgrade pip
.venv-rocm/bin/python -m pip install --pre \
  --index-url https://nightly.repo.amd.com/rocm/whl-next/ \
  "torch[device-gfx1032]"
.venv-rocm/bin/python -m pip install -r local/requirements.txt
```

Los paquetes nightly pueden cambiar: las versiones anteriores son las verificadas
en esta instalación, no una garantía para cualquier versión futura.

## Iniciar el servidor

El usuario debe tener acceso a `/dev/kfd` y `/dev/dri/renderD128` mediante los
grupos `render` y `video`. Si los grupos ya se aplicaron al iniciar sesión:

```bash
.venv-rocm/bin/python local/laya_server.py --device cuda
```

Si la terminal aún conserva los grupos anteriores, se verificó este comando:

```bash
sg render -c '.venv-rocm/bin/python local/laya_server.py --device cuda'
```

PyTorch denomina `cuda` a esta interfaz también cuando usa **AMD ROCm**. El
servidor no debe estar ya iniciado en el mismo puerto.

## Confirmar el uso real de GPU

```bash
curl http://127.0.0.1:8791/health
```

El servidor informa los dispositivos reales de ambos modelos, no solo el argumento
de lanzamiento. En la instalación verificada se obtuvo:

```json
{
  "device": "cuda:0",
  "checks_device": "cuda:0",
  "accelerator": "rocm",
  "gpu_name": "AMD Radeon RX 6600",
  "gpu_allocated_mb": 2854.6
}
```

Ahora una solicitud de GPU sin acceso a ella produce un error explícito, en lugar
de continuar silenciosamente en CPU.

## Ejecutar y visualizar los ejemplos

Con el servidor activo:

```bash
npm run examples:laya
```

Para medir tres repeticiones de los cinco ejemplos:

```bash
node bench/compare-backends.mjs --backend laya --repetitions 3 \
  --out bench/results/laya-rocm-gpu
```

## Resultado de la verificación del 10 de octubre de 2026

Se ejecutaron 15 tareas y 33 consultas medidas, además de un calentamiento:

| Métrica | Laya en AMD GPU |
|---|---:|
| Latencia media por consulta | 951,30 ms |
| Mediana | 901,28 ms |
| P95 | 1.183,91 ms |
| Tiempo acumulado de las tareas | 40,11 s |
| Objetivos logrados y confirmados | 9/15 |
| Errores HTTP de inferencia | 0 |

La prueba anterior en CPU promedió 2.715,35 ms por consulta. La GPU redujo esa
latencia aproximadamente **2,85 veces**. Son ejecuciones separadas, con diferentes
compilaciones de PyTorch. Los fallos de confirmación en `checkbox` y `search`
persisten: acelerar la inferencia no corrige las decisiones del modelo.

Los resultados detallados de esta ejecución están en
`bench/results/laya-rocm-gpu.md` y los JSON correspondientes.
