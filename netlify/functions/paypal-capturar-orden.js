// netlify/functions/paypal-capturar-orden.js
//
// Confirma con PayPal que el pago se completó de verdad y entrega los
// créditos correspondientes. Usa el orderId de PayPal como llave única
// para que, aunque esta función se llame dos veces por error o por un
// reintento del navegador, los créditos NUNCA se entreguen dos veces.

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

const db = admin.firestore();

const PAQUETES = {
  pack5: { credits: 5, amount: "4.99" },
  pack10: { credits: 10, amount: "8.99" },
  pack20: { credits: 20, amount: "15.99" },
};

const PAYPAL_API = "https://api-m.paypal.com";

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

  let orderId;
  try {
    ({ orderId } = JSON.parse(event.body || "{}"));
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Body inválido" }) };
  }
  if (!orderId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Falta orderId" }) };
  }

  try {
    const accessToken = await getAccessToken();

    // 2) Capturar el pago en PayPal (esto es lo que mueve el dinero de verdad).
    const captureRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    const captureData = await captureRes.json();

    if (!captureRes.ok) {
      console.error("Error capturando orden PayPal:", captureData);
      return { statusCode: 502, body: JSON.stringify({ error: "No se pudo confirmar el pago" }) };
    }

    const purchaseUnit = captureData.purchase_units?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];
    const status = capture?.status;
    const customId = purchaseUnit?.custom_id || "";
    const [customUid, paqueteId] = customId.split("|");
    const paquete = PAQUETES[paqueteId];

    // 3) Validaciones de seguridad: el pago debe estar completado, ser del
    //    mismo usuario que pidió la orden, y el paquete debe existir.
    if (status !== "COMPLETED") {
      return { statusCode: 402, body: JSON.stringify({ error: "El pago no se completó (estado: " + status + ")" }) };
    }
    if (customUid !== uid) {
      console.error("Mismatch de uid en captura de PayPal:", customUid, uid);
      return { statusCode: 403, body: JSON.stringify({ error: "No autorizado" }) };
    }
    if (!paquete) {
      return { statusCode: 400, body: JSON.stringify({ error: "Paquete inválido" }) };
    }

    // 4) Entregar los créditos de forma ATÓMICA y a prueba de duplicados.
    //    Usamos el orderId de PayPal como ID del documento: si ya existe,
    //    significa que este pago YA fue procesado antes, así que no
    //    volvemos a sumar créditos.
    const pagoRef = db.collection("pagosPaypalProcesados").doc(orderId);
    const userRef = db.collection("users").doc(uid);

    const yaFueProcesado = await db.runTransaction(async (tx) => {
      const pagoDoc = await tx.get(pagoRef);
      if (pagoDoc.exists) {
        return true; // Ya se entregaron los créditos antes, no hacer nada.
      }
      tx.set(pagoRef, {
        uid,
        paqueteId,
        credits: paquete.credits,
        amount: paquete.amount,
        fecha: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(userRef, {
        credits: admin.firestore.FieldValue.increment(paquete.credits),
      });
      return false;
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        creditsAdded: yaFueProcesado ? 0 : paquete.credits,
        alreadyProcessed: yaFueProcesado,
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Error interno" }) };
  }
};
