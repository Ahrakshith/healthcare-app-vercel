import { Firestore } from '@google-cloud/firestore';
import admin from 'firebase-admin';

if (admin.apps.length === 0) {
  console.log('Initializing Firebase Admin');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY || '{}')),
  });
}

const db = new Firestore();

export default async function handler(req, res) {
  const { uid } = req.query;
  if (!uid) {
    console.log('Missing UID');
    return res.status(400).json({ error: 'UID is required' });
  }

  try {
    console.log(`Fetching user: ${uid}`);
    const start = Date.now();
    const userDoc = await db.collection('users').doc(uid).get();
    const duration = Date.now() - start;
    console.log(`Firestore query took ${duration}ms`);

    if (!userDoc.exists) {
      console.log(`User ${uid} not found`);
      return res.status(404).json({ error: 'User not found' });
    }

    const data = userDoc.data();
    console.log(`User data retrieved: ${JSON.stringify(data)}`);
    res.status(200).json(data);
  } catch (error) {
    console.error('Server error:', error);
    if (error.code === 'permission-denied') {
      return res.status(403).json({ error: 'Permission denied. Check Firestore rules.' });
    }
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}