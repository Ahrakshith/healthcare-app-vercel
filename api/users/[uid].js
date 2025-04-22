const { Firestore } = require('@google-cloud/firestore');
const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY || '{}')),
  });
}

const db = new Firestore();

export default async function handler(req, res) {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID is required' });

  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const data = userDoc.data();
    res.status(200).json(data);
  } catch (error) {
    console.error('Server error:', error);
    if (error.code === 'permission-denied') {
      return res.status(403).json({ error: 'Permission denied. Check Firestore rules.' });
    }
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}