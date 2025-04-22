import admin from 'firebase-admin';

if (!admin.apps.length) {
  console.log('Initializing Firebase Admin at', new Date().toISOString());
  try {
    // Ensure all environment variables are present
    const requiredEnvVars = [
      'FIREBASE_PROJECT_ID',
      'FIREBASE_PRIVATE_KEY_ID',
      'FIREBASE_PRIVATE_KEY',
      'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_CLIENT_ID',
      'FIREBASE_CLIENT_CERT_URL',
    ];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingVars.length > 0) {
      throw new Error(`Missing environment variables: ${missingVars.join(', ')}`);
    }

    // Handle private key with potential escaped newlines or single-line format
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (typeof privateKey === 'string') {
      // Log the raw private key for debugging (mask sensitive parts)
      console.log('Raw FIREBASE_PRIVATE_KEY length:', privateKey.length, 'Sample:', privateKey.substring(0, 10) + '...');
      // Replace escaped newlines and handle multi-line format
      privateKey = privateKey.replace(/\\n/g, '\n');
      if (!privateKey.includes('\n') && privateKey.includes('\\n')) {
        privateKey = privateKey.split('\\n').join('\n');
      }
      // Verify newlines are present
      if (!privateKey.includes('\n')) {
        console.warn('⚠️ Private key does not contain newlines after processing');
      }
    } else {
      throw new Error('FIREBASE_PRIVATE_KEY is not a valid string');
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

    // Log service account details (mask sensitive data)
    console.log('Service Account Config:', {
      project_id: serviceAccount.project_id,
      private_key_id: serviceAccount.private_key_id,
      client_email: serviceAccount.client_email,
      has_private_key: !!serviceAccount.private_key,
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
      envVars: {
        FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ? 'set' : 'missing',
        FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ? 'set' : 'missing',
        FIREBASE_PRIVATE_KEY_ID: process.env.FIREBASE_PRIVATE_KEY_ID ? 'set' : 'missing',
        FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL ? 'set' : 'missing',
        FIREBASE_CLIENT_ID: process.env.FIREBASE_CLIENT_ID ? 'set' : 'missing',
        FIREBASE_CLIENT_CERT_URL: process.env.FIREBASE_CLIENT_CERT_URL ? 'set' : 'missing',
      },
    });
    throw error; // Ensure the error propagates to Vercel
  }
}

const db = admin.firestore();

export default async function handler(req, res) {
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