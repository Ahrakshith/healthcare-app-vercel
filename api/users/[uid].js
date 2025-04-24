//api/users/[uid].js
import admin from 'firebase-admin';

console.log('Function loaded at', new Date().toISOString());

if (!admin.apps.length) {
  console.log('Checking environment variables...');
  console.log('FIREBASE_PRIVATE_KEY:', process.env.FIREBASE_PRIVATE_KEY ? 'set' : 'missing');

  try {
    const serviceAccount = {
      type: 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
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
    console.log('Firebase Admin initialized');
  } catch (error) {
    console.error('Firebase initialization failed:', error.message);
    throw error;
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, x-user-uid, Content-Type, Accept');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log('Handler invoked at', new Date().toISOString(), { query: req.query, headers: req.headers });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('Missing or invalid Authorization header', { authHeader });
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    console.log('Token verified, UID:', decodedToken.uid);

    const { uid } = req.query;
    if (!uid || typeof uid !== 'string') {
      console.warn('Missing or invalid UID', { uid });
      return res.status(400).json({ error: 'UID is required and must be a string' });
    }

    if (uid !== decodedToken.uid) {
      console.warn('UID mismatch', { queryUid: uid, tokenUid: decodedToken.uid });
      return res.status(403).json({ error: 'Forbidden: UID does not match token' });
    }

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      console.warn('User not found', { uid });
      return res.status(404).json({ error: 'User not found' });
    }

    const data = userDoc.data();
    console.log('User data retrieved:', { uid, data });
    return res.status(200).json(data);
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid token', details: error.message });
  }
}