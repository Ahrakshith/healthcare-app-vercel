import admin from 'firebase-admin';
import Pusher from 'pusher';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const db = admin.firestore();
const pusher = new Pusher({
  appId: '1980166',
  key: '2ed44c3ce3ef227d9924',
  secret: process.env.PUSHER_SECRET || '26843c7446853b43df1c',
  cluster: 'ap2',
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  const { 'x-user-uid': uid } = req.headers;

  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized: Missing UID' });
  }

  try {
    await admin.auth().getUser(uid);

    if (req.method === 'GET') {
      // For now, return an empty array to stop the 404 error
      // Later, you can fetch actual notifications from Firestore
      res.status(200).json([]);
    } else if (req.method === 'POST') {
      const { patientId, patientName, age, sex, description, disease, medicine, doctorId } = req.body;
      const notification = {
        patientId,
        patientName,
        age,
        sex,
        description,
        disease,
        medicine,
        doctorId,
        timestamp: new Date().toISOString(),
      };
      // Save to Firestore (optional, if you want to persist notifications)
      await db.collection('admin_notifications').add(notification);
      // Broadcast missed dose alert via Pusher
      await pusher.trigger(`chat-${patientId}-${doctorId}`, 'missedDoseAlert', {
        patientId,
        message: `Missed dose alert for ${patientName}`,
      });
      res.status(200).json({ success: true });
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error handling admin notifications:', error);
    res.status(500).json({ error: 'Server error' });
  }
}