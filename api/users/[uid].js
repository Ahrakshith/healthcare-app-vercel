import { Firestore } from '@google-cloud/firestore';
import admin from 'firebase-admin';

if (admin.apps.length === 0) {
  console.log('Initializing Firebase Admin at', new Date().toISOString());
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY || '{}')),
      projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || 'fir-project-vercel', // Match env var
    });
    console.log('Firebase Admin initialized successfully at', new Date().toISOString());
  } catch (initError) {
    console.error('Firebase initialization failed:', initError.message);
    throw initError;
  }
}

const db = new Firestore();

export default async function handler(req, res) {
  const { uid } = req.query;
  if (!uid) {
    console.log('Missing UID at', new Date().toISOString());
    return res.status(400).json({ error: 'UID is required' });
  }

  try {
    console.log('Fetching user:', uid, 'at', new Date().toISOString());
    const start = Date.now();
    const userDoc = await db.collection('users').doc(uid).get();
    const duration = Date.now() - start;
    console.log(`Firestore query took ${duration}ms for UID ${uid}`);

    if (!userDoc.exists) {
      console.log(`User ${uid} not found at', new Date().toISOString());
      return res.status(404).json({ error: 'User not found' });
    }

    const data = userDoc.data();
    console.log('User data retrieved:', JSON.stringify(data), 'at', new Date().toISOString());
    res.status(200).json(data);
  } catch (error) {
    console.error('Server error at', new Date().toISOString(), error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}