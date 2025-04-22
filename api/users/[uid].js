import admin from 'firebase-admin';

if (admin.apps.length === 0) {
  console.log('Initializing Firebase Admin at', new Date().toISOString());
  try {
    const serviceAccount = {
      type: 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    };
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || 'fir-project-vercel',
    });
    console.log('Firebase Admin initialized successfully at', new Date().toISOString());
  } catch (error) {
    console.error('Firebase initialization failed:', error.message);
    throw error;
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  const { uid } = req.query;

  if (!uid || typeof uid !== 'string') {
    console.log('Missing or invalid UID at', new Date().toISOString());
    return res.status(400).json({ error: 'UID is required and must be a string' });
  }

  try {
    console.log('Fetching user:', uid, 'at', new Date().toISOString());
    const start = Date.now();
    const userDoc = await db.collection('users').doc(uid).get();
    const duration = Date.now() - start;
    console.log(`Firestore query took ${duration}ms for UID ${uid}`);

    if (!userDoc.exists) {
      console.log(`User ${uid} not found at`, new Date().toISOString());
      return res.status(404).json({ error: 'User not found' });
    }

    const data = userDoc.data();
    console.log('User data retrieved:', JSON.stringify(data), 'at', new Date().toISOString());
    return res.status(200).json(data);
  } catch (error) {
    console.error('Server error at', new Date().toISOString(), error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message || 'Unknown error',
    });
  }
}