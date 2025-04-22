import admin from 'firebase-admin';

// Initialize Firebase only once
if (admin.apps.length === 0) {
  console.log('Initializing Firebase Admin at', new Date().toISOString());
  try {
    const serviceAccount = JSON.parse(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY || '{}'); // Match your env var name
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || 'fir-project-vercel', // Match your env var name
    });
    console.log('Firebase Admin initialized successfully at', new Date().toISOString());
  } catch (initError) {
    console.error('Firebase initialization failed:', initError.message);
    throw initError;
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
      console.log(`User ${uid} not found at ${new Date().toISOString()}`);
      return res.status(404).json({ error: 'User not found' });
    }

    const data = userDoc.data();
    console.log('User data retrieved:', JSON.stringify(data), 'at', new Date().toISOString());
    return res.status(200).json(data);
  } catch (error) {
    console.error('Server error at', new Date().toISOString(), error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}