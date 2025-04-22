import admin from 'firebase-admin';

console.log('Function loaded at', new Date().toISOString()); // Early log to confirm function load

if (!admin.apps.length) {
  console.log('Initializing Firebase Admin at', new Date().toISOString());
  try {
    // Early validation of environment variables
    console.log('Checking environment variables...');
    const requiredEnvVars = [
      'FIREBASE_PROJECT_ID',
      'FIREBASE_PRIVATE_KEY_ID',
      'FIREBASE_PRIVATE_KEY',
      'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_CLIENT_ID',
      'FIREBASE_CLIENT_CERT_URL',
    ];
    requiredEnvVars.forEach(varName => {
      console.log(`${varName}: ${process.env[varName] ? 'set' : 'missing'}`, {
        length: process.env[varName]?.length || 0,
        sample: process.env[varName]?.substring(0, 10) || 'N/A',
      });
    });

    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (typeof privateKey !== 'string') {
      throw new Error('FIREBASE_PRIVATE_KEY is not a valid string');
    }
    console.log('Raw FIREBASE_PRIVATE_KEY length:', privateKey.length, 'Sample:', privateKey.substring(0, 10) + '...');
    privateKey = privateKey.replace(/\\n/g, '\n');
    if (!privateKey.includes('\n') && privateKey.includes('\\n')) {
      privateKey = privateKey.split('\\n').join('\n');
    }
    if (!privateKey.includes('\n')) {
      console.warn('⚠️ Private key does not contain newlines after processing');
    }

    const serviceAccount = {
      type: 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: privateKey,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    };

    console.log('Attempting Firebase initialization with:', {
      project_id: serviceAccount.project_id,
      has_private_key: !!serviceAccount.private_key,
      client_email: serviceAccount.client_email,
    });

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || 'fir-project-vercel',
    });

    console.log('✅ Firebase Admin initialized successfully at', new Date().toISOString());
  } catch (error) {
    console.error('❌ Firebase initialization failed:', {
      message: error.message,
      stack: error.stack,
      envVars: requiredEnvVars.reduce((acc, varName) => ({
        ...acc,
        [varName]: process.env[varName] ? 'set' : 'missing',
      }), {}),
    });
    throw error; // Ensure the error propagates to Vercel
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
  console.log('Handler invoked at', new Date().toISOString(), { method: req.method, query: req.query });
  const { uid } = req.query;

  if (!uid || typeof uid !== 'string') {
    console.warn('⚠️ Missing or invalid UID at', new Date().toISOString(), { uid });
    return res.status(400).json({ error: 'UID is required and must be a string' });
  }

  try {
    console.log(`🔍 Fetching user: ${uid} at ${new Date().toISOString()}`);
    const start = Date.now();
    const userDoc = await db.collection('users').doc(uid).get();
    const duration = Date.now() - start;
    console.log(`⏱ Firestore query took ${duration}ms for UID ${uid}`);

    if (!userDoc.exists) {
      console.warn(`❌ User ${uid} not found at ${new Date().toISOString()}`);
      return res.status(404).json({ error: 'User not found' });
    }

    const data = userDoc.data();
    console.log('✅ User data retrieved:', { uid, data });
    return res.status(200).json(data);
  } catch (error) {
    console.error('💥 Server error at', new Date().toISOString(), {
      message: error.message,
      stack: error.stack,
      code: error.code,
    });
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message || 'Unknown error',
    });
  }
}