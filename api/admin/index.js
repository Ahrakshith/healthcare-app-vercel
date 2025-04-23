const admin = require('firebase-admin');

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  const pathSegments = req.url.split('/').filter(Boolean);
  const endpoint = pathSegments[1]; // e.g., "admin_notifications" or "assign-doctor"

  try {
    const userId = req.headers['x-user-uid'];
    if (!userId) {
      return res.status(400).json({ error: 'Firebase UID is required in x-user-uid header' });
    }

    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    if (userData.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized: Admin access required' });
    }

    if (endpoint === 'admin') {
      const subEndpoint = pathSegments[2]; // "admin_notifications" or "assign-doctor"

      if (subEndpoint === 'admin_notifications') {
        if (req.method !== 'GET') {
          return res.status(405).json({ error: 'Method not allowed' });
        }

        const notificationsSnapshot = await db.collection('admin_notifications').get();
        const notifications = notificationsSnapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));

        return res.status(200).json({ notifications });
      } else if (subEndpoint === 'assign-doctor') {
        if (req.method !== 'POST') {
          return res.status(405).json({ error: 'Method not allowed' });
        }

        const { patientId, doctorId } = req.body;
        if (!patientId || !doctorId) {
          return res.status(400).json({ error: 'patientId and doctorId are required' });
        }

        const patientRef = await db.collection('patients').where('patientId', '==', patientId).get();
        if (patientRef.empty) {
          return res.status(404).json({ error: 'Patient not found' });
        }

        const doctorRef = await db.collection('doctors').where('doctorId', '==', doctorId).get();
        if (doctorRef.empty) {
          return res.status(404).json({ error: 'Doctor not found' });
        }

        await db.collection('doctor_assignments').add({
          patientId,
          doctorId,
          assignedAt: new Date().toISOString(),
        });

        return res.status(200).json({ message: 'Doctor assigned successfully' });
      }
    }

    return res.status(404).json({ error: 'Endpoint not found' });
  } catch (error) {
    console.error(`Error in /api/admin/${endpoint}:`, error.message);
    res.status(500).json({ error: `Failed to process ${endpoint}`, details: error.message });
  }
}