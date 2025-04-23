import admin from 'firebase-admin';

console.log('AssignDoctor function loaded at', new Date().toISOString());

if (!admin.apps.length) {
  console.log('Checking environment variables...');
  console.log('FIREBASE_PRIVATE_KEY:', process.env.FIREBASE_PRIVATE_KEY ? 'set' : 'missing');

  try {
    const serviceAccount = {
      type: 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || 'fir-project-vercel',
    });
    console.log('Firebase Admin initialized');
  } catch (error) {
    console.error('Firebase initialization failed:', error.message);
    throw error;
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, x-user-uid, Content-Type, Accept');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.warn('Invalid method', { method: req.method });
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('AssignDoctor handler invoked at', new Date().toISOString(), { body: req.body, headers: req.headers });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('Missing or invalid Authorization header', { authHeader });
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    console.log('Token verified, UID:', decodedToken.uid);

    const { patientId, doctorId } = req.body;
    if (!patientId || !doctorId) {
      console.warn('Missing required fields', { patientId, doctorId });
      return res.status(400).json({ error: 'patientId and doctorId are required' });
    }

    // Verify patient exists and belongs to the authenticated user
    const patientDoc = await db.collection('users').doc(decodedToken.uid).get();
    if (!patientDoc.exists || patientDoc.data().patientId !== patientId) {
      console.warn('Invalid patient', { uid: decodedToken.uid, patientId });
      return res.status(403).json({ error: 'Forbidden: Invalid patient ID' });
    }

    // Verify doctor exists
    const doctorDoc = await db.collection('doctors').doc(doctorId).get();
    if (!doctorDoc.exists) {
      console.warn('Doctor not found', { doctorId });
      return res.status(404).json({ error: 'Doctor not found' });
    }

    // Store assignment in Firestore
    const assignmentRef = db.collection('assignments').doc();
    const assignmentData = {
      patientId,
      doctorId,
      patientUid: decodedToken.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await assignmentRef.set(assignmentData);
    console.log('Assignment created:', assignmentData);

    return res.status(200).json({ message: 'Doctor assigned successfully', assignmentId: assignmentRef.id });
  } catch (error) {
    console.error('AssignDoctor error:', error.message);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}