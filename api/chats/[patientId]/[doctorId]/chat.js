import admin from 'firebase-admin';
import Pusher from 'pusher';

// Initialize Firebase Admin if not already initialized
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

// Initialize Pusher with the provided credentials
const pusher = new Pusher({
  appId: '1980166',
  key: '2ed44c3ce3ef227d9924',
  secret: '26843c7446853b43df1c',
  cluster: 'ap2',
});

export default async function handler(req, res) {
  // Set CORS headers to allow requests from your frontend
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  const { patientId, doctorId } = req.query;
  const { 'x-user-uid': uid } = req.headers;

  // Validate UID
  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized: Missing UID' });
  }

  try {
    // Verify the user exists in Firebase Auth
    await admin.auth().getUser(uid);

    // Handle GET: Fetch messages for the patient-doctor chat room
    if (req.method === 'GET') {
      const messagesRef = db.collection('chats').where('chatRoom', '==', `${patientId}-${doctorId}`);
      const snapshot = await messagesRef.get();
      const messages = snapshot.docs.map((doc) => doc.data());
      res.status(200).json({ messages });
    }
    // Handle POST: Save new message and broadcast via Pusher
    else if (req.method === 'POST') {
      const message = req.body;
      // Add chatRoom identifier to the message
      message.chatRoom = `${patientId}-${doctorId}`;
      // Save to Firestore
      await db.collection('chats').add(message);
      // Broadcast the message via Pusher
      await pusher.trigger(`chat-${patientId}-${doctorId}`, 'message', message);
      res.status(200).json({ success: true });
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error handling chat:', error);
    res.status(500).json({ error: 'Server error' });
  }
}