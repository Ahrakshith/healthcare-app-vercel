import admin from 'firebase-admin';

if (!admin.apps.length) {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (
      !process.env.FIREBASE_PROJECT_ID ||
      !privateKey ||
      !process.env.FIREBASE_CLIENT_EMAIL ||
      !process.env.FIREBASE_PRIVATE_KEY_ID ||
      !process.env.FIREBASE_CLIENT_ID ||
      !process.env.FIREBASE_CLIENT_CERT_URL
    ) {
      throw new Error('Missing Firebase credentials');
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: privateKey,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
        clientId: process.env.FIREBASE_CLIENT_ID,
        clientCertUrl: process.env.FIREBASE_CLIENT_CERT_URL,
      }),
    });
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Firebase Admin initialization failed:', error.message);
    throw error;
  }
}

const db = admin.firestore();

// Retry logic
async function operationWithRetry(operation, retries = 3, backoff = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === retries) throw error;
      console.warn(`Retry ${attempt}/${retries} failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, backoff * attempt));
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: { code: 405, message: 'Method not allowed' } });
  }

  const userId = req.headers['x-user-uid'];
  if (!userId) {
    return res.status(401).json({ error: { code: 401, message: 'Unauthorized: Missing x-user-uid header' } });
  }

  try {
    // Verify user role
    const userDoc = await operationWithRetry(() => db.collection('users').doc(userId).get());
    if (!userDoc.exists || userDoc.data().role !== 'patient') {
      return res.status(403).json({ error: { code: 403, message: 'Forbidden: Only patients can fetch doctors' } });
    }

    // Get specialty from query parameter
    const { specialty = 'All' } = req.query;

    // Fetch doctors based on specialty
    let doctorsSnapshot;
    if (specialty !== 'All') {
      doctorsSnapshot = await operationWithRetry(() =>
        db.collection('doctors').where('specialty', '==', specialty).get()
      );
    } else {
      doctorsSnapshot = await operationWithRetry(() => db.collection('doctors').get());
    }

    const doctors = doctorsSnapshot.docs.map(doc => ({ doctorId: doc.id, ...doc.data() }));

    return res.status(200).json({ doctors });
  } catch (error) {
    console.error(`Error in /api/doctors: ${error.message}`);
    return res.status(500).json({ error: { code: 500, message: 'Server error', details: error.message } });
  }
}