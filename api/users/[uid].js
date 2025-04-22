const { Firestore } = require('@google-cloud/firestore');
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.REACT_APP_GCS_SERVICE_ACCOUNT_KEY)),
});

const db = new Firestore();

export default async function handler(req, res) {
  const { uid } = req.query;
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    res.status(200).json(userDoc.data());
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}