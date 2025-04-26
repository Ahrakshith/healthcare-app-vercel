// api/misc/logout.js
import admin from 'firebase-admin';

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('Firebase Admin initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Firebase Admin:', error.message);
    throw error;
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type, Authorization');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Extract endpoint and sub-endpoint
  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // "misc"
  const subEndpoint = pathSegments[2]; // "logout"

  // Validate user ID from header
  const userId = req.headers['x-user-uid'];
  if (!userId) {
    console.log('Logout request rejected: Missing x-user-uid header');
    return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
  }

  try {
    if (endpoint !== 'misc') {
      console.log(`Invalid endpoint: ${endpoint}`);
      return res.status(404).json({ error: 'Endpoint not found' });
    }

    if (subEndpoint === 'logout') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        console.log(`Method not allowed for /misc/logout: ${req.method}`);
        return res.status(405).json({ error: 'Method not allowed' });
      }

      console.log(`Processing logout for user: ${userId}`);
      // Revoke all refresh tokens for the user
      await admin.auth().revokeRefreshTokens(userId);
      console.log(`Revoked refresh tokens for user ${userId}`);

      // Update Firestore with last logout timestamp
      await db.collection('users').doc(userId).set(
        { lastLogout: new Date().toISOString() },
        { merge: true }
      );
      console.log(`Updated lastLogout for user ${userId} in Firestore`);

      return res.status(200).json({ message: 'Logged out successfully', userId });
    }

    console.log(`Unknown sub-endpoint: ${subEndpoint}`);
    return res.status(404).json({ error: 'Endpoint not found' });
  } catch (error) {
    console.error(`Error in /api/misc/logout: ${error.message}`);
    return res.status(500).json({ error: 'Failed to process logout request', details: error.message });
  }
}