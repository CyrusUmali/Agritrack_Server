const admin = require('firebase-admin');
const pool = require('../connect');

let firebaseInitialized = false;

try {
  if (!admin.apps.length) {

 // Validate required environment variables
 const requiredEnvVars = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_PRIVATE_KEY_ID',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_CLIENT_ID',
  'FIREBASE_CLIENT_X509_CERT_URL',
  'FIREBASE_DATABASE_URL'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}



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
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });

    firebaseInitialized = true;
    console.log('Firebase Admin initialized successfully');
  }
} catch (initError) {
  console.error('🔥 Firebase Admin initialization failed:', initError);
  process.exit(1);
}

const authenticateFirebaseToken = async (req, res, next) => {

  if (!firebaseInitialized) {
    return res.status(500).json({
      success: false,
      message: 'Server configuration error',
      error: {
        code: 'FIREBASE_NOT_INITIALIZED',
        details: 'Firebase Admin SDK failed to initialize'
      }
    });
  }

  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authorization token required',
      error: {
        code: 'MISSING_AUTH_HEADER',
        solution: 'Include "Authorization: Bearer <token>" header'
      }
    });
  }

  const idToken = authHeader.split(' ')[1];

  try {
    // Verify token with additional checks
    const decodedToken = await admin.auth().verifyIdToken(idToken, true); // Check revoked

    // Validate token has required claims
    if (!decodedToken.uid) {
      throw new Error('Invalid token: missing uid');
    }

    // Database lookup with error handling
    let users;
    try {
      [users] = await pool.query(
        'SELECT * FROM users WHERE firebase_uid = ?',
        [decodedToken.uid]
      );
    } catch (dbError) {
      console.error('Database query failed:', dbError);
      throw new Error('User lookup failed');
    }

    if (!users.length) {
      return res.status(403).json({
        success: false,
        message: 'User not registered',
        error: {
          code: 'USER_NOT_FOUND',
          firebaseUid: decodedToken.uid,
          solution: 'User needs to complete registration'
        }
      });
    }

    // Attach user to request
    req.user = {
      firebaseUid: decodedToken.uid,
      dbUser: users[0],
      token: decodedToken,
      tokenRaw: idToken // For debugging
    };

    next();
  } catch (error) {
    console.error('🔐 Authentication error:', error);

    const errorDetails = {
      'auth/id-token-expired': {
        message: 'Token expired',
        solution: 'Get a fresh token from client',
        status: 401
      },
      'auth/argument-error': {
        message: 'Invalid token format',
        solution: 'Check token structure',
        status: 400
      },
      'auth/invalid-id-token': {
        message: 'Malformed token',
        solution: 'Verify token generation',
        status: 400
      },
      'default': {
        message: 'Authentication failed',
        solution: 'Try again or contact support',
        status: 401
      }
    };

    const errorInfo = errorDetails[error.code] || errorDetails.default;

    res.status(errorInfo.status).json({
      success: false,
      message: errorInfo.message,
      error: {
        code: error.code || 'AUTH_ERROR',
        details: error.message,
        solution: errorInfo.solution,
        ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
      }
    });
  }
};

module.exports = authenticateFirebaseToken;