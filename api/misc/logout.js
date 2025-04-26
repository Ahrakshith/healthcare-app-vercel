import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin
let app;
try {
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY || !process.env.FIREBASE_CLIENT_EMAIL) {
    throw new Error('Missing Firebase credentials: FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, or FIREBASE_CLIENT_EMAIL');
  }

  app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
  console.log('Firebase Admin initialized successfully in api/misc/logout.js');
} catch (error) {
  console.error('Firebase Admin initialization failed in api/misc/logout.js:', error.message);
  throw new Error(`Firebase Admin initialization failed: ${error.message}`);
}

const auth = getAuth();
const db = getFirestore();

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, x-user-uid, Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Validate headers
  const userId = req.headers['x-user-uid'];
  const authHeader = req.headers.authorization;

  if (!userId) {
    console.error('Missing x-user-uid header');
    return res.status(401).json({ error: 'Missing user ID header' });
  }

  if (req.method !== 'POST') {
    console.error('Method not allowed:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log(`Processing logout for user: ${userId}`);

  try {
    // Verify Firebase ID token if provided
    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      try {
        const decodedToken = await auth.verifyIdToken(token);
        if (decodedToken.uid !== userId) {
          console.error('User ID mismatch:', { tokenUid: decodedToken.uid, headerUid: userId });
          return res.status(403).json({ error: 'Unauthorized user' });
        }
        // Revoke refresh tokens if token is valid
        await auth.revokeRefreshTokens(userId);
        console.log(`Revoked refresh tokens for user ${userId}`);
      } catch (error) {
        console.warn(`Invalid or expired token for user ${userId}:`, error.message);
        // Continue with logout even if token verification fails
      }
    } else {
      console.warn('No Authorization header provided, skipping token verification');
    }

    // Update Firestore with last logout timestamp
    await db.collection('users').doc(userId).set(
      { lastLogout: new Date().toISOString() },
      { merge: true }
    );
    console.log(`Updated lastLogout for user ${userId} in Firestore`);

    return res.status(200).json({ message: 'Logged out successfully', userId });
  } catch (error) {
    console.error(`Error in /api/misc/logout for user ${userId}:`, error.message);
    return res.status(500).json({ error: 'Failed to process logout request', details: error.message });
  }
}