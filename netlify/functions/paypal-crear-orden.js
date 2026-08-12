// netlify/functions/paypal-crear-orden.js
//
// Crea una orden de pago en PayPal para comprar un paquete de créditos.
// El precio se define SIEMPRE en el servidor (nunca confiamos en lo que
// mande el navegador) para que nadie pueda manipular el precio.

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

// Paquetes válidos. La fuente de verdad de precios vive AQUÍ, no en el frontend.
const PAQUETES = {
  pack5: { credits: 5, amount: "4.99" },
  pack10: { credits: 10, amount: "8.99" },
  pack20: { credits: 20, amount: "15.99" },
};

const PAYPAL_API = "https://api-m.paypal.com"; // Live. Para pruebas sería api-m.sandbox.paypal.com

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");

  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error("No se pudo autenticar con PayPal: " + JSON.stringify(data));
  }
  return data.access_token;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Método no permitido" }) };
  }

  // 1) Verificar sesión de Firebase.
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
    return { statusCode: 401, body: JSON.stringify({ error: "Sesión inválida." }) };
  }

  // 2) Validar el paquete pedido.
  let paqueteId;
  try {
    ({ paqueteId } = JSON.parse(event.body || "{}"));
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Body inválido" }) };
  }

  const paquete = PAQUETES[paqueteId];
  if (!paquete) {
    return { statusCode: 400, body: JSON.stringify({ error: "Paquete inválido" }) };
  }

  // 3) Crear la orden en PayPal.
  try {
    const accessToken = await getAccessToken();

    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            // Guardamos uid + paqueteId aquí para poder verificarlos de nuevo
            // al momento de capturar el pago, sin depender del navegador.
            custom_id: `${uid}|${paqueteId}`,
            amount: {
              currency_code: "USD",
              value: paquete.amount,
            },
            description: `Mascotarte - ${paquete.credits} créditos`,
          },
        ],
      }),
    });

    const orderData = await orderRes.json();
    if (!orderRes.ok) {
      console.error("Error creando orden PayPal:", orderData);
      return { statusCode: 502, body: JSON.stringify({ error: "No se pudo crear la orden de pago" }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ orderId: orderData.id }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Error interno" }) };
  }
};
