// netlify/functions/generar-retrato.js
//
// Recibe una foto en base64 + un estilo elegido, verifica que quien llama
// esté logueado con Firebase Auth, descuenta 1 crédito de su documento en
// Firestore (con una transacción, para que no se pueda duplicar el gasto),
// llama a Gemini para generar el retrato, y si Gemini falla, devuelve el
// crédito.
//
// Variables de entorno necesarias en Netlify (Site settings > Environment variables):
//   GEMINI_API_KEY            -> tu API key de Google AI Studio / Gemini
//   FIREBASE_PROJECT_ID       -> el projectId de tu proyecto Firebase
//   FIREBASE_CLIENT_EMAIL     -> el "client_email" del JSON de la cuenta de servicio
//   FIREBASE_PRIVATE_KEY      -> el "private_key" del JSON de la cuenta de servicio
//                                 (pégalo tal cual, con los \n incluidos)

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Netlify guarda saltos de línea como "\n" literal; hay que convertirlos.
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

const PROMPTS = {
  dramatica:
    "Convierte esta foto de mascota en una ilustración de retrato dramática de estudio: " +
    "contraste alto, paleta roja y dorada, iluminación tipo Rembrandt, fondo oscuro liso, " +
    "trazo de ilustración digital pintada a mano, composición centrada, estilo de retrato de galería.",
  acuarela:
    "Convierte esta foto de mascota en una pintura de acuarela suave: trazos sueltos, " +
    "colores pastel, textura visible de papel de acuarela, fondo claro difuminado, " +
    "estilo tierno e ilustrativo, composición centrada.",
  oleo:
    "Convierte esta foto de mascota en un óleo clásico renacentista: fondo oscuro, " +
    "pinceladas densas y visibles, iluminación cálida y dramática, marco dorado clásico " +
    "insinuado en el encuadre, composición de retrato de galería solemne.",
};

// Descuenta 1 crédito de forma atómica. Lanza error si no hay suficientes.
async function descontarCredito(uid) {
  const ref = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) {
      throw new Error("NO_USER_DOC");
    }
    const credits = doc.data().credits || 0;
    if (credits < 1) {
      throw new Error("NO_CREDITS");
    }
    tx.update(ref, { credits: credits - 1 });
  });
}

// Devuelve 1 crédito (si algo falla después de haberlo descontado).
async function revertirCredito(uid) {
  const ref = db.collection("users").doc(uid);
  try {
    await ref.update({ credits: admin.firestore.FieldValue.increment(1) });
  } catch (e) {
    // Si esto falla no hay mucho que hacer más que loguearlo; no
    // queremos romper la respuesta de error original por esto.
    console.error("No se pudo revertir el crédito:", e);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Método no permitido" }) };
  }

  // 1) Verificar el token de Firebase Auth.
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: "Debes iniciar sesión." }) };
  }

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    uid = decoded.uid;
  } catch (e) {
    return { statusCode: 401, body: JSON.stringify({ error: "Sesión inválida, inicia sesión de nuevo." }) };
  }

  // 2) Parsear body.
  let imagen, estilo;
  try {
    ({ imagen, estilo } = JSON.parse(event.body || "{}"));
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Body inválido" }) };
  }

  if (!imagen) {
    return { statusCode: 400, body: JSON.stringify({ error: "Falta la imagen" }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Falta configurar GEMINI_API_KEY en Netlify" }),
    };
  }

  // 3) Descontar el crédito ANTES de llamar a Gemini.
  try {
    await descontarCredito(uid);
  } catch (e) {
    if (e.message === "NO_CREDITS") {
      return { statusCode: 402, body: JSON.stringify({ error: "No te quedan créditos." }) };
    }
    if (e.message === "NO_USER_DOC") {
      return { statusCode: 400, body: JSON.stringify({ error: "No existe tu perfil de usuario, vuelve a iniciar sesión." }) };
    }
    return { statusCode: 500, body: JSON.stringify({ error: "No se pudo verificar tus créditos." }) };
  }

  // 4) Llamar a Gemini. Si algo falla de aquí en adelante, devolvemos el crédito.
  try {
    const prompt = PROMPTS[estilo] || PROMPTS.dramatica;
    const model = "gemini-2.5-flash-image"; // Nano Banana — confirma el nombre exacto vigente en la documentación de Gemini
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: "image/jpeg", data: imagen } },
            ],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      await revertirCredito(uid);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: data.error?.message || "Error llamando a Gemini" }),
      };
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inlineData || p.inline_data);
    const imagenResultado =
      imagePart?.inlineData?.data || imagePart?.inline_data?.data || null;

    if (!imagenResultado) {
      await revertirCredito(uid);
      const finishReason = data.candidates?.[0]?.finishReason || "desconocido";
      const textoDevuelto = parts.find((p) => p.text)?.text || "";
      console.error("Gemini no devolvió imagen. finishReason:", finishReason, "texto:", textoDevuelto);
      return {
        statusCode: 502,
        body: JSON.stringify({
          error:
            "Gemini no generó una imagen (motivo: " + finishReason + "). " +
            "Esto suele pasar si la foto tiene marcas/personajes registrados, o contenido que el modelo rechaza. Prueba con otra foto." +
            (textoDevuelto ? " Detalle: " + textoDevuelto.slice(0, 200) : ""),
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ imagenResultado }),
    };
  } catch (err) {
    await revertirCredito(uid);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Error interno" }),
    };
  }
};
