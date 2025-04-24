//api/patients/[patientId]/patients.js
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

const db = admin.firestore();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://healthcare-app-vercel.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'x-user-uid, Content-Type');

  const { patientId } = req.query;
  const { 'x-user-uid': uid } = req.headers;

  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized: Missing UID' });
  }

  try {
    await admin.auth().getUser(uid);

    if (req.method === 'POST') {
      const { diagnosis, prescription, doctorId } = req.body;
      const patientRef = db.collection('patients').doc(patientId);
      const updateData = {};
      if (diagnosis) updateData.diagnosis = diagnosis;
      if (prescription) updateData.prescription = prescription;
      if (doctorId) updateData.doctorId = doctorId;
      await patientRef.set(updateData, { merge: true });
      res.status(200).json({ success: true });
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error updating patient:', error);
    res.status(500).json({ error: 'Server error' });
  }
}