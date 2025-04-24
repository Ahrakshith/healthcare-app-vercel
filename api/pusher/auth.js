import Pusher from 'pusher';
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  const { socket_id, channel_name } = req.body;
  const { 'x-user-uid': uid } = req.headers;

  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized: Missing UID' });
  }

  try {
    await admin.auth().getUser(uid);
    const authResponse = pusher.authenticateUser(uid, socket_id, channel_name);
    res.status(200).json(authResponse);
  } catch (error) {
    console.error('Pusher auth failed:', error.message);
    res.status(401).json({ error: 'Unauthorized: Invalid UID' });
  }
}