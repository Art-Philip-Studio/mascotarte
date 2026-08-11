# Mascotarte

Retratos de mascotas estilo galería, generados con IA (Gemini "Nano Banana").
Un solo prompt fijo por estilo — el usuario sube la foto, elige un estilo, y recibe el retrato.

## Estructura

```
mascotarte/
├── public/
│   └── index.html          # Frontend (landing + estudio de carga)
├── netlify/
│   └── functions/
│       └── generar-retrato.js   # Function que llama a Gemini
└── netlify.toml             # Config de build/deploy de Netlify
```

## Cómo ponerlo en marcha (paso a paso)

### 1. Crear el repositorio en GitHub
- Crea un repo nuevo (por ejemplo `mascotarte`).
- Sube esta carpeta completa.

### 2. Crear el sitio en Netlify
- "Add new site" → "Import an existing project" → conecta el repo de GitHub.
- Build command: (vacío, es sitio estático)
- Publish directory: `public`
- Functions directory: `netlify/functions`
  (esto ya queda definido en `netlify.toml`, Netlify lo debería detectar solo)

### 3. Configurar variables de entorno en Netlify
En **Site settings → Environment variables**, agrega:

| Variable | Para qué sirve |
|---|---|
| `GEMINI_API_KEY` | API key de Google AI Studio, para generar las imágenes |

Cuando conectes el sistema de créditos y pagos, se sumarán además las variables de Firebase (`FIREBASE_*`) y de PayPhone (`PAYPHONE_TOKEN`, `PAYPHONE_STORE_ID`), igual que en Pixeo.

### 4. Deploy
Cada push a la rama principal despliega automáticamente.

## Lo que falta conectar (siguientes pasos)

Este scaffold ya funciona de punta a punta para **generar la imagen**, pero todavía es un esqueleto en dos puntos importantes que se agregan después, cuando quieras:

1. **Autenticación real (Firebase Auth)** — hoy el botón "Generar retrato" no valida quién es el usuario.
2. **Sistema de créditos real (Firestore)** — hoy el contador de créditos en la pantalla es solo visual (`3 créditos disponibles` es un valor fijo en el HTML), no descuenta nada de verdad. Hay un comentario `TODO` en `netlify/functions/generar-retrato.js` marcando exactamente dónde va la verificación y el descuento del crédito.
3. **Cobro (PayPhone)** — para cuando el usuario se quede sin créditos y quiera comprar más.

Dime cuando quieras seguir con cualquiera de estos tres y lo construimos igual que en Pixeo, paso a paso.
