// api/users/[uid].js
import admin from 'firebase-admin';

console.log('Function /api/users/[uid] loaded at', new Date().toISOString());

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  console.log('Checking environment variables for Firebase Admin...');
  console.log('FIREBASE_PRIVATE_KEY:', process.env.FIREBASE_PRIVATE_KEY ? 'set' : 'missing');
  console.log('FIREBASE_PROJECT_ID:', process.env.FIREBASE_PROJECT_ID || 'missing');

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
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Firebase Admin initialization failed:', error.message, error.stack);
    throw new Error(`Firebase Admin initialization failed: ${error.message}`);
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  // Set CORS headers (consistent with vercel.json)
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, x-user-uid, Content-Type, Accept');
  res.setHeader('Content-Type', 'application/json');

  // Handle OPTIONS preflight requests
  if (req.method === 'OPTIONS') {
    console.log('Handling OPTIONS request at', new Date().toISOString());
    return res.status(200).end();
  }

  console.log('Handler invoked at', new Date().toISOString(), {
    method: req.method,
    query: req.query,
    headers: req.headers,
  });

  // Only allow GET requests
  if (req.method !== 'GET') {
    console.warn('Method not allowed', { method: req.method });
    return res.status(405).json({ error: 'Method not allowed', allowed: 'GET' });
  }

  // Validate Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('Missing or invalid Authorization header', { authHeader });
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    // Verify Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    console.log('Token verified, UID:', decodedToken.uid);

    // Extract and validate UID from query
    const { uid } = req.query;
    if (!uid || typeof uid !== 'string') {
      console.warn('Missing or invalid UID', { uid });
      return res.status(400).json({ error: 'UID is required and must be a string' });
    }

    // Ensure the UID matches the token's UID
    if (uid !== decodedToken.uid) {
      console.warn('UID mismatch', { queryUid: uid, tokenUid: decodedToken.uid });
      return res.status(403).json({ error: 'Forbidden: UID does not match token' });
    }

    // Fetch user data from Firestore
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      console.warn('User not found in Firestore', { uid });
      return res.status(404).json({ error: 'User not found' });
    }

    const data = userDoc.data();
    console.log('User data retrieved successfully:', { uid, data });
    return res.status(200).json(data);
  } catch (error) {
    console.error('Error in handler:', error.message, error.stack);
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Unauthorized: Token expired' });
    }
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}