# Conversor de monedas (CLP · VES · USD_BCV · USDT)

Aplicación web estática en **HTML + CSS + JavaScript puro (Vanilla JS)**, sin backend ni dependencias externas.

## Características principales

- Base interna de conversión: **USDT**.
- **USDT y USD_BCV se tratan como monedas distintas**.
- Conversión obligatoria en 2 pasos:
  1. Moneda origen → USDT
  2. USDT → Moneda destino
- Tasas con metadatos completos: valor, fuente, fecha/hora y estado (`web`, `cache`, `manual`).
- Fallback robusto:
  - Primero intenta web.
  - Si falla, usa cache (`localStorage`).
  - Si no alcanza con web+cache, habilita modo manual.
- Soporta todas las combinaciones entre: `CLP`, `VES`, `USD_BCV`, `USDT`.

## Fuentes de datos y reglas

Tasas primarias usadas:

- `VES por USDT` → Binance
- `CLP por USDT` → Binance
- `VES por USD_BCV` → BCV

**No se consulta USD_BCV por USDT en API.**

Se calcula de forma derivada:

```text
USD_BCV_por_USDT = VES_por_USDT / VES_por_USD_BCV
```

## Arquitectura (app.js)

El código está organizado por módulos:

- **Módulo UI**: renderizado, mensajes, tabla de tasas, resultado, panel manual.
- **Módulo Tasas**: `fetch` con timeout, validación de respuestas, cálculo de tasa derivada, merge con cache.
- **Módulo Conversión**: lógica de conversión en dos pasos con USDT como base.
- **Módulo Almacenamiento**: persistencia de tasas en `localStorage`.
- **Módulo Validación**: validaciones numéricas, payload de tasas y monto.
- **Módulo Manejo de Errores**: normalización de mensajes y ejecución segura.

## Estructura

```text
.
├── index.html
├── styles.css
├── app.js
└── README.md
```

## Ejecución local

Opciones:

1. Abrir `index.html` directamente en navegador.
2. O servir estático con un servidor local (recomendado para pruebas):

```bash
python3 -m http.server 5500
```

Luego abrir: `http://localhost:5500`

## Despliegue en GitHub Pages

1. Sube estos archivos a un repositorio en GitHub.
2. Ve a **Settings → Pages**.
3. En **Build and deployment** selecciona:
   - **Source**: Deploy from a branch
   - **Branch**: `main` (o la rama que uses) y carpeta `/root`
4. Guarda los cambios.
5. GitHub Pages publicará el sitio en una URL similar a:
   - `https://TU_USUARIO.github.io/TU_REPO/`

## Notas de robustez

- Cada consulta web usa `try/catch` y timeout.
- Errores de red/CORS no rompen la app: se notifica y se activa fallback.
- El sistema tolera fallos parciales de fuentes; si una fuente falla, intenta completar con cache.
- Si no hay datos suficientes, habilita modo manual para mantener la operatividad.
