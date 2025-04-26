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
  console.log('Firebase Admin initialized successfully in api/admin/index.js');
} catch (error) {
  console.error('Firebase Admin initialization failed in api/admin/index.js:', error.message);
  throw new Error(`Firebase Admin initialization failed: ${error.message}`);
}

const auth = getAuth();
const db = getFirestore();

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, x-user-uid, Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const userId = req.headers['x-user-uid'];
  const authHeader = req.headers.authorization;

  // Validate headers
  if (!userId || !authHeader) {
    console.error('Missing authentication headers:', { userId, authHeader });
    return res.status(401).json({ error: 'Authentication headers missing' });
  }

  try {
    // Verify Firebase ID token
    const token = authHeader.replace('Bearer ', '');
    const decodedToken = await auth.verifyIdToken(token);
    if (decodedToken.uid !== userId) {
      console.error('User ID mismatch:', { tokenUid: decodedToken.uid, headerUid: userId });
      return res.status(403).json({ error: 'Unauthorized user' });
    }

    // Check if user is an admin
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      console.error(`User ${userId} is not an admin`);
      return res.status(403).json({ error: { code: 403, message: 'You are not authorized as an admin' } });
    }

    if (req.method === 'GET') {
      // Fetch all users (patients, doctors, admins) for the admin dashboard
      try {
        const usersSnapshot = await db.collection('users').get();
        const users = usersSnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
        }));

        console.log(`Fetched ${users.length} users for admin dashboard by user ${userId}`);
        return res.status(200).json({ users });
      } catch (error) {
        console.error(`Error fetching users for admin dashboard by user ${userId}:`, error.message);
        return res.status(500).json({ error: 'Failed to fetch users', details: error.message });
      }
    } else {
      console.error('Method not allowed:', req.method);
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error(`Authentication error for user ${userId}:`, error.message);
    return res.status(401).json({ error: 'Invalid or expired token', details: error.message });
  }
}