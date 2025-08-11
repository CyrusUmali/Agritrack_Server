// authRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect'); 
const axios = require('axios');

const { sendTestEmail } = require('../gmailService'); // update path as needed






router.post('/migrate-to-google', authenticate, async (req, res) => {
  try {
    const { accessToken } = req.body;
    
    // 1. Verify authentication
    if (!req.user || !req.user.dbUser) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated'
      });
    }

    const currentUser = req.user.dbUser;
    
    // 2. Verify Google access token
    const tokenInfo = await axios.get('https://www.googleapis.com/oauth2/v3/tokeninfo', {
      params: { access_token: accessToken }
    });
    
    if (tokenInfo.data.error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid Google access token'
      });
    }

    const googleEmail = tokenInfo.data.email;
    const googleUid = tokenInfo.data.sub;
  
    // 3. Check if Google account is already linked to another user
    try {
      const existingUser = await admin.auth().getUserByEmail(googleEmail);
      if (existingUser.uid !== currentUser.firebase_uid) {
        return res.status(200).json({
          success: false,
          message: 'This Google account is already linked to another user'
        });
      }
    } catch (error) {
      if (error.code !== 'auth/user-not-found') {
        throw error;
      }
    }

    // 4. Get current auth user data
    const currentAuthUser = await admin.auth().getUser(currentUser.firebase_uid);
    
    // 5. Check if already using Google auth
    if (currentAuthUser.providerData.some(provider => provider.providerId === 'google.com')) {
      return res.status(400).json({
        success: false,
        message: 'Account is already using Google authentication'
      });
    }

    // Start a MySQL transaction
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 6. Remove email/password provider if it exists
      const emailProvider = currentAuthUser.providerData.find(
        provider => provider.providerId === 'password'
      );
      
      if (emailProvider) {
        await admin.auth().updateUser(currentUser.firebase_uid, {
          email: googleEmail,
          emailVerified: true,
          providersToDelete: ['password']
        });
      }

      // 7. Link the Google account
      await admin.auth().updateUser(currentUser.firebase_uid, {
        providerToLink: {
          uid: googleUid,
          providerId: 'google.com',
          email: googleEmail,
          displayName: currentAuthUser.displayName || currentUser.name
        }
      });

      // 8. Update MySQL database
      await connection.query(
        `UPDATE users 
         SET email = ?, password = NULL
         WHERE firebase_uid = ?`,
        [googleEmail, currentUser.firebase_uid]
      );

      // Commit transaction
      await connection.commit();

      // 9. Return success response
      const updatedUser = await admin.auth().getUser(currentUser.firebase_uid);
      const [dbUser] = await pool.query(
        'SELECT * FROM users WHERE firebase_uid = ?',
        [currentUser.firebase_uid]
      );
      
      res.status(200).json({
        success: true,
        message: 'Successfully migrated to Google authentication',
        user: {
          firebase_uid: updatedUser.uid,
          email: googleEmail,
          name: updatedUser.displayName || dbUser[0].name,
          role: dbUser[0].role,
          authProvider: 'google'
        }
      });

    } catch (error) {
      // Rollback transaction on error
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

  } catch (error) {
    console.error('Google migration error:', error);
    
    let errorMessage = 'Failed to migrate to Google authentication';
    let statusCode = 500;
    
    if (error.code === 'auth/id-token-expired') {
      errorMessage = 'Google token expired';
      statusCode = 401;
    } else if (error.code === 'auth/id-token-revoked') {
      errorMessage = 'Google token revoked';
      statusCode = 401;
    } else if (error.code === 'auth/email-already-exists') {
      errorMessage = 'Google account is already linked to another user';
      statusCode = 409;
    } else if (error.code === 'auth/user-not-found') {
      errorMessage = 'User account not found';
      statusCode = 404;
    } else if (error.code === 'auth/requires-recent-login') {
      errorMessage = 'This operation requires recent authentication. Please log in again.';
      statusCode = 401;
    }

    res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});














router.get('/associations', async (req, res) => {
  try {
    const { year } = req.query;

    // First get all associations
    const [associations] = await pool.query(`
      SELECT 
        a.id,
        a.name,
        a.description,
        a.created_at as createdAt,
        a.updated_at as updatedAt
      FROM associations a
      ORDER BY a.name ASC
    `);

    if (!associations.length) {
      return res.json({
        success: true,
        associations: [],
        totals: {
          totalMembers: 0,
          totalAssociations: 0,
          totalActive: 0,
          totalLandArea: 0,
          totalFarms: 0,
          totalFarmers: 0,
          avgFarmSize: 0,
          totalYields: 0,
          totalYieldVolume: 0,
          totalYieldValue: 0
        },
        topAssociation: null
      });
    }

    // Get member counts and farm statistics for each association
    const [associationStats] = await pool.query(`
      SELECT 
        f.assoc_id as associationId,
        COUNT(DISTINCT f.id) as total_farmers,
        COUNT(DISTINCT fm.farm_id) as total_farms,
        SUM(fm.area) as total_land_area,
        AVG(fm.area) as avg_farm_size,
        COUNT(DISTINCT fy.id) as total_yields,
        SUM(fy.volume) as total_yield_volume,
        SUM(fy.Value) as total_yield_value
      FROM farmers f
      LEFT JOIN farms fm ON f.id = fm.farmer_id
      LEFT JOIN farmer_yield fy ON fm.farm_id = fy.farm_id
      WHERE f.assoc_id IS NOT NULL
      ${year ? 'AND YEAR(fy.harvest_date) = ?' : ''}
      GROUP BY f.assoc_id
    `, year ? [year] : []);

    // Get previous year stats for growth calculation if year is provided
    let growthMetricsMap = {};
    if (year) {
      const prevYear = parseInt(year) - 1;
      const [prevYearStats] = await pool.query(`
        SELECT 
          f.assoc_id as associationId,
          SUM(fy.volume) as total_yield_volume,
          SUM(fy.Value) as total_yield_value
        FROM farmers f
        JOIN farms fm ON f.id = fm.farmer_id
        JOIN farmer_yield fy ON fm.farm_id = fy.farm_id
        WHERE f.assoc_id IS NOT NULL AND YEAR(fy.harvest_date) = ?
        GROUP BY f.assoc_id
      `, [prevYear]);

      prevYearStats.forEach(row => {
        const currentStats = associationStats.find(s => s.associationId === row.associationId);
        if (currentStats) {
          const currentVol = currentStats.total_yield_volume || 0;
          const prevVol = row.total_yield_volume || 0;
          const currentVal = currentStats.total_yield_value || 0;
          const prevVal = row.total_yield_value || 0;

          growthMetricsMap[row.associationId] = {
            yieldVolumeGrowth: prevVol ? ((currentVol - prevVol) / prevVol * 100) : 0,
            yieldValueGrowth: prevVal ? ((currentVal - prevVal) / prevVal * 100) : 0
          };
        }
      });
    }

    // Get annual yield data for each association (last 5 years)
    const [annualYieldData] = await pool.query(`
      SELECT 
        f.assoc_id as associationId,
        YEAR(fy.harvest_date) as year,
        SUM(fy.volume) as total_volume,
        SUM(fy.Value) as total_value
      FROM farmers f
      JOIN farms fm ON f.id = fm.farmer_id
      JOIN farmer_yield fy ON fm.farm_id = fy.farm_id
      WHERE f.assoc_id IS NOT NULL
      GROUP BY f.assoc_id, YEAR(fy.harvest_date)
      ORDER BY f.assoc_id, year DESC
    `);

    // Organize annual yield data by association
    const annualYieldMap = {};
    annualYieldData.forEach(row => {
      if (!annualYieldMap[row.associationId]) {
        annualYieldMap[row.associationId] = [];
      }
      annualYieldMap[row.associationId].push({
        year: row.year,
        totalVolume: parseFloat(row.total_volume),
        totalValue: parseFloat(row.total_value)
      });
    });

    // Enhance associations with stats
    const enhancedAssociations = associations.map(assoc => {
      const stats = associationStats.find(s => s.associationId === assoc.id) || {};
      const growthMetrics = growthMetricsMap[assoc.id] || {};
      const annualYield = annualYieldMap[assoc.id] ? 
        annualYieldMap[assoc.id].slice(0, 5).sort((a, b) => b.year - a.year) : [];

      return {
        id: assoc.id,
        name: assoc.name,
        description: assoc.description,
        createdAt: assoc.createdAt,
        updatedAt: assoc.updatedAt,
        stats: {
          totalFarmers: stats.total_farmers ? parseInt(stats.total_farmers) : 0,
          totalFarms: stats.total_farms ? parseInt(stats.total_farms) : 0,
          totalLandArea: stats.total_land_area ? parseFloat(stats.total_land_area) : 0,
          avgFarmSize: stats.avg_farm_size ? parseFloat(stats.avg_farm_size) : 0,
          totalYields: stats.total_yields ? parseInt(stats.total_yields) : 0,
          totalYieldVolume: stats.total_yield_volume ? parseFloat(stats.total_yield_volume) : 0,
          totalYieldValue: stats.total_yield_value ? parseFloat(stats.total_yield_value) : 0,
          ...growthMetrics
        },
        annualYield
      };
    });

    // Calculate totals
    const totals = {
      totalMembers: enhancedAssociations.reduce((sum, a) => sum + a.stats.totalFarmers, 0),
      totalAssociations: enhancedAssociations.length,
      totalActive: 0, // Since we don't have an active flag
      totalLandArea: enhancedAssociations.reduce((sum, a) => sum + a.stats.totalLandArea, 0),
      totalFarms: enhancedAssociations.reduce((sum, a) => sum + a.stats.totalFarms, 0),
      totalFarmers: enhancedAssociations.reduce((sum, a) => sum + a.stats.totalFarmers, 0),
      avgFarmSize: enhancedAssociations.reduce((sum, a) => sum + a.stats.avgFarmSize, 0) / enhancedAssociations.length,
      totalYields: enhancedAssociations.reduce((sum, a) => sum + a.stats.totalYields, 0),
      totalYieldVolume: enhancedAssociations.reduce((sum, a) => sum + a.stats.totalYieldVolume, 0),
      totalYieldValue: enhancedAssociations.reduce((sum, a) => sum + a.stats.totalYieldValue, 0)
    };

    // Find top association by member count
    let topAssociation = null;
    if (enhancedAssociations.length > 0) {
      const sortedByMembers = [...enhancedAssociations].sort((a, b) => 
        b.stats.totalFarmers - a.stats.totalFarmers
      );
      topAssociation = {
        id: sortedByMembers[0].id,
        name: sortedByMembers[0].name,
        memberCount: sortedByMembers[0].stats.totalFarmers,
        totalLandArea: sortedByMembers[0].stats.totalLandArea,
        totalYieldValue: sortedByMembers[0].stats.totalYieldValue
      };
    }

    res.json({
      success: true,
      associations: enhancedAssociations,
      totals,
      topAssociation,
      ...(year && { yearFilter: year })
    });

  } catch (error) {
    console.error('Failed to fetch association data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch association data',
      error: {
        code: 'ASSOCIATION_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});
 
 
// Create new association
router.post('/associations', authenticate, async (req, res) => {
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ 
      success: false, 
      message: 'Name is required' 
    });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO associations (name, description) VALUES (?, ?)',
      [name, description]
    );

    const [newAssociation] = await pool.query(
      'SELECT id, name, description  FROM associations WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      association: newAssociation[0],
      message: 'Association created successfully'
    });
  } catch (error) {
    console.error('Failed to create association:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create association' 
    });
  }
});

// Update association
router.put('/associations/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ 
      success: false, 
      message: 'Name is required' 
    });
  }

  try {
    await pool.query(
      'UPDATE associations SET name = ?, description = ? WHERE id = ?',
      [name, description, id]
    );

    const [updatedAssociation] = await pool.query(
      'SELECT id, name, description   FROM associations WHERE id = ?',
      [id]
    );

    if (updatedAssociation.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Association not found' 
      });
    }

    res.json({
      success: true,
      association: updatedAssociation[0],
      message: 'Association updated successfully'
    });
  } catch (error) {
    console.error('Failed to update association:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update association' 
    });
  }
});

// Delete association
router.delete('/associations/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await pool.query(
      'DELETE FROM associations WHERE id = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Association not found' 
      });
    }

    res.json({
      success: true,
      message: 'Association deleted successfully'
    });
  } catch (error) {
    console.error('Failed to delete association:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete association' 
    });
  }
});

// Get single association by ID
router.get('/associations/:id', authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const [association] = await pool.query(
      'SELECT id, name, description   FROM associations WHERE id = ?',
      [id]
    );

    if (association.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Association not found' 
      });
    }

    res.json({
      success: true,
      association: association[0]
    });
  } catch (error) {
    console.error('Failed to fetch association:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch association' 
    });
  }
});
 



 

// Get all annotations
router.get('/annotations', authenticate, async (req, res) => {
  try {
    const [annotations] = await pool.query(`
      SELECT 
        id, 
        year, 
        value, 
        text, 
        coordinate_unit AS coordinateUnit,
        horizontal_alignment AS horizontalAlignment,
        vertical_alignment AS verticalAlignment,
        created_at AS createdAt
      FROM chart_annotations
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      annotations
    });
  } catch (error) {
    console.error('Failed to fetch annotations:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch annotations' });
  }
});

// Create new annotation
router.post('/annotations', authenticate, async (req, res) => {
  try {
    const { 
      year, 
      value, 
      text, 
      coordinateUnit = 'point', 
      horizontalAlignment = 'near', 
      verticalAlignment = 'far' 
    } = req.body;

    if (!year || !text) {
      return res.status(400).json({ 
        success: false, 
        message: 'year and text are required' 
      });
    }

    const [result] = await pool.query(
      `INSERT INTO chart_annotations 
        (year, value, text, coordinate_unit, horizontal_alignment, vertical_alignment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [year, value || 0, text, coordinateUnit, horizontalAlignment, verticalAlignment]
    );

    const [newAnnotation] = await pool.query(
      `SELECT 
        id, 
        year, 
        value, 
        text, 
        coordinate_unit AS coordinateUnit,
        horizontal_alignment AS horizontalAlignment,
        vertical_alignment AS verticalAlignment,
        created_at AS createdAt
       FROM chart_annotations WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      annotation: newAnnotation[0]
    });
  } catch (error) {
    console.error('Failed to create annotation:', error);
    res.status(500).json({ success: false, message: 'Failed to create annotation' });
  }
});

// Update annotation
router.put('/annotations/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      year, 
      value, 
      text, 
      coordinateUnit, 
      horizontalAlignment, 
      verticalAlignment 
    } = req.body;

    if (!text || !year) {
      return res.status(400).json({ 
        success: false, 
        message: 'year and text are required' 
      });
    }

    await pool.query(
      `UPDATE chart_annotations 
       SET 
         year = ?, 
         value = ?, 
         text = ?,
         coordinate_unit = ?,
         horizontal_alignment = ?,
         vertical_alignment = ?
       WHERE id = ?`,
      [
        year, 
        value || 0, 
        text,
        coordinateUnit,
        horizontalAlignment,
        verticalAlignment,
        id
      ]
    );

    const [updatedAnnotation] = await pool.query(
      `SELECT 
        id, 
        year, 
        value, 
        text, 
        coordinate_unit AS coordinateUnit,
        horizontal_alignment AS horizontalAlignment,
        vertical_alignment e verticalAlignment,
        created_at AS createdAt
       FROM chart_annotations WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      annotation: updatedAnnotation[0]
    });
  } catch (error) {
    console.error('Failed to update annotation:', error);
    res.status(500).json({ success: false, message: 'Failed to update annotation' });
  }
});

// Delete annotation (remains the same as before)
router.delete('/annotations/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `DELETE FROM chart_annotations WHERE id = ?`,
      [id]
    );

    res.status(204).end();
  } catch (error) {
    console.error('Failed to delete annotation:', error);
    res.status(500).json({ success: false, message: 'Failed to delete annotation' });
  }
});







router.get('/users', authenticate, async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.role,
        u.created_at,
        u.fname as firstname,
        u.lname as surname,
        u.contact as phone,
        u.status,
        s.sector_name as sector,
        s.sector_id as sectorId,
        f.id as farmerId  -- Add farmer ID from farmers table
      FROM users u
      LEFT JOIN sectors s ON u.sector_id = s.sector_id 
      LEFT JOIN farmers f ON u.id = f.user_id  -- Join with farmers table
      ORDER BY u.created_at DESC
    `);

    res.json({
      success: true,
      users: users.map(user => ({
        id: user.id,
        fullName: {
          firstname: user.firstname,
          surname: user.surname
        },
        name: `${user.firstname}${user.surname ? ' ' + user.surname : ''}` || '---',
        email: user.email || '---',
        phone: user.phone,
        role: user.role,
        status: user.status || 'Active',
        sector: user.sector,
        sectorId: user.sectorId || null,
        farmerId: user.role === 'farmer' ? user.farmerId : null,  // Only include farmerId for farmers
        createdAt: user.created_at
      }))
    });
  } catch (error) {
    console.error('Failed to fetch users:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
});



router.post('/login', async (req, res) => {
  try {
    const { firebaseToken } = req.body;

    if (!firebaseToken) {
      return res.status(400).json({
        success: false,
        message: 'Firebase token required',
        error: {
          code: 'MISSING_TOKEN',
          details: 'No firebaseToken provided in request body'
        }
      });
    }

    // Verify the token
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    } catch (firebaseError) {
      console.error('Firebase token verification failed:', firebaseError);

      const errorDetails = {
        code: firebaseError.code || 'FIREBASE_AUTH_ERROR',
        message: firebaseError.message,
        stack: process.env.NODE_ENV === 'development' ? firebaseError.stack : undefined
      };

      return res.status(401).json({
        success: false,
        message: 'Firebase authentication failed',
        error: errorDetails,
        suggestions: {
          'auth/id-token-expired': 'Request a new token from the client',
          'auth/argument-error': 'Verify the token format is correct',
          'auth/invalid-id-token': 'Ensure the token is properly encoded'
        }[firebaseError.code] || 'Please try again or contact support'
      });
    }

    // Get user from MySQL
    let users;
    try {
      [users] = await pool.query(
        'SELECT * FROM users WHERE firebase_uid = ?',
        [decodedToken.uid]
      );
    } catch (dbError) {
      console.error('Database query failed:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Database operation failed',
        error: {
          code: 'DATABASE_ERROR',
          details: dbError.message,
          sqlMessage: dbError.sqlMessage,
          sqlState: dbError.sqlState
        }
      });
    }

    if (!users.length) {
      return res.status(403).json({
        success: false,
        message: 'User not registered in our system',
        error: {
          code: 'USER_NOT_FOUND',
          details: `Firebase UID ${decodedToken.uid} not found in database`,
          firebaseUid: decodedToken.uid,
          suggestion: 'Complete the registration process first'
        }
      });
    }

    const user = users[0];

    // Check if user status is Pending
    if (user.status === 'Pending') {
      return res.status(403).json({
        success: false,
        message: 'Account not yet approved',
        error: {
          code: 'ACCOUNT_PENDING',
          details: 'Your account is pending approval by an administrator',
          suggestion: 'Please wait for approval or contact support'
        }
      });
    }

    // Check if user signed in with Google
    const isGoogleSignIn = decodedToken.firebase &&
      decodedToken.firebase.sign_in_provider === 'google.com';

    // Prepare the base response
    const response = {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        fname: user.fname,
        contact:user.contact,
        lname: user.lname,
        sector_id: user.sector_id,
        status: user.status,
        authProvider: isGoogleSignIn ? 'google' : 'email',
        hasPassword: !isGoogleSignIn,
        createdAt: user.created_at, // Include the created_at timestamp
        photoUrl: user.photo_url // Also included photoUrl if it exists in your table
      },
      token: firebaseToken,
      tokenInfo: {
        issuedAt: new Date(decodedToken.iat * 1000),
        expiresAt: new Date(decodedToken.exp * 1000),
        authTime: decodedToken.auth_time ? new Date(decodedToken.auth_time * 1000) : null,
        signInProvider: decodedToken.firebase?.sign_in_provider || 'email'
      }
    };

    // If user is a farmer, fetch and add farmer details
    if (user.role === 'farmer') {
      try {
        const [farmers] = await pool.query(`
          SELECT 
            f.id,
            f.user_id,
            f.firstname,
            f.middlename,
            f.surname,
            f.extension,
            f.email,
            f.phone,
            f.address,
            f.imageUrl,
            f.created_at,
            f.updated_at,
            s.sector_name as sector,
            s.sector_id as sectorId, 
            f.barangay,
            f.phone,        
            f.farm_name as farmName,  
            f.total_land_area          
          FROM farmers f
          LEFT JOIN sectors s ON f.sector_id = s.sector_id 
          WHERE f.user_id = ?
        `, [user.id]);

        if (farmers.length) {
          const farmer = farmers[0];
          response.farmer = {
            id: farmer.id,
            fullName: {
              firstname: farmer.firstname,
              middlename: farmer.middlename || null,
              surname: farmer.surname || null,
              extension: farmer.extension || null
            },
            userId: farmer.user_id,
            name: `${farmer.firstname}${farmer.middlename ? ' ' + farmer.middlename : ''}${farmer.surname ? ' ' + farmer.surname : ''}${farmer.extension ? ' ' + farmer.extension : ''}`,
            email: farmer.email,
            phone: farmer.phone,
            address: farmer.address,
            sector: farmer.sector,
            sectorId: farmer.sectorId ? String(farmer.sectorId) : null,
            imageUrl: farmer.imageUrl,
            barangay: farmer.barangay || null,
            contact: farmer.phone,
            farmName: farmer.farmName,
            hectare: parseFloat(farmer.total_land_area),
            createdAt: farmer.created_at,
            updatedAt: farmer.updated_at
          };
        }
      } catch (error) {
        console.error('Failed to fetch farmer details:', error);
        // Don't fail the login if farmer details can't be fetched
        // Just log the error and proceed without farmer details
      }
    }

    res.json(response);

  } catch (error) {
    console.error('Unexpected login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during authentication',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      timestamp: new Date().toISOString()
    });
  }
});


//ateqwq



// Add this to your Express routes
router.get('/debug/time', (req, res) => {
  res.json({
    serverTime: new Date(),
    serverTimeUTC: new Date().toISOString(),
    serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
});

 
router.get('/db-test', async (req, res) => {
  try {
    // Simple query to test the connection
    const [result] = await pool.query('SELECT 1 + 1 AS solution');
    
    res.json({
      success: true,
      message: 'Database connection is workingsss',
      data: {
        testCalculation: result[0].solution, // Should be 2
        serverTime: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Database connection test failed:', error);
    res.status(500).json({
      success: false,
      message: 'Database connection test failed',
      error: error.message
    });
  }
});



 



// Test route to send email
router.post('/send-email', async (req, res) => {
  const { to, subject, message } = req.body;

  if (!to || !subject || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await sendTestEmail(to, subject, message);
    res.status(200).json({ message: 'Email sent successfully', data: result });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});
 

 

// Generate a random 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP to user's email
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
        error: {
          code: 'MISSING_EMAIL',
          details: 'No email provided in request body'
        }
      });
    }

    // Check if user exists
    let users;
    try {
      [users] = await pool.query(
        'SELECT id, email, name FROM users WHERE email = ?',
        [email]
      );
    } catch (dbError) {
      console.error('Database query failed:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Database operation failed',
        error: {
          code: 'DATABASE_ERROR',
          details: dbError.message
        }
      });
    }

    if (!users.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: {
          code: 'USER_NOT_FOUND',
          details: 'No user registered with this email address'
        }
      });
    }

    const user = users[0];
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // OTP valid for 15 minutes

    // Delete any existing OTPs for this user
    try {
      await pool.query(
        'DELETE FROM password_reset_otps WHERE user_id = ?',
        [user.id]
      );
    } catch (deleteError) {
      console.error('Failed to delete existing OTPs:', deleteError);
      // Continue anyway - we'll try to insert new OTP
    }

    // Store the new OTP
    try {
      await pool.query(
        'INSERT INTO password_reset_otps (user_id, otp, expires_at) VALUES (?, ?, ?)',
        [user.id, otp, expiresAt]
      );
    } catch (insertError) {
      console.error('Failed to store OTP:', insertError);
      return res.status(500).json({
        success: false,
        message: 'Failed to generate password reset token',
        error: {
          code: 'OTP_STORAGE_FAILED',
          details: insertError.message
        }
      });
    }

    // Send OTP via email using Gmail service
    try {
      const subject = 'Password Reset OTP'; 
      
      const message = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Password Reset Request</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header {
            color: #2c3e50;
            border-bottom: 2px solid #f2f2f2;
            padding-bottom: 10px;
          }
          .otp-code {
            font-size: 24px;
            font-weight: bold;
            color: #e74c3c;
            margin: 20px 0;
            padding: 10px;
            background: #f9f9f9;
            display: inline-block;
            border-radius: 4px;
          }
          .footer {
            margin-top: 20px;
            padding-top: 10px;
            border-top: 2px solid #f2f2f2;
            font-size: 12px;
            color: #7f8c8d;
          }
          .button {
            display: inline-block;
            padding: 10px 20px;
            background-color: #3498db;
            color: white !important;
            text-decoration: none;
            border-radius: 4px;
            margin: 10px 0;
          }
        </style>
      </head>
      <body>
        <div class="header">
        <h1>Password Reset Request</h1>
        </div>
        <p>Hello ${user.name || 'User'},</p>
        <p>We received a request to reset your password. Please use the following OTP to proceed:</p>
        <div class="otp-code">${otp}</div>
        <p>This OTP is valid for 15 minutes. If you didn't request this, please ignore this email.</p>
        <div class="footer">
          <p>If you're having trouble with the OTP, please contact our support team.</p>
          <p>© ${new Date().getFullYear()} Your Company Name. All rights reserved.</p>
        </div>
      </body>
      </html>
      `;

      await sendTestEmail(user.email, subject, message);

      return res.json({
        success: true,
        message: 'OTP sent successfully',
        data: {
          email: user.email,
          expiresAt: expiresAt.toISOString()
        }
      });

    } catch (emailError) {
      console.error('Email sending error:', emailError);
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP email',
        error: {
          code: 'EMAIL_SEND_FAILED',
          details: emailError.message
        }
      });
    }

  } catch (error) {
    console.error('Unexpected error in forgot password:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        details: error.message
      }
    });
  }
});

// Verify OTP and allow password reset
router.post('/verify-reset-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP are required',
        error: {
          code: 'MISSING_FIELDS',
          details: 'Both email and OTP must be provided'
        }
      });
    }

    // Find user
    let users;
    try {
      [users] = await pool.query(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );
    } catch (dbError) {
      console.error('Database query failed:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Database operation failed',
        error: {
          code: 'DATABASE_ERROR',
          details: dbError.message
        }
      });
    }

    if (!users.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: {
          code: 'USER_NOT_FOUND',
          details: 'No user registered with this email address'
        }
      });
    }

    const user = users[0];

    // Find valid OTP
    let otps;
    try {
      [otps] = await pool.query(
        'SELECT * FROM password_reset_otps WHERE user_id = ? AND otp = ? AND expires_at > NOW()',
        [user.id, otp]
      );
    } catch (otpError) {
      console.error('OTP verification failed:', otpError);
      return res.status(500).json({
        success: false,
        message: 'OTP verification failed',
        error: {
          code: 'OTP_VERIFICATION_FAILED',
          details: otpError.message
        }
      });
    }

    if (!otps.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP',
        error: {
          code: 'INVALID_OTP',
          details: 'The provided OTP is invalid or has expired'
        }
      });
    }

    // If we get here, OTP is valid
    return res.json({
      success: true,
      message: 'OTP verified successfully',
      data: {
        email,
        resetToken: otp // In production, you might generate a more secure token here
      }
    });

  } catch (error) {
    console.error('Unexpected error in OTP verification:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        details: error.message
      }
    });
  }
});


// Reset password after OTP verification
router.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, OTP and new password are required',
        error: {
          code: 'MISSING_FIELDS',
          details: 'All fields must be provided'
        }
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password too short',
        error: {
          code: 'PASSWORD_TOO_SHORT',
          details: 'Password must be at least 8 characters'
        }
      });
    }

    // Find user
    let users;
    try {
      [users] = await pool.query(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );
    } catch (dbError) {
      console.error('Database query failed:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Database operation failed',
        error: {
          code: 'DATABASE_ERROR',
          details: dbError.message
        }
      });
    }

    if (!users.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: {
          code: 'USER_NOT_FOUND',
          details: 'No user registered with this email address'
        }
      });
    }

    const user = users[0];

    // Verify OTP is still valid
    let otps;
    try {
      [otps] = await pool.query(
        'SELECT * FROM password_reset_otps WHERE user_id = ? AND otp = ? AND expires_at > NOW()',
        [user.id, otp]
      );
    } catch (otpError) {
      console.error('OTP verification failed:', otpError);
      return res.status(500).json({
        success: false,
        message: 'OTP verification failed',
        error: {
          code: 'OTP_VERIFICATION_FAILED',
          details: otpError.message
        }
      });
    }

    if (!otps.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP',
        error: {
          code: 'INVALID_OTP',
          details: 'The provided OTP is invalid or has expired'
        }
      });
    }

    // Update password in Firebase
    try {
      // First get the user's Firebase UID
      const [userRecords] = await pool.query(
        'SELECT firebase_uid FROM users WHERE id = ?',
        [user.id]
      );
      
      if (!userRecords.length) {
        return res.status(404).json({
          success: false,
          message: 'Firebase user not found',
          error: {
            code: 'FIREBASE_USER_NOT_FOUND',
            details: 'No Firebase UID associated with this user'
          }
        });
      }

      const firebaseUid = userRecords[0].firebase_uid;
      
      // Update password in Firebase
      await admin.auth().updateUser(firebaseUid, {
        password: newPassword
      });
 
  await pool.query(
    'UPDATE users SET password = ? WHERE id = ?',
    [newPassword, user.id]
  );

      // Delete the used OTP
      await pool.query(
        'DELETE FROM password_reset_otps WHERE user_id = ?',
        [user.id]
      );

      return res.json({
        success: true,
        message: 'Password updated successfully'
      });

    } catch (firebaseError) {
      console.error('Firebase password update failed:', firebaseError);
      return res.status(500).json({
        success: false,
        message: 'Failed to update password',
        error: {
          code: 'PASSWORD_UPDATE_FAILED',
          details: firebaseError.message
        }
      });
    }

  } catch (error) {
    console.error('Unexpected error in password reset:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        details: error.message
      }
    });
  }
});









 



// Password reset endpoint for test accounts
router.post('/reset-test-account', async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    // Security check - you might want to add additional validation
    // to ensure this is only used for test accounts in development
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'This endpoint is disabled in production' });
    }

    // Get user by email
    const user = await admin.auth().getUserByEmail(email);

    // Update password
    await admin.auth().updateUser(user.uid, {
      password: newPassword
    });

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(400).json({ error: error.message });
  }
});


router.post('/register-farmer', async (req, res) => {
  let firebaseUser;
  let mysqlUserInsertResult;
  let farmerInsertResult;

  try {
    // 1. Get all data from request
    const {
      email,
      name,
      sector,
      firstname,
      lname,
      barangay,
      phone,
      mname,
      extension,
      sex,
      civilStatus,
      spouseName,
      householdHead,
      householdNum,
      maleMembers,
      femaleMembers,
      motherMaidenName,
      religion,
      address,
      personToNotify,
      ptnContact,
      ptnRelationship,
      password,
      association // Add this line (format: "id: name")
    } = req.body;


    function extractId(input) {
      if (!input) return null;
      const parts = input.split(':');
      return parts.length > 0 ? parseInt(parts[0].trim()) : null;
    }

    // 2. Validate required fields
    if (!email || !name || !password) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: email, name and password are required',
      });
    }

    // 3. Check if email already exists in both users and farmers tables
    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    const [existingFarmers] = await pool.query(
      'SELECT id FROM farmers WHERE email = ?',
      [email]
    );

    if (existingUsers.length > 0 || existingFarmers.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Email already in use',
      });
    }

    // 4. Create Firebase user
    firebaseUser = await admin.auth().createUser({
      email,
      password,
      displayName: name,
      emailVerified: false,
    });


    function extractSectorId(sectorString) {
      if (!sectorString) return null;
      const parts = sectorString.split(':');
      return parts.length > 0 ? parseInt(parts[0]) : null;
    }

    // Set custom claims for farmer role
    await admin.auth().setCustomUserClaims(firebaseUser.uid, { role: 'farmer' });

    [mysqlUserInsertResult] = await pool.query(
      `INSERT INTO users 
      (firebase_uid, email, name, fname, lname, role, password, status) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        firebaseUser.uid,
        email,
        name,
        firstname || name.split(' ')[0], // fallback to first part of name
        lname || name.split(' ').slice(1).join(' ') || null, // fallback to rest of name
        'farmer',
        password,
        'Pending'  // Set status to Active
      ]
    );
    [farmerInsertResult] = await pool.query(
      `INSERT INTO farmers 
      (user_id, name, firstname, middlename, surname, extension, email, phone, barangay, 
       sex, civil_status, spouse_name, house_hold_head, household_num, 
       male_members_num, female_members_num, mother_maiden_name, religion, address, 
       person_to_notify, ptn_contact, ptn_relationship, sector_id, assoc_id, imgUrl, created_at, updated_at) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        mysqlUserInsertResult.insertId,
        name,
        firstname || name.split(' ')[0],
        mname || null,
        lname || name.split(' ').slice(1).join(' ') || null,
        extension || null,
        email,
        phone || '---',
        barangay || null,
        sex || null,
        civilStatus || null,
        spouseName || null,
        householdHead || null,
        householdNum || 0,
        maleMembers || 0,
        femaleMembers || 0,
        motherMaidenName || null,
        religion || null,
        address || null,
        personToNotify || null,
        ptnContact || null,
        ptnRelationship || null,
        extractSectorId(sector),
        extractId(association),
        'https://res.cloudinary.com/dk41ykxsq/image/upload/v1749288962/testUpload/law0n3hfrlptwi9qsvl7.png', // Default image URL
      ]
    );
    // 7. Get the complete farmer record with user info
    const [completeFarmer] = await pool.query(
      `SELECT 
        f.*,
        u.firebase_uid,
        u.role,
        s.sector_name as sector
      FROM farmers f
      JOIN users u ON f.user_id = u.id
      LEFT JOIN sectors s ON f.sector_id = s.sector_id
      WHERE f.id = ?`,
      [farmerInsertResult.insertId]
    );

    if (completeFarmer.length === 0) {
      throw new Error('Failed to retrieve created farmer');
    }

    // 8. Return success response
    res.status(201).json({
      success: true,
      message: 'Farmer registration successful',
      farmer: {
        id: completeFarmer[0].id,
        userId: completeFarmer[0].user_id,
        firebaseUid: completeFarmer[0].firebase_uid,
        name: completeFarmer[0].name,
        email: completeFarmer[0].email,
        phone: completeFarmer[0].phone,
        barangay: completeFarmer[0].barangay,
        sector: completeFarmer[0].sector,
        role: completeFarmer[0].role,
        personalInfo: {
          firstname: completeFarmer[0].firstname,
          middlename: completeFarmer[0].middlename,
          surname: completeFarmer[0].surname,
          extension: completeFarmer[0].extension,
          sex: completeFarmer[0].sex,
          civilStatus: completeFarmer[0].civil_status,
          spouseName: completeFarmer[0].spouse_name
        },
        householdInfo: {
          householdHead: completeFarmer[0].house_hold_head,
          householdNum: completeFarmer[0].household_num,
          maleMembers: completeFarmer[0].male_members,
          femaleMembers: completeFarmer[0].female_members,
          motherMaidenName: completeFarmer[0].mother_maiden_name,
          religion: completeFarmer[0].religion
        },
        contactInfo: {
          address: completeFarmer[0].address,
          personToNotify: completeFarmer[0].person_to_notify,
          ptnContact: completeFarmer[0].ptn_contact,
          ptnRelationship: completeFarmer[0].ptn_relationship
        },
        createdAt: completeFarmer[0].created_at,
        updatedAt: completeFarmer[0].updated_at
      }
    });

  } catch (error) {
    console.error('Farmer registration error:', error);

    // Customize error message based on error type
    let errorMessage = 'Farmer registration failed';
    if (error.code === 'auth/email-already-exists') {
      errorMessage = 'Email already in use (Firebase Auth)';
    } else if (error.code === 'ER_DUP_ENTRY') {
      errorMessage = 'Email already in use (database)';
    }


    // Rollback operations in reverse order
    if (farmerInsertResult?.insertId) {
      try {
        await pool.query('DELETE FROM farmers WHERE id = ?', [farmerInsertResult.insertId]);
      } catch (deleteError) {
        console.error('Failed to rollback farmer entry:', deleteError);
      }
    }

    if (mysqlUserInsertResult?.insertId) {
      try {
        await pool.query('DELETE FROM users WHERE id = ?', [mysqlUserInsertResult.insertId]);
      } catch (deleteError) {
        console.error('Failed to rollback MySQL user:', deleteError);
      }
    }

    if (firebaseUser?.uid) {
      try {
        await admin.auth().deleteUser(firebaseUser.uid);
      } catch (deleteError) {
        console.error('Failed to rollback Firebase user:', deleteError);
      }
    }

    res.status(500).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});




router.put('/users/:id', authenticate, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);


    const { user } = req;

    // Check permissions
    if (user.dbUser.id !== userId && user.dbUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: You can only update your own profile',
        error: {
          code: 'FORBIDDEN',
          details: 'Insufficient permissions'
        }
      });
    }

    const {
      fname,
      lname,
      email,
      phone,
      password,
      newPassword,
      role,
      sector_id
    } = req.body;



    try {
      await admin.auth().getUserByEmail(email);
      // If no error, email exists
      // return res.status(409).json({
      //   success: false,
      //   message: 'Email already in use',
      // });
    } catch (error) {
      // Only proceed if error code is 'auth/user-not-found'
      if (error.code !== 'auth/user-not-found') {
        throw error;
      }
    }

    // First get the existing user data
    const [existingUsers] = await pool.query(
      'SELECT * FROM users WHERE id = ?',
      [userId]
    );

    if (!existingUsers.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: {
          code: 'USER_NOT_FOUND',
          details: `User with ID ${userId} does not exist`
        }
      });
    }

    const existingUser = existingUsers[0];
    const updates = {};
    const updateFields = [];

    // Name handling - support both separate fname/lname and combined name
    if (req.body.name !== undefined) {
      // Split the name into parts
      const nameParts = req.body.name.trim().split(/\s+/);
      updates.fname = nameParts[0] || '';
      updates.lname = nameParts.slice(1).join(' ') || '';
      updateFields.push('fname = ?', 'lname = ?');
    } else {
      // Handle separate fname/lname if provided
      if (fname !== undefined) {
        updates.fname = fname;
        updateFields.push('fname = ?');
      }
      if (lname !== undefined) {
        updates.lname = lname;
        updateFields.push('lname = ?');
      }
    }

    if (phone !== undefined) {
      updates.contact = phone;
      updateFields.push('contact = ?');
    }

    // Email update requires additional checks
    if (email !== undefined && email !== existingUser.email) {
      // Check if new email is already taken
      const [emailCheck] = await pool.query(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email, userId]
      );

      if (emailCheck.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Email already in use by another account',
          error: {
            code: 'EMAIL_IN_USE',
            details: 'The provided email is already registered'
          }
        });
      }
      updates.email = email;
      updateFields.push('email = ?');
    }

    // Role update (admin only)
    if (role !== undefined) {
      updates.role = role;
      updateFields.push('role = ?');
    }

    // Sector update
    if (sector_id !== undefined) {
      updates.sector_id = sector_id;
      updateFields.push('sector_id = ?');
    }

    // Password update status tracking
    let passwordUpdateStatus = {
      updated: false,
      message: 'No password change requested',
      requiresReauthentication: false
    };



    if (newPassword) {
      // Debug object (always included for testing)
      const passwordDebugInfo = {
        providedPassword: password,          // What the user sent
        storedPassword: existingUser.password, // What's stored in DB
        passwordsMatch: password === existingUser.password,
        isAdmin: user.dbUser.role === 'admin',
        userIdMatches: user.dbUser.id === userId,
        DBuserId: user.dbUser.id,
        payloaduserId: userId,
        note: "Admins must provide current password for self-changes"
      };

      // CASE 1: User is changing THEIR OWN password (ADMIN or NOT)
      if (user.dbUser.id === userId) {
        if (!password) {
          return res.status(400).json({
            success: false,
            message: "Current password required",
            debug: passwordDebugInfo
          });
        }
        if (password !== existingUser.password) {
          return res.status(401).json({
            success: false,
            message: "Current password incorrect",
            debug: passwordDebugInfo
          });
        }
      }
      // CASE 2: Admin is changing ANOTHER USER's password (requires admin role)
      else if (user.dbUser.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: "Admin privileges required to change another user's password",
          debug: passwordDebugInfo
        });
      }

      // If checks pass, update the password
      updates.password = newPassword;
      updateFields.push('password = ?');

      // Firebase update (if applicable)
      await admin.auth().updateUser(user.firebaseUid, { password: newPassword });

      // Response with success + debug
      passwordUpdateStatus = {
        updated: true,
        message: "Password updated successfully",
        debug: {
          ...passwordDebugInfo,
          newPasswordSet: newPassword,
          warning: "Admins must still verify their own password!"
        }
      };
    }




    // If no updates were requested
    if (updateFields.length === 0 && !passwordUpdateStatus.updated) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided for update',
        error: {
          code: 'NO_UPDATES',
          details: 'Request body contained no updatable fields'
        }
      });
    }

    // Execute database updates if there are any
    if (updateFields.length > 0) {
      const query = `
        UPDATE users 
        SET ${updateFields.join(', ')} 
        WHERE id = ?
      `;
      const values = [...Object.values(updates), userId];
      await pool.query(query, values);
    }

    // Get the updated user data to return
    const [updatedUsers] = await pool.query(`
      SELECT 
        u.id,
        u.email,
        u.role,
        u.created_at,
        u.fname as firstname,
        u.lname as surname,
        u.contact as phone,
        u.status,
        s.sector_name as sector,
        s.sector_id as sectorId
      FROM users u
      LEFT JOIN sectors s ON u.sector_id = s.sector_id
      WHERE u.id = ?
    `, [userId]);

    const updatedUser = updatedUsers[0];

    // Get Firebase auth details
    let authProviderInfo = [];
    try {
      const firebaseUser = await admin.auth().getUser(user.firebaseUid);
      authProviderInfo = firebaseUser.providerData.map(provider => ({
        providerId: provider.providerId,
        uid: provider.uid,
        email: provider.email,
        displayName: provider.displayName
      }));
    } catch (error) {
      console.error('Failed to fetch Firebase user info:', error);
    }

    res.json({
      success: true,
      message: 'User updated successfully',
      user: {
        id: updatedUser.id,
        fullName: {
          firstname: updatedUser.firstname,
          surname: updatedUser.surname
        },
        name: `${updatedUser.firstname}${updatedUser.surname ? ' ' + updatedUser.surname : ''}` || '---',
        email: updatedUser.email || '---',
        phone: updatedUser.phone,
        role: updatedUser.role,
        status: updatedUser.status || 'Active',
        sector: updatedUser.sector,
        sectorId: updatedUser.sectorId || null,
        createdAt: updatedUser.created_at,
        authProviders: authProviderInfo,
        passwordEnabled: authProviderInfo.some(p => p.providerId === 'password')
      },
      passwordUpdate: passwordUpdateStatus,
      security: {
        lastAuthUpdate: new Date().toISOString(),
        requiresReauthentication: passwordUpdateStatus.updated
      }
    });

  } catch (error) {
    console.error('Failed to update user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: {
        code: 'UPDATE_FAILED',
        details: error.message,
        ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
      },
      passwordUpdate: {
        status: 'error',
        message: 'Password update failed due to server error'
      }
    });
  }
});







router.get('/sectors', async (req, res) => {
  try {
    const { year } = req.query;

    // 1. Base query for sector information
    const [sectors] = await pool.query(`
      SELECT 
        s.sector_id,
        s.sector_name,
        s.description,
        s.created_at,
        s.updated_at
      FROM sectors s
      ORDER BY s.sector_name ASC
    `);

    if (!sectors.length) {
      return res.json({
        success: true,
        sectors: [],
        totals: {
          totalLandArea: 0,
          totalAreaHarvested: 0,
          totalFarmers: 0,
          totalFarms: 0,
          totalYields: 0,
          totalYieldVolume: 0,
          totalYieldValue: 0
        }
      });
    }

    // 2. Farm stats (includes land area from farms)
    const [farmStats] = await pool.query(`
      SELECT 
        s.sector_id,
        COUNT(DISTINCT f.farmer_id) AS farmer_count,
        COUNT(DISTINCT f.farm_id) AS farm_count,
        SUM(f.area) AS total_area
      FROM sectors s
      LEFT JOIN farms f ON s.sector_id = f.sector_id
      GROUP BY s.sector_id
    `);

    // 3. Yield stats query (now includes area_harvested)
    let yieldStatsQuery = `
      SELECT 
        fp.sector_id,
        COUNT(DISTINCT fy.id) AS yield_count,
        SUM(fy.volume) AS total_volume,
        SUM(fy.Value) AS total_value,
        SUM(fy.area_harvested) AS total_area_harvested
      FROM farmer_yield fy
      JOIN farm_products fp ON fy.product_id = fp.id
      JOIN sectors s ON fp.sector_id = s.sector_id
      WHERE fy.status = 'Accepted'
    `;

    if (year) {
      yieldStatsQuery += ` AND YEAR(fy.harvest_date) = ?`;
    }

    yieldStatsQuery += ` GROUP BY fp.sector_id`;

    const [yieldStats] = year
      ? await pool.query(yieldStatsQuery, [year])
      : await pool.query(yieldStatsQuery);

    // 4. Totals query (added total_area_harvested)
    let totalsQuery = `
      SELECT 
        COUNT(DISTINCT f.farmer_id) AS total_farmers,
        COUNT(DISTINCT f.farm_id) AS total_farms,
        SUM(f.area) AS total_land_area,
        SUM(fy.area_harvested) AS total_area_harvested,
        COUNT(DISTINCT fy.id) AS total_yields,
        SUM(fy.volume) AS total_yield_volume,
        SUM(fy.Value) AS total_yield_value
      FROM farms f
      LEFT JOIN farmer_yield fy 
        ON f.farm_id = fy.farm_id 
        AND fy.status = 'Accepted'
    `;

    if (year) {
      totalsQuery += ` WHERE YEAR(fy.harvest_date) = ?`;
    }

    const [totals] = year
      ? await pool.query(totalsQuery, [year])
      : await pool.query(totalsQuery);

    // 5. Combine sector info with stats (added totalAreaHarvested)
    const processedSectors = sectors.map(sector => {
      const farmStat = farmStats.find(stat => stat.sector_id === sector.sector_id) || {};
      const yieldStat = yieldStats.find(stat => stat.sector_id === sector.sector_id) || {};

      return {
        id: sector.sector_id,
        name: sector.sector_name,
        description: sector.description,
        createdAt: sector.created_at,
        updatedAt: sector.updated_at,
        stats: {
          totalLandArea: farmStat.total_area ? parseFloat(farmStat.total_area) : 0,
          totalAreaHarvested: yieldStat.total_area_harvested ? parseFloat(yieldStat.total_area_harvested) : 0,
          totalFarmers: farmStat.farmer_count ? parseInt(farmStat.farmer_count) : 0,
          totalFarms: farmStat.farm_count ? parseInt(farmStat.farm_count) : 0,
          totalYields: yieldStat.yield_count ? parseInt(yieldStat.yield_count) : 0,
          totalYieldVolume: yieldStat.total_volume ? parseFloat(yieldStat.total_volume) : 0,
          totalYieldValue: yieldStat.total_value ? parseFloat(yieldStat.total_value) : 0
        }
      };
    });

    // 6. Prepare totals data (added totalAreaHarvested)
    const processedTotals = {
      totalLandArea: totals[0].total_land_area ? parseFloat(totals[0].total_land_area) : 0,
      totalAreaHarvested: totals[0].total_area_harvested ? parseFloat(totals[0].total_area_harvested) : 0,
      totalFarmers: totals[0].total_farmers ? parseInt(totals[0].total_farmers) : 0,
      totalFarms: totals[0].total_farms ? parseInt(totals[0].total_farms) : 0,
      totalYields: totals[0].total_yields ? parseInt(totals[0].total_yields) : 0,
      totalYieldVolume: totals[0].total_yield_volume ? parseFloat(totals[0].total_yield_volume) : 0,
      totalYieldValue: totals[0].total_yield_value ? parseFloat(totals[0].total_yield_value) : 0
    };

    // 7. Response
    res.json({
      success: true,
      sectors: processedSectors,
      totals: processedTotals,
      ...(year && { yearFilter: year })
    });

  } catch (error) {
    console.error('Failed to fetch sector data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sector data',
      error: {
        code: 'SECTOR_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});





router.get('/sectors/:sectorId', async (req, res) => {
  try {
    const { sectorId } = req.params;
    const { year } = req.query;

    // Validate sectorId
    if (!sectorId || isNaN(sectorId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sector ID provided'
      });
    }

    // Base sector information
    const [sectorInfo] = await pool.query(`
      SELECT 
        sector_id,
        sector_name,
        description,
        mission,
        imgUrl,
        created_at,
        updated_at
      FROM sectors
      WHERE sector_id = ?
    `, [sectorId]);

    if (!sectorInfo.length) {
      return res.status(404).json({
        success: false,
        message: 'Sector not found'
      });
    }

    // Current year stats - Added status='Accepted' condition
    const [currentStats] = await pool.query(`
      SELECT 
        COUNT(DISTINCT f.farmer_id) as total_farmers,
        COUNT(DISTINCT f.farm_id) as total_farms,
        SUM(f.area) as total_land_area,
        AVG(f.area) as avg_farm_size,
        COUNT(DISTINCT fy.id) as total_yields,
        SUM(fy.volume) as total_yield_volume,
        SUM(fy.Value) as total_yield_value
      FROM farms f
      LEFT JOIN farmer_yield fy ON f.farm_id = fy.farm_id AND fy.status = 'Accepted'
      WHERE f.sector_id = ?
      ${year ? 'AND YEAR(fy.harvest_date) = ?' : ''}
    `, year ? [sectorId, year] : [sectorId]);

    // Previous year stats for growth calculation - Added status='Accepted' condition
    let growthMetrics = {};
    if (year) {
      const prevYear = parseInt(year) - 1;
      const [prevYearStats] = await pool.query(`
        SELECT 
          SUM(fy.volume) as total_yield_volume,
          SUM(fy.Value) as total_yield_value
        FROM farms f
        JOIN farmer_yield fy ON f.farm_id = fy.farm_id AND fy.status = 'Accepted'
        WHERE f.sector_id = ? AND YEAR(fy.harvest_date) = ?
      `, [sectorId, prevYear]);

      if (prevYearStats.length && prevYearStats[0].total_yield_volume) {
        const currentVol = currentStats[0].total_yield_volume || 0;
        const prevVol = prevYearStats[0].total_yield_volume;
        const currentVal = currentStats[0].total_yield_value || 0;
        const prevVal = prevYearStats[0].total_yield_value;

        growthMetrics = {
          yieldVolumeGrowth: prevVol ? ((currentVol - prevVol) / prevVol * 100) : 0,
          yieldValueGrowth: prevVal ? ((currentVal - prevVal) / prevVal * 100) : 0
        };
      }
    }

    // Annual yield data for the last 5 years - Added status='Accepted' condition
    const [annualYield] = await pool.query(`
      SELECT 
        YEAR(fy.harvest_date) as year,
        SUM(fy.volume) as total_volume,
        SUM(fy.Value) as total_value
      FROM farms f
      JOIN farmer_yield fy ON f.farm_id = fy.farm_id AND fy.status = 'Accepted'
      WHERE f.sector_id = ?
      GROUP BY YEAR(fy.harvest_date)
      ORDER BY year DESC
      LIMIT 5
    `, [sectorId]);

    // Prepare response
    const response = {
      success: true,
      sector: {
        id: sectorInfo[0].sector_id,
        name: sectorInfo[0].sector_name,
        description: sectorInfo[0].description,
        mission: sectorInfo[0].mission,
        imgUrl: sectorInfo[0].imgUrl,
        createdAt: sectorInfo[0].created_at,
        updatedAt: sectorInfo[0].updated_at,
        stats: {
          totalFarms: currentStats[0].total_farms ? parseInt(currentStats[0].total_farms) : 0,
          totalFarmers: currentStats[0].total_farmers ? parseInt(currentStats[0].total_farmers) : 0,
          totalLandArea: currentStats[0].total_land_area ? parseFloat(currentStats[0].total_land_area) : 0,
          avgFarmSize: currentStats[0].avg_farm_size ? parseFloat(currentStats[0].avg_farm_size) : 0,
          totalYields: currentStats[0].total_yields ? parseInt(currentStats[0].total_yields) : 0,
          totalYieldVolume: currentStats[0].total_yield_volume ? parseFloat(currentStats[0].total_yield_volume) : 0,
          totalYieldValue: currentStats[0].total_yield_value ? parseFloat(currentStats[0].total_yield_value) : 0,
          ...growthMetrics
        },
        annualYield: annualYield.map(y => ({
          year: y.year,
          totalVolume: parseFloat(y.total_volume),
          totalValue: parseFloat(y.total_value)
        }))
      },
      ...(year && { yearFilter: year })
    };

    res.json(response);

  } catch (error) {
    console.error(`Failed to fetch sector details for ID ${req.params.sectorId}:`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sector details',
      error: {
        code: 'SECTOR_DETAILS_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});








router.get('/sector-yield-trends', async (req, res) => {
  try {
    // First get all sectors
    const [sectors] = await pool.query(`
      SELECT sector_id, sector_name FROM sectors
      ORDER BY sector_name ASC
    `);

    if (!sectors.length) {
      return res.json({
        success: true,
        sectorData: {}
      });
    }

    // Get yield data by year for each sector (main sector aggregates)
    const [yieldData] = await pool.query(`
      SELECT 
        p.sector_id,
        s.sector_name,
        YEAR(fy.harvest_date) as year,
        SUM(fy.volume) as total_volume
      FROM farmer_yield fy
      JOIN farm_products p ON fy.product_id = p.id
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE fy.harvest_date IS NOT NULL
      GROUP BY p.sector_id, s.sector_name, YEAR(fy.harvest_date)
      ORDER BY s.sector_name, YEAR(fy.harvest_date)
    `);

    // Get all products with their sector information
    const [products] = await pool.query(`
      SELECT 
        p.id as product_id,
        p.name as product_name,
        p.sector_id,
        s.sector_name
      FROM farm_products p
      JOIN sectors s ON p.sector_id = s.sector_id
      ORDER BY s.sector_name, p.name
    `);

    // Get yield data by product (subsectors)
    const [productYieldData] = await pool.query(`
      SELECT 
        p.id as product_id,
        p.name as product_name,
        p.sector_id,
        s.sector_name,
        YEAR(fy.harvest_date) as year,
        SUM(fy.volume) as total_volume
      FROM farmer_yield fy
      JOIN farm_products p ON fy.product_id = p.id
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE fy.harvest_date IS NOT NULL
      GROUP BY p.id, p.name, p.sector_id, s.sector_name, YEAR(fy.harvest_date)
      ORDER BY s.sector_name, p.name, YEAR(fy.harvest_date)
    `);

    // Function to generate random color in Color.fromARGB format
    const getRandomColor = () => {
      const r = Math.floor(Math.random() * 256);
      const g = Math.floor(Math.random() * 256);
      const b = Math.floor(Math.random() * 256);
      return `const Color.fromARGB(255, ${r}, ${g}, ${b})`;
    };

    // Initialize sector data structure
    const sectorData = {};
    sectors.forEach(sector => {
      sectorData[sector.sector_name] = {
        sectorData: []  // Wrap the array in a sectorData property
      };
    });

    // First process main sector aggregates
    yieldData.forEach(yieldItem => {
      const sectorName = yieldItem.sector_name;

      // Check if sector aggregate already exists
      let sectorAggregate = sectorData[sectorName].sectorData.find(s => s.name === sectorName);

      if (!sectorAggregate) {
        sectorAggregate = {
          name: sectorName,
          color: getRandomColor(),
          data: []
        };
        // Add sector aggregate as first item in the sector's array
        sectorData[sectorName].sectorData.unshift(sectorAggregate);
      }

      sectorAggregate.data.push({
        x: yieldItem.year.toString(),
        y: parseFloat(yieldItem.total_volume) || 0
      });
    });

    // Then process individual products
    productYieldData.forEach(productYield => {
      const sectorName = productYield.sector_name;
      const productName = productYield.product_name;

      // Check if this product already exists in the sector data
      let productSeries = sectorData[sectorName].sectorData.find(s => s.name === productName);

      if (!productSeries) {
        productSeries = {
          name: productName,
          color: getRandomColor(),
          data: []
        };
        sectorData[sectorName].sectorData.push(productSeries);
      }

      productSeries.data.push({
        x: productYield.year.toString(),
        y: parseFloat(productYield.total_volume) || 0
      });
    });

    // Sort data points by year for each sector/subsector
    Object.values(sectorData).forEach(sector => {
      sector.sectorData.forEach(series => {
        series.data.sort((a, b) => a.x.localeCompare(b.x));
      });
    });

    res.json({
      success: true,
      sectorData: sectorData
    });

  } catch (error) {
    console.error('Failed to fetch sector yield trends:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sector yield trends',
      error: {
        code: 'SECTOR_YIELD_TRENDS_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});




router.get('/shi-values', async (req, res) => {
  try {
    const { year, farmerId } = req.query;

    // Helper function to add filters to queries
    const buildQuery = (baseQuery, dateField, filters = {}) => {
      let query = baseQuery;
      const params = [];
      const conditions = [];

      if (year) {
        conditions.push(`YEAR(${dateField}) = ?`);
        params.push(year);
      }

      if (farmerId) {
        conditions.push(`farmer_id = ?`);
        params.push(farmerId);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      return { query, params };
    };

    if (farmerId) {
      // Farmer-specific data
      const { query: landQuery, params: landParams } = buildQuery(
        `SELECT 
          SUM(area) as totalLandArea, 
          COUNT(farm_id) as numberOfFarms 
         FROM farms`,
        'created_at',
        { farmerId }
      );

      const { query: productQuery, params: productParams } = buildQuery(
        `SELECT 
          COUNT(DISTINCT product_id) as productVariety 
         FROM farmer_yield`,
        'harvest_date',
        { farmerId }
      );

      const { query: yieldQuery, params: yieldParams } = buildQuery(
        `SELECT 
          SUM(volume) as totalYield, 
          SUM(value) as totalValue 
         FROM farmer_yield`,
        'harvest_date',
        { farmerId }
      );

      const [landStats] = await pool.query(landQuery, landParams);
      const [productStats] = await pool.query(productQuery, productParams);
      const [yieldStats] = await pool.query(yieldQuery, yieldParams);

      res.json({
        success: true,
        data: {
          totalLandArea: landStats[0].totalLandArea ? parseFloat(landStats[0].totalLandArea) : 0,
          numberOfFarms: landStats[0].numberOfFarms || 0,
          productVariety: productStats[0].productVariety || 0,
          totalYield: yieldStats[0].totalYield ? parseFloat(yieldStats[0].totalYield) : 0,
          totalValue: yieldStats[0].totalValue ? parseFloat(yieldStats[0].totalValue) : 0,
          year: year || 'all-time',
          scope: 'farmer'
        }
      });

    } else {
      // System-wide data (admin view)
      const { query: landQuery, params: landParams } = buildQuery(
        `SELECT 
          SUM(area) as totalLandArea, 
          COUNT(farm_id) as numberOfFarms 
         FROM farms`,
        'created_at'
      );

      const { query: productQuery, params: productParams } = buildQuery(
        `SELECT 
          COUNT(DISTINCT product_id) as productVariety 
         FROM farmer_yield`,
        'harvest_date'
      );

      const { query: yieldQuery, params: yieldParams } = buildQuery(
        `SELECT 
          SUM(volume) as totalYield, 
          SUM(value) as totalValue 
         FROM farmer_yield`,
        'harvest_date'
      );

      const { query: activeQuery, params: activeParams } = buildQuery(
        `SELECT COUNT(DISTINCT farmer_id) as activeFarmers 
         FROM farmer_yield`,
        'harvest_date'
      );

      let inactiveQuery = `
        SELECT COUNT(DISTINCT f.id) as inactiveFarmers 
        FROM farmers f
        LEFT JOIN farmer_yield fy ON f.id = fy.farmer_id 
      `;

      let inactiveParams = [];
      if (year) {
        inactiveQuery += ` WHERE f.id NOT IN (
          SELECT DISTINCT farmer_id 
          FROM farmer_yield 
          WHERE YEAR(harvest_date) = ?
        )`;
        inactiveParams.push(year);
      } else {
        inactiveQuery += ` WHERE fy.farmer_id IS NULL`;
      }

      const [landStats] = await pool.query(landQuery, landParams);
      const [productStats] = await pool.query(productQuery, productParams);
      const [yieldStats] = await pool.query(yieldQuery, yieldParams);
      const [activeFarmers] = await pool.query(activeQuery, activeParams);
      const [inactiveStats] = await pool.query(inactiveQuery, inactiveParams);

      res.json({
        success: true,
        data: {
          totalLandArea: landStats[0].totalLandArea ? parseFloat(landStats[0].totalLandArea) : 0,
          numberOfFarms: landStats[0].numberOfFarms || 0,
          productVariety: productStats[0].productVariety || 0,
          totalYield: yieldStats[0].totalYield ? parseFloat(yieldStats[0].totalYield) : 0,
          totalValue: yieldStats[0].totalValue ? parseFloat(yieldStats[0].totalValue) : 0,
          activeFarmers: activeFarmers[0].activeFarmers || 0,
          inactiveFarmers: inactiveStats[0].inactiveFarmers || 0,
          year: year || 'all-time',
          scope: 'system'
        }
      });
    }

  } catch (error) {
    console.error('Failed to fetch SHI values:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch SHI values',
      error: error.message
    });
  }
});




router.get('/farm-statistics', async (req, res) => {
  try {
    const { year } = req.query;
    const userSectorId = req.user?.dbUser?.sector_id;

    // Helper function to add filters
    const addFilters = (baseQuery, options = {}) => {
      let query = baseQuery;
      const params = [];
      const conditions = [];

      if (year) {
        conditions.push(`YEAR(${options.dateField || 'created_at'}) = ?`);
        params.push(year);
      }

      if (userSectorId) {
        conditions.push(`${options.sectorField || 'sector_id'} = ?`);
        params.push(userSectorId);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      return { query, params };
    };

    // 1. Total farms count
    const farmQuery = addFilters(
      `SELECT COUNT(DISTINCT farm_id) as totalFarms FROM farms`,
      { dateField: 'created_at' }
    );
    const [totalFarmsResult] = await pool.query(farmQuery.query, farmQuery.params);

    // 2. Total farm area (aggregated by farm_id to avoid duplicates)
    const areaQuery = addFilters(
      `SELECT farm_id, MAX(area) as area FROM farms GROUP BY farm_id`
    );

    const [farmAreas] = await pool.query(areaQuery.query, areaQuery.params);
    // Ensure totalArea is a number by parsing each farm.area and providing a default 0
    const totalArea = farmAreas.reduce((sum, farm) => sum + (parseFloat(farm.area) || 0), 0);

    // 3. Average yield per hectare
    let yieldQuery = `
    SELECT 
      IFNULL(ROUND(SUM(fy.volume) / NULLIF(SUM(f.area), 0), 1), 0) as avgYield
    FROM farmer_yield fy
    JOIN farms f ON fy.farm_id = f.farm_id
  `;

    const yieldConditions = [];
    const yieldParams = [];

    if (year) {
      yieldConditions.push(`YEAR(fy.harvest_date) = ?`);
      yieldParams.push(year);
    }

    if (userSectorId) {
      yieldConditions.push(`f.sector_id = ?`);
      yieldParams.push(userSectorId);
    }

    if (yieldConditions.length > 0) {
      yieldQuery += ` WHERE ${yieldConditions.join(' AND ')}`;
    }

    const [avgYieldResult] = await pool.query(yieldQuery, yieldParams);

    // 4. Unique farm owners
    const ownersQuery = addFilters(
      `SELECT COUNT(DISTINCT farmer_id) as uniqueOwners FROM farms`,
      { dateField: 'created_at' }
    );
    const [uniqueOwnersResult] = await pool.query(ownersQuery.query, ownersQuery.params);

    // Format the response data
    const responseData = {
      totalFarms: totalFarmsResult[0]?.totalFarms || 0,
      totalArea: parseFloat(totalArea.toFixed(2)), // Now totalArea is definitely a number
      averageYield: avgYieldResult[0]?.avgYield ? `${avgYieldResult[0].avgYield} kg/ha` : '0 kg/ha',
      uniqueOwners: uniqueOwnersResult[0]?.uniqueOwners || 0,
      year: year || 'all-time',
      sector: userSectorId || 'all-sectors'
    };

    res.json({
      success: true,
      statistics: responseData
    });

  } catch (error) {
    console.error('Failed to fetch farm statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch farm statistics',
      error: {
        code: 'FARM_STATS_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage || 'No SQL error message'
      }
    });
  }
});
 










router.get('/farms-view', async (req, res) => {
  try {
    // Get farmerId from query parameters if it exists
    const { farmerId } = req.query;

    // Base query
let farmQuery = `
SELECT 
  f.farm_id,
  f.vertices,
  f.farm_name,
  f.farmer_id,
  f.products,
  f.area,
  f.description,
  f.sector_id, 
  f.parentBarangay,
  f.status,   
  s.sector_name,
  fr.name as farmer_name
FROM farms f
JOIN sectors s ON f.sector_id = s.sector_id
JOIN farmers fr ON f.farmer_id = fr.id
WHERE f.status = 'Active'  
`;

// Add additional WHERE clause if farmerId is provided
if (farmerId) {
farmQuery += ` AND f.farmer_id = ${pool.escape(farmerId)}`;
}

// Add ordering
farmQuery += ` ORDER BY f.farm_name ASC`;

    const [farms] = await pool.query(farmQuery);

    // Get all products to create a mapping
    const [products] = await pool.query('SELECT id, name FROM farm_products');
    const productMap = {};
    products.forEach(product => {
      productMap[product.id] = product.name;
    });

    // Process farms to include product names with IDs
    const processedFarms = farms.map(farm => {
      let productEntries = [];
      try {
        // Parse the products JSON array if it exists
        const productIds = JSON.parse(farm.products || '[]');
        productEntries = productIds.map(id => {
          const productName = productMap[id];
          return productName ? `${id}: ${productName}` : null;
        }).filter(Boolean);
      } catch (e) {
        console.error('Error parsing products for farm', farm.farm_id, e);
      }

      return {
        id: farm.farm_id,
        vertices: JSON.parse(farm.vertices || '[]'),
        name: farm.farm_name,
        farmerId: farm.farmer_id,
        owner: `${farm.farmer_id}: ${farm.farmer_name}`,
        farmerName: farm.farmer_name,
        products: productEntries,
        color: getSectorColor(farm.sector_id),
        area: farm.area ? parseFloat(farm.area) : 0,
        description: farm.description,
        sectorId: farm.sector_id,
        sectorName: farm.sector_name,
        pinStyle: farm.sector_name,
        parentBarangay: farm.parentBarangay
      };
    });

    res.json({
      success: true,
      farms: processedFarms
    });

  } catch (error) {
    console.error('Failed to fetch farms:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch farms',
      error: {
        code: 'FARM_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});



router.get('/farms', async (req, res) => {
  try {
    // Get farmerId from query parameters if it exists
    const { farmerId } = req.query;

    // Base query
    let farmQuery = `
      SELECT 
        f.farm_id,
        f.vertices,
        f.farm_name,
        f.farmer_id,
        f.products,
        f.area,
        f.description,
        f.status,
        f.sector_id, 
        f.parentBarangay,
        s.sector_name,
        fr.name as farmer_name
      FROM farms f
      JOIN sectors s ON f.sector_id = s.sector_id
      JOIN farmers fr ON f.farmer_id = fr.id
    `;

    // Add WHERE clause if farmerId is provided
    if (farmerId) {
      farmQuery += ` WHERE f.farmer_id = ${pool.escape(farmerId)}`;
    }

    // Add ordering
    farmQuery += ` ORDER BY f.farm_name ASC`;

    const [farms] = await pool.query(farmQuery);

    // Get all products to create a mapping
    const [products] = await pool.query('SELECT id, name FROM farm_products');
    const productMap = {};
    products.forEach(product => {
      productMap[product.id] = product.name;
    });

    // Process farms to include product names with IDs
    const processedFarms = farms.map(farm => {
      let productEntries = [];
      try {
        // Parse the products JSON array if it exists
        const productIds = JSON.parse(farm.products || '[]');
        productEntries = productIds.map(id => {
          const productName = productMap[id];
          return productName ? `${id}: ${productName}` : null;
        }).filter(Boolean);
      } catch (e) {
        console.error('Error parsing products for farm', farm.farm_id, e);
      }

      return {
        id: farm.farm_id,
        vertices: JSON.parse(farm.vertices || '[]'),
        name: farm.farm_name,
        farmerId: farm.farmer_id,
        owner: `${farm.farmer_id}: ${farm.farmer_name}`,
        farmerName: farm.farmer_name,
        products: productEntries,
        color: getSectorColor(farm.sector_id),
        area: farm.area ? parseFloat(farm.area) : 0,
        description: farm.description,
        status:farm.status,
        sectorId: farm.sector_id,
        sectorName: farm.sector_name,
        pinStyle: farm.sector_name,
        parentBarangay: farm.parentBarangay
      };
    });

    res.json({
      success: true,
      farms: processedFarms
    });

  } catch (error) {
    console.error('Failed to fetch farms:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch farms',
      error: {
        code: 'FARM_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});




router.get('/products', authenticate, async (req, res) => {
  try {

    let query = `
     SELECT 
  p.id,
  p.name,
  p.description,
  p.imgUrl,
  p.created_at,
  p.updated_at,
  s.sector_name
FROM farm_products p
JOIN sectors s ON p.sector_id = s.sector_id 
    `;

    const params = [];



    query += ' ORDER BY  p.name';

    const [products] = await pool.query(query, params);

    res.json({
      success: true,
      products: products.map(product => ({
        id: product.id,
        name: product.name,
        description: product.description,
        sector: product.sector_name,
        imageUrl: product.imgUrl, // Make sure this column is correctly named in the DB
        createdAt: product.created_at,
        updatedAt: product.updated_at
      }))
    });

  } catch (error) {
    console.error('Failed to fetch products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: {
        code: 'PRODUCT_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});



router.get('/farmers', authenticate, async (req, res) => {
  try {
    const [farmers] = await pool.query(`
      SELECT 
        f.id,
        f.user_id,
        f.firstname,
        f.middlename,
        f.surname,
        f.extension,
        f.assoc_id,
        f.email,
        f.phone,
        f.address,
        f.imageUrl,
        f.created_at,
        f.updated_at,
        s.sector_name as sector,
        s.sector_id as sectorId, 

        a.name as AssociationName,
        a.id as AssociationId, 

        f.barangay,
        f.phone,        
        f.farm_name as farmName,  
        f.total_land_area          
      FROM farmers f
      LEFT JOIN sectors s ON f.sector_id = s.sector_id 
       LEFT JOIN associations a ON f.assoc_id = a.id 
      ORDER BY f.created_at DESC
    `);

    res.json({
      success: true,
      farmers: farmers.map(farmer => ({
        id: farmer.id,
        fullName: {
          firstname: farmer.firstname,
          middlename: farmer.middlename || null,
          surname: farmer.surname || null,
          extension: farmer.extension || null
        },
        association:farmer.AssociationName,
        userId: farmer.user_id,
        name: `${farmer.firstname}${farmer.middlename ? ' ' + farmer.middlename : ''}${farmer.surname ? ' ' + farmer.surname : ''}${farmer.extension ? ' ' + farmer.extension : ''}`,
        email: farmer.email,
        phone: farmer.phone,
        address: farmer.address,
        sector: farmer.sector,
        sectorId: farmer.sectorId ? String(farmer.sectorId) : null,
        imageUrl: farmer.imageUrl,
        barangay: farmer.barangay || null,
        contact: farmer.phone,
        farmName: farmer.farmName,
        hectare: parseFloat(farmer.total_land_area),
        createdAt: farmer.created_at,
        updatedAt: farmer.updated_at
      }))
    });
  } catch (error) {
    console.error('Failed to fetch farmers:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch farmers' });
  }
});


router.get('/farmer-statistics', async (req, res) => {
  try {
    const { year } = req.query;
    const userSectorId = req.user?.dbUser?.sector_id;

    // Helper function to add filters
    const addFilters = (baseQuery, options = {}) => {
      let query = baseQuery;
      const params = [];
      const conditions = [];

      if (year) {
        conditions.push(`YEAR(f.${options.dateField || 'created_at'}) = ?`);
        params.push(year);
      }

      if (userSectorId) {
        conditions.push(`f.sector_id = ?`);
        params.push(userSectorId);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      return { query, params };
    };

    // 1. Total farmers count
    const totalQuery = addFilters(`
      SELECT COUNT(*) as totalFarmers 
      FROM farmers f
    `);
    const [totalResult] = await pool.query(totalQuery.query, totalQuery.params);

    // 2. Active farmers (assuming status field exists)
    const activeQuery = addFilters(`
      SELECT COUNT(*) as activeFarmers 
      FROM farmers f 
      WHERE f.status = 'active'
    `);
    const [activeResult] = await pool.query(activeQuery.query, activeQuery.params);

    // 3. Unregistered farmers (those with no user account)
    const unregisteredQuery = addFilters(`
      SELECT COUNT(*) as unregisteredFarmers 
      FROM farmers f 
      WHERE f.user_id IS NULL OR f.user_id = 0
    `);
    const [unregisteredResult] = await pool.query(unregisteredQuery.query, unregisteredQuery.params);

    // 4. Registered farmers (with user account)
    const registeredQuery = addFilters(`
      SELECT COUNT(*) as registeredFarmers 
      FROM farmers f 
      WHERE f.user_id IS NOT NULL AND f.user_id != 0
    `);
    const [registeredResult] = await pool.query(registeredQuery.query, registeredQuery.params);

    // 5. New farmers this month (if year is current, otherwise count for selected year)
    let newFarmersQuery;
    let newFarmersParams = [];

    if (year && year !== new Date().getFullYear().toString()) {
      newFarmersQuery = `
        SELECT COUNT(*) as newFarmers 
        FROM farmers f
        WHERE YEAR(f.created_at) = ?
      `;
      newFarmersParams = [year];

      if (userSectorId) {
        newFarmersQuery += ` AND f.sector_id = ?`;
        newFarmersParams.push(userSectorId);
      }
    } else {
      newFarmersQuery = `
        SELECT COUNT(*) as newFarmers 
        FROM farmers f
        WHERE f.created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
      `;

      if (year) {
        newFarmersQuery += ` AND YEAR(f.created_at) = ?`;
        newFarmersParams = [year];
      }
      if (userSectorId) {
        newFarmersQuery += year ? ` AND f.sector_id = ?` : ` WHERE f.sector_id = ?`;
        newFarmersParams.push(userSectorId);
      }
    }

    const [newFarmersResult] = await pool.query(newFarmersQuery, newFarmersParams);

    // Format the response
    const responseData = {
      totalFarmers: totalResult[0]?.totalFarmers || 0,
      activeFarmers: activeResult[0]?.activeFarmers || 0,
      unregisteredFarmers: unregisteredResult[0]?.unregisteredFarmers || 0,
      registeredFarmers: registeredResult[0]?.registeredFarmers || 0,
      newFarmers: newFarmersResult[0]?.newFarmers || 0,
      year: year || 'all-time',
      sector: userSectorId || 'all-sectors'
    };

    res.json({
      success: true,
      statistics: responseData
    });

  } catch (error) {
    console.error('Failed to fetch farmer statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch farmer statistics',
      error: {
        code: 'FARMER_STATS_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage || 'No SQL error message'
      }
    });
  }
});



router.get('/top-contributors', async (req, res) => {
  try {
    // First verify basic table access
    const [farmerCount] = await pool.query('SELECT COUNT(*) as count FROM farmers');
    const [yieldCount] = await pool.query('SELECT COUNT(*) as count FROM farmer_yield WHERE volume > 0 AND status = "Accepted"');
    
    // If no data exists, return early with informative message
    if (farmerCount[0].count === 0 || yieldCount[0].count === 0) {
      return res.json({
        success: true,
        message: 'No farmer data or accepted yield records available',
        contributors: []
      });
    }

    // Then run the main query
    const [contributors] = await pool.query(`
      SELECT 
        f.id as farmer_id,
        f.firstname,
        f.middlename,
        f.surname,
        f.extension,
        f.barangay,
        SUM(fy.volume) as total_volume,
        COUNT(fy.id) as yield_count,
        GROUP_CONCAT(DISTINCT s.sector_name SEPARATOR ', ') as sectors
      FROM farmers f
      JOIN farmer_yield fy ON f.id = fy.farmer_id
      JOIN farm_products p ON fy.product_id = p.id
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE fy.volume > 0 AND fy.status = "Accepted"
      GROUP BY f.id
      ORDER BY total_volume DESC
      LIMIT 6
    `);

    res.json({
      success: true,
      contributors: contributors.map(contributor => ({
        farmerId: contributor.farmer_id,
        farmerName: `${contributor.firstname}${contributor.middlename ? ' ' + contributor.middlename : ''}${contributor.surname ? ' ' + contributor.surname : ''}${contributor.extension ? ' ' + contributor.extension : ''}`,
        totalValue: parseFloat(contributor.total_volume) || 0,
        yieldCount: contributor.yield_count,
        barangay: contributor.barangay,
        sectors: contributor.sectors
      }))
    });
  } catch (error) {
    console.error('Failed to fetch top contributors:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch top contributors',
      error: {
        code: 'TOP_CONTRIBUTORS_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});

router.get('/top-test', async (req, res) => {
  


  try {
    // Simple query to test the connection
    const [result] = await pool.query('SELECT 1 + 1 AS solution');
    
    res.json({
      success: true,
      message: 'Database connection is workingsss',
      data: {
        testCalculation: result[0].solution, // Should be 2
        serverTime: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Database connection test failed:', error);
    res.status(500).json({
      success: false,
      message: 'Database connection test failed',
      error: error.message
    });
  }



});


router.post('/users', authenticate, async (req, res) => {
  let firebaseUser;
  let mysqlUserInsertResult;
  let farmerUpdateResult;

  try {
    // 1. Verify admin privileges
    if (req.user.dbUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: Only admin users can create new accounts',
      });
    }

    // 2. Get data from request
    const { email, password, name, role, idToken, phone, barangay, sectorId, imageUrl, farmerId } = req.body;

    // 3. Validate required fields
    if (!email || !name || !role) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: email, name, and role are required',
      });
    }

    // Check if email already exists in database
    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Email already in use',
      });
    }

    // 4. Handle Google account creation
    if (idToken) {
      try {
        // Verify Google ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);

        // Update existing user or create new one
        firebaseUser = await admin.auth().updateUser(decodedToken.uid, {
          email,
          displayName: name,
          emailVerified: true,
        }).catch(async () => {
          // Create new user if doesn't exist
          return await admin.auth().createUser({
            uid: decodedToken.uid,
            email,
            displayName: name,
            emailVerified: true,
          });
        });

      } catch (googleError) {
        console.error('Google user creation failed:', googleError);
        return res.status(400).json({
          success: false,
          message: 'Google authentication failed',
          error: googleError.message,
        });
      }
    }
    // 5. Handle email/password account creation
    else if (password) {
      try {
        firebaseUser = await admin.auth().createUser({
          email,
          password,
          displayName: name,
          emailVerified: false, // Will need email verification
        });
      } catch (emailError) {
        console.error('Email user creation failed:', emailError);
        return res.status(400).json({
          success: false,
          message: 'Email user creation failed',
          error: emailError.message,
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        message: 'Either password or Google ID token is required',
      });
    }

    // 6. Set custom claims for role
    await admin.auth().setCustomUserClaims(firebaseUser.uid, { role });

    // 7. Add to MySQL users table
    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    [mysqlUserInsertResult] = await pool.query(
      `INSERT INTO users 
      (firebase_uid, email, name, fname, lname, role, sector_id, password) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        firebaseUser.uid,
        email,
        name,
        firstName,
        lastName,
        role,
        sectorId || null,
        password || null // Store plaintext password (NOT RECOMMENDED)
      ]
    );

    // 8. If role is farmer, handle farmer record
    if (role.toLowerCase() === 'farmer') {
      if (farmerId) {
        // Update existing farmer record to link to the new user
        [farmerUpdateResult] = await pool.query(
          `UPDATE farmers 
           SET user_id = ?, updated_at = NOW()
           WHERE id = ?`,
          [mysqlUserInsertResult.insertId, farmerId]
        );

        if (farmerUpdateResult.affectedRows === 0) {
          throw new Error('Farmer not found with the provided farmerId');
        }
      } else {
        // Create new farmer record (existing code)
        const DEFAULT_IMAGE_URL = 'https://res.cloudinary.com/dk41ykxsq/image/upload/v1745590990/cHJpdmF0ZS9sci9pbWFnZXMvd2Vic2l0ZS8yMDIzLTAxL3JtNjA5LXNvbGlkaWNvbi13LTAwMi1wLnBuZw-removebg-preview_myrmrf.png';
        const DEFAULT_PHONE = '---';

        // Parse the full name into components
        let firstname, middlename, surname, extension;

        if (nameParts.length === 1) {
          firstname = nameParts[0];
        } else if (nameParts.length === 2) {
          [firstname, surname] = nameParts;
        } else if (nameParts.length === 3) {
          [firstname, middlename, surname] = nameParts;
        } else if (nameParts.length >= 4) {
          // Assuming the last part is extension if it's very short (like Jr., Sr., III)
          const lastPart = nameParts[nameParts.length - 1];
          if (lastPart.length <= 4 || ['jr', 'sr', 'ii', 'iii', 'iv'].includes(lastPart.toLowerCase())) {
            extension = lastPart;
            surname = nameParts[nameParts.length - 2];
            middlename = nameParts.slice(1, nameParts.length - 2).join(' ');
            firstname = nameParts[0];
          } else {
            surname = nameParts.pop();
            middlename = nameParts.slice(1).join(' ');
            firstname = nameParts[0];
          }
        }

        // Insert into farmers table
        [farmerUpdateResult] = await pool.query(
          `INSERT INTO farmers 
           (user_id, name, firstname, middlename, surname, extension, email, phone, barangay, sector_id, imageUrl, created_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            mysqlUserInsertResult.insertId, // Link to the users table
            name,
            firstname,
            middlename || null,
            surname || null,
            extension || null,
            email,
            phone || DEFAULT_PHONE,
            barangay || null,
            sectorId || null,
            DEFAULT_IMAGE_URL
          ]
        );
      }
    }

    // 9. Return success response
    const responseData = {
      success: true,
      message: 'User account created successfully',
      user: {
        firebase_uid: firebaseUser.uid,
        email,
        name,
        role,
        auth_provider: idToken ? 'google' : 'email',
      },
    };

    // If farmer was created/updated, add farmer info to response
    if (role.toLowerCase() === 'farmer' && (farmerUpdateResult?.insertId || farmerId)) {
      const farmerRecordId = farmerId || farmerUpdateResult.insertId;

      const [farmerData] = await pool.query(
        `SELECT 
          f.id,
          f.name,
          f.firstname,
          f.middlename,
          f.surname,
          f.extension,
          f.email,
          f.phone,
          f.barangay,
          f.imageUrl,
          f.created_at,
          f.updated_at,
          s.sector_name as sector,
          s.sector_id as sectorId
        FROM farmers f
        LEFT JOIN sectors s ON f.sector_id = s.sector_id
        WHERE f.id = ?`,
        [farmerRecordId]
      );

      if (farmerData.length > 0) {
        responseData.farmer = {
          id: farmerData[0].id,
          fullName: {
            firstname: farmerData[0].firstname,
            middlename: farmerData[0].middlename || null,
            surname: farmerData[0].surname || null,
            extension: farmerData[0].extension || null
          },
          name: `${farmerData[0].firstname}${farmerData[0].middlename ? ' ' + farmerData[0].middlename : ''}${farmerData[0].surname ? ' ' + farmerData[0].surname : ''}${farmerData[0].extension ? ' ' + farmerData[0].extension : ''}`,
          email: farmerData[0].email,
          phone: farmerData[0].phone,
          barangay: farmerData[0].barangay,
          sector: farmerData[0].sector,
          sectorId: farmerData[0].sectorId ? String(farmerData[0].sectorId) : null,
          imageUrl: farmerData[0].imageUrl,
          createdAt: farmerData[0].created_at,
          updatedAt: farmerData[0].updated_at
        };
      }
    }

    res.status(201).json(responseData);

  } catch (error) {
    console.error('User creation error:', error);

    // Rollback operations in reverse order
    if (farmerUpdateResult?.insertId) {
      try {
        await pool.query('DELETE FROM farmers WHERE id = ?', [farmerUpdateResult.insertId]);
      } catch (deleteError) {
        console.error('Failed to rollback farmer entry:', deleteError);
      }
    }

    if (mysqlUserInsertResult?.insertId) {
      try {
        await pool.query('DELETE FROM users WHERE id = ?', [mysqlUserInsertResult.insertId]);
      } catch (deleteError) {
        console.error('Failed to rollback MySQL user:', deleteError);
      }
    }

    if (firebaseUser?.uid) {
      try {
        await admin.auth().deleteUser(firebaseUser.uid);
      } catch (deleteError) {
        console.error('Failed to rollback Firebase user:', deleteError);
      }
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error during user creation',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});


// POST create new farmer
router.post('/farmers', authenticate, async (req, res) => {
  try {
    const { name, email, phone, barangay, sectorId, imageUrl } = req.body;
    const DEFAULT_IMAGE_URL = 'https://res.cloudinary.com/dk41ykxsq/image/upload/v1745590990/cHJpdmF0ZS9sci9pbWFnZXMvd2Vic2l0ZS8yMDIzLTAxL3JtNjA5LXNvbGlkaWNvbi13LTAwMi1wLnBuZw-removebg-preview_myrmrf.png';
    const DEFAULT_EMAIL = '---';
    const DEFAULT_PHONE = '---';

    // Validate required fields - name is now required
    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        required: ['name']
      });
    }

    // Parse the full name into components
    const nameParts = name.trim().split(/\s+/);
    let firstname, middlename, surname, extension;

    if (nameParts.length === 1) {
      firstname = nameParts[0];
    } else if (nameParts.length === 2) {
      [firstname, surname] = nameParts;
    } else if (nameParts.length === 3) {
      [firstname, middlename, surname] = nameParts;
    } else if (nameParts.length >= 4) {
      // Assuming the last part is extension if it's very short (like Jr., Sr., III)
      const lastPart = nameParts[nameParts.length - 1];
      if (lastPart.length <= 4 || ['jr', 'sr', 'ii', 'iii', 'iv'].includes(lastPart.toLowerCase())) {
        extension = lastPart;
        surname = nameParts[nameParts.length - 2];
        middlename = nameParts.slice(1, nameParts.length - 2).join(' ');
        firstname = nameParts[0];
      } else {
        surname = nameParts.pop();
        middlename = nameParts.slice(1).join(' ');
        firstname = nameParts[0];
      }
    }

    // Only check email uniqueness if email is provided and not empty or default
    if (email && email.trim() !== '' && email.trim() !== DEFAULT_EMAIL) {
      const [emailCheck] = await pool.query(
        'SELECT id FROM farmers WHERE email = ?',
        [email]
      );

      if (emailCheck.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Email already exists',
          error: {
            code: 'EMAIL_EXISTS',
            details: `Farmer with email ${email} already registered`
          }
        });
      }
    }

    // Use default values if none provided
    const farmerImageUrl = imageUrl || DEFAULT_IMAGE_URL;
    const farmerEmail = email || DEFAULT_EMAIL;
    const farmerPhone = phone || DEFAULT_PHONE;

    // Insert new farmer - handle empty name parts by setting to NULL
    const [result] = await pool.query(
      `INSERT INTO farmers 
       (name , firstname, middlename, surname, extension, email, phone, barangay, sector_id, imageUrl, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        name,
        firstname,
        middlename || null,
        surname || null,
        extension || null,
        farmerEmail,
        farmerPhone,
        barangay,
        sectorId,
        farmerImageUrl
      ]
    );

    // Get the newly created farmer with sector name
    const [newFarmer] = await pool.query(
      `SELECT 
        f.id,
        f.name,
        f.firstname,
        f.middlename,
        f.surname,
        f.extension,
        f.email,
        f.phone,
        f.address,
        f.imageUrl,
        f.created_at,
        f.updated_at,
        s.sector_name as sector,
        s.sector_id as sectorId
      FROM farmers f
      LEFT JOIN sectors s ON f.sector_id = s.sector_id
      WHERE f.id = ?`,
      [result.insertId]
    );

    if (newFarmer.length === 0) {
      throw new Error('Failed to retrieve created farmer');
    }

    res.status(201).json({
      success: true,
      farmer: {
        id: newFarmer[0].id,
        fullName: {
          firstname: newFarmer[0].firstname,
          middlename: newFarmer[0].middlename || null,
          surname: newFarmer[0].surname || null,
          extension: newFarmer[0].extension || null
        },
        name: `${newFarmer[0].firstname}${newFarmer[0].middlename ? ' ' + newFarmer[0].middlename : ''}${newFarmer[0].surname ? ' ' + newFarmer[0].surname : ''}${newFarmer[0].extension ? ' ' + newFarmer[0].extension : ''}`,
        email: newFarmer[0].email,
        phone: newFarmer[0].phone,
        address: newFarmer[0].address,
        barangay: newFarmer[0].barangay,
        sector: newFarmer[0].sector,
        sectorId: newFarmer[0].sectorId ? String(newFarmer[0].sectorId) : null,
        imageUrl: newFarmer[0].imageUrl,
        createdAt: newFarmer[0].created_at,
        updatedAt: newFarmer[0].updated_at
      }
    });

  } catch (error) {
    console.error('Failed to add farmer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add farmer',
      error: {
        code: 'FARMER_CREATION_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});


router.delete('/users/:id', authenticate, async (req, res) => {
  try {
    // 1. Verify admin privileges
    if (req.user.dbUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: Only admin users can delete accounts',
      });
    }

    const userId = req.params.id;

    // 2. Get user from MySQL to get Firebase UID and check if it's linked to a farmer
    const [users] = await pool.query(
      'SELECT firebase_uid, role FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found in database',
      });
    }

    const firebaseUid = users[0].firebase_uid;
    const userRole = users[0].role;

    // 3. If user is a farmer, find and update the linked farmer record
    if (userRole.toLowerCase() === 'farmer') {
      await pool.query(
        'UPDATE farmers SET user_id = 0 WHERE user_id = ?',
        [userId]
      );
    }

    // 4. Delete from Firebase Auth
    try {
      await admin.auth().deleteUser(firebaseUid);
    } catch (firebaseError) {
      // If Firebase user not found, we might still want to delete the DB record
      if (firebaseError.code !== 'auth/user-not-found') {
        throw firebaseError;
      }
      console.warn(`Firebase user ${firebaseUid} not found, but proceeding with DB deletion`);
    }

    // 5. Delete from MySQL
    await pool.query(
      'DELETE FROM users WHERE id = ?',
      [userId]
    );

    // 6. Return success response
    res.status(200).json({
      success: true,
      message: 'User account deleted successfully',
      deletedUserId: userId,
      deletedFirebaseUid: firebaseUid,
    });

  } catch (error) {
    console.error('User deletion error:', error);

    res.status(500).json({
      success: false,
      message: 'Internal server error during user deletion',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});














// Helper function to get color based on sector_id
const getSectorColor = (sectorId) => {
  switch (parseInt(sectorId)) {
    case 1: // Rice
      return 0xFF4CAF50;  
    case 2: // Corn
      return 0x7FFFFF00; 
    case 3: // highvaluecrop
      return 0xFF9C27B0;  
    case 4: // livestock
      return 0xFFFF5722; // Deep orange with 0.5 opacity equivalent
    case 5: // fishery
      return 0xFF2196F3; 
    case 6: // organic
      return 0xFF9E9E9E; // Grey with 0.5 opacity equivalent
    default:
      return 0xFF2196F3; // Default blue color
  }
};

// DELETE farm by ID
router.delete('/farms/:id', async (req, res) => {
  const farmId = req.params.id;

  if (!farmId) {
    return res.status(400).json({
      success: false,
      message: 'Missing farm ID'
    });
  }

  try {
    // Check if the farm exists
    const [existingFarm] = await pool.query(
      'SELECT * FROM farms WHERE farm_id = ?',
      [farmId]
    );

    if (existingFarm.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farm not found'
      });
    }

    // Delete the farm
    await pool.query(
      'DELETE FROM farms WHERE farm_id = ?',
      [farmId]
    );

    res.json({
      success: true,
      message: `Farm with ID ${farmId} deleted successfully`
    });
  } catch (error) {
    console.error('Failed to delete farm:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete farm',
      error: {
        code: 'FARM_DELETE_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});


// POST create new farm
router.post('/farms/', async (req, res) => {
  try {
    const {
      name,
      vertices,
      barangay,
      sectorId,
      farmerId,
      products,
      description,
      pinStyle,
      area
    } = req.body;

    // Validate required fields
    if (!name || !vertices) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, vertices'
      });
    }

    // Convert vertices to the correct format if needed
    const formattedVertices = Array.isArray(vertices[0])
      ? vertices.map(([lat, lng]) => ({ lat, lng }))
      : vertices;

      const insertQuery = `
      INSERT INTO farms (
        farm_name,
        vertices,
        parentBarangay,
        sector_id,
        farmer_id,
        products,
        area,
        description,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', NOW(), NOW())
    `;
    
    const [result] = await pool.query(insertQuery, [
      name,
      JSON.stringify(formattedVertices),
      barangay || 'San Diego',
      sectorId || 5,
      farmerId || null,
      JSON.stringify(products || ["Rice"]),
      area,
      description || null
      // status is not in the parameters as it's hardcoded as 'Active'
    ]);

    // Get the newly created farm
    const [farm] = await pool.query(`
      SELECT 
        f.*,
        s.sector_name
      FROM farms f
      JOIN sectors s ON f.sector_id = s.sector_id
      WHERE f.farm_id = ?
    `, [result.insertId]);

    if (farm.length === 0) {
      throw new Error('Failed to retrieve created farm');
    }

    const createdFarm = farm[0];
    const parsedVertices = JSON.parse(createdFarm.vertices || '[]');

    res.status(201).json({
      success: true,
      farm: {
        id: createdFarm.farm_id,
        vertices: parsedVertices,
        name: createdFarm.farm_name,
        farmerId: createdFarm.farmer_id,
        products: JSON.parse(createdFarm.products || '[]'),
        color: getSectorColor(createdFarm.sector_id),
        area: createdFarm.area ? parseFloat(createdFarm.area) : 0,
        description: createdFarm.description,
        sectorId: createdFarm.sector_id,
        sectorName: createdFarm.sector_name,
        pinStyle: pinStyle || createdFarm.sector_name.toLowerCase(),
        parentBarangay: createdFarm.parentBarangay
      }
    });

  } catch (error) {
    console.error('Failed to create farm:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create farm',
      error: {
        code: 'FARM_CREATE_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});

// PUT update farm
router.put('/farms/:id', async (req, res) => {
  try {
    const farmId = req.params.id;
    const {
      name,
      vertices,
      barangay,
      sectorId,
      owner,  // Changed from farmerId to owner
      products,
      description,
      pinStyle,
      area
    } = req.body;

    // Validate required fields
    if (!name || !vertices || !sectorId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, vertices,   or sectorId'
      });
    }

    // Extract farmerId from owner string (format: "id: name")
    const farmerId = owner ? parseInt(owner.split(':')[0].trim()) : null;

    // Convert vertices to the correct format if needed
    const formattedVertices = Array.isArray(vertices[0])
      ? vertices.map(([lat, lng]) => ({ lat, lng }))
      : vertices;

    // Convert products to array of numbers (extract IDs from "id: name" strings)
    const productIds = products
      ? products.map(product => {
        if (typeof product === 'string') {
          return parseInt(product.split(':')[0].trim());
        }
        return product; // if it's already a number
      })
      : [];

    const updateQuery = `
      UPDATE farms SET
        farm_name = ?,
        vertices = ?,
        parentBarangay = ?,
        sector_id = ?,
        farmer_id = ?,
        products = ?,
        area = ?,
        description = ?,
        updated_at = NOW()
      WHERE farm_id = ?
    `;

    await pool.query(updateQuery, [
      name,
      JSON.stringify(formattedVertices),
      barangay,
      sectorId,
      farmerId || null,
      JSON.stringify(productIds), // Store only the IDs
      area,
      description || null,
      farmId
    ]);

    // Get the updated farm with product names
    // Modified query to work with MariaDB
    const [farm] = await pool.query(`
      SELECT 
        f.*,
        s.sector_name,
        (
          SELECT GROUP_CONCAT(p.name)
          FROM farm_products p
          WHERE FIND_IN_SET(p.id, REPLACE(REPLACE(REPLACE(f.products, '[', ''), ']', ''), ' ', ''))
        ) as product_names
      FROM farms f
      JOIN sectors s ON f.sector_id = s.sector_id
      WHERE f.farm_id = ?
    `, [farmId]);

    if (farm.length === 0) {
      throw new Error('Farm not found');
    }

    const updatedFarm = farm[0];
    const parsedVertices = JSON.parse(updatedFarm.vertices || '[]');
    const productNames = updatedFarm.product_names
      ? updatedFarm.product_names.split(',')
      : [];

    res.json({
      success: true,
      farm: {
        id: updatedFarm.farm_id,
        vertices: parsedVertices,
        name: updatedFarm.farm_name,
        farmerId: updatedFarm.farmer_id,
        products: productNames, // Return only product names
        color: getSectorColor(updatedFarm.sector_id),
        area: updatedFarm.area ? parseFloat(updatedFarm.area) : 0,
        description: updatedFarm.description,
        sectorId: updatedFarm.sector_id,
        sectorName: updatedFarm.sector_name,
        pinStyle: pinStyle || updatedFarm.sector_name.toLowerCase(),
        parentBarangay: updatedFarm.parentBarangay
      }
    });

  } catch (error) {
    console.error('Failed to update farm:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update farm',
      error: {
        code: 'FARM_UPDATE_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});

router.put('/farmsProfile/:id', async (req, res) => {
  try {
    const farmId = req.params.id;
    const {
      name,
      barangay,
      sectorId,
      farmerId,
      products,
      description,
      pinStyle,
      status = 'Inactive' // Default to 'Inactive' if not provided
    } = req.body;

    // Validate required fields
    if (!name || !sectorId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name or sectorId'
      });
    }

    // Convert products to array of numbers (extract IDs from "id: name" strings)
    const productIds = products
      ? products.map(product => {
        if (typeof product === 'string') {
          return parseInt(product.split(':')[0].trim());
        }
        return product; // if it's already a number
      })
      : [];

    const updateQuery = `
      UPDATE farms SET
        farm_name = ?, 
        parentBarangay = ?,
        sector_id = ?,
        farmer_id = ?,
        products = ?, 
        description = ?, 
        status = ?,
        updated_at = NOW()
      WHERE farm_id = ?
    `;

    await pool.query(updateQuery, [
      name,
      barangay,
      sectorId,
      farmerId || null,
      JSON.stringify(productIds),
      description || null,
      status, // Use the provided status or default
      farmId
    ]);

    // Get the updated farm with the same structure as the GET endpoint
    const farmQuery = `
      SELECT 
        f.farm_id,
        f.vertices,
        f.farm_name,
        f.farmer_id,
        f.products,
        f.area,
        f.description,
        f.sector_id, 
        f.parentBarangay,
        s.sector_name,
        fr.name as farmer_name,
        f.status
      FROM farms f
      JOIN sectors s ON f.sector_id = s.sector_id
      JOIN farmers fr ON f.farmer_id = fr.id
      WHERE f.farm_id = ?
      LIMIT 1
    `;

    const [farms] = await pool.query(farmQuery, [farmId]);

    if (farms.length === 0) {
      throw new Error('Farm not found');
    }

    const farm = farms[0];

    // Get all products to create a mapping
    const [productsData] = await pool.query('SELECT id, name FROM farm_products');
    const productMap = {};
    productsData.forEach(product => {
      productMap[product.id] = product.name;
    });

    // Process the farm to include product names with IDs
    let productEntries = [];
    try {
      // Parse the products JSON array if it exists
      const productIds = JSON.parse(farm.products || '[]');
      productEntries = productIds.map(id => {
        const productName = productMap[id];
        return productName ? `${id}: ${productName}` : null;
      }).filter(Boolean);
    } catch (e) {
      console.error('Error parsing products for farm', farm.farm_id, e);
    }

    const processedFarm = {
      id: farm.farm_id,
      vertices: JSON.parse(farm.vertices || '[]'),
      name: farm.farm_name,
      farmerId: farm.farmer_id,
      owner: `${farm.farmer_id}: ${farm.farmer_name}`,
      farmerName: farm.farmer_name,
      products: productEntries,
      color: getSectorColor(farm.sector_id),
      area: farm.area ? parseFloat(farm.area) : 0,
      description: farm.description,
      sectorId: farm.sector_id,
      sectorName: farm.sector_name,
      pinStyle: pinStyle || farm.sector_name.toLowerCase(),
      parentBarangay: farm.parentBarangay,
      status: farm.status // Include the status in the response
    };

    res.json({
      success: true,
      farm: processedFarm
    });

  } catch (error) {
    console.error('Failed to update farm:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update farm',
      error: {
        code: 'FARM_UPDATE_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});
  


router.get('/farms/:id', async (req, res) => {
  try {
    const farmId = req.params.id;

    // First, get the specific farm
    const farmQuery = `
      SELECT 
        f.farm_id,
        f.vertices,
        f.farm_name,
        f.farmer_id,
        f.status,
        f.products,
        f.area,
        f.description,
        f.sector_id, 
        f.parentBarangay,
        s.sector_name,
        fr.name as farmer_name
      FROM farms f
      JOIN sectors s ON f.sector_id = s.sector_id
      JOIN farmers fr ON f.farmer_id = fr.id
      WHERE f.farm_id = ?
      LIMIT 1
    `;

    const [farms] = await pool.query(farmQuery, [farmId]);

    if (farms.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farm not found'
      });
    }

    const farm = farms[0];

    // Get all products to create a mapping
    const [products] = await pool.query('SELECT id, name FROM farm_products');
    const productMap = {};
    products.forEach(product => {
      productMap[product.id] = product.name;
    });

    // Process the farm to include product names with IDs
    let productEntries = [];
    try {
      // Parse the products JSON array if it exists
      const productIds = JSON.parse(farm.products || '[]');
      productEntries = productIds.map(id => {
        const productName = productMap[id];
        return productName ? `${id}: ${productName}` : null;
      }).filter(Boolean);
    } catch (e) {
      console.error('Error parsing products for farm', farm.farm_id, e);
    }

    const processedFarm = {
      id: farm.farm_id,
      vertices: JSON.parse(farm.vertices || '[]'),
      name: farm.farm_name,
      farmerId: farm.farmer_id,
      owner: `${farm.farmer_id}: ${farm.farmer_name}`,
      farmerName: farm.farmer_name,
      products: productEntries,
      color: getSectorColor(farm.sector_id),
      area: farm.area ? parseFloat(farm.area) : 0,
      description: farm.description,
      sectorId: farm.sector_id,
      sectorName: farm.sector_name,
      status:farm.status,
      pinStyle: farm.sector_name.toLowerCase(),
      parentBarangay: farm.parentBarangay
    };

    res.json({
      success: true,
      farm: processedFarm
    });

  } catch (error) {
    console.error('Failed to fetch farm:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch farm',
      error: {
        code: 'FARM_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});



router.get('/farms/by-product/:productId', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const currentYear = new Date().getFullYear();

    if (isNaN(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID'
      });
    }

    const query = `
      SELECT 
        f.farm_id as id,
        f.farm_name as name,
        f.parentBarangay ,
        f.products,
        f.area,
        f.description,
        f.farmer_id,
        s.sector_name as sector,
        fr.name as owner
      FROM farms f
      JOIN sectors s ON f.sector_id = s.sector_id
      JOIN farmers fr ON f.farmer_id = fr.id
      WHERE JSON_CONTAINS(f.products, ?)
    `;

    const [farms] = await pool.query(query, [JSON.stringify(productId)]);

    // Get product names for mapping
    const [products] = await pool.query('SELECT id, name FROM farm_products');
    const productMap = {};
    products.forEach(product => {
      productMap[product.id] = product.name;
    });

    // Get yields for current year for each farm
    const farmIds = farms.map(farm => farm.id);
    let yearlyYields = {};

    if (farmIds.length > 0) {
      const [yields] = await pool.query(`
        SELECT farm_id, SUM(volume) as total_volume, SUM(Value) as total_value
        FROM farmer_yield
        WHERE product_id = ? 
          AND farm_id IN (?)
          AND YEAR(harvest_date) = ?
        GROUP BY farm_id
      `, [productId, farmIds, currentYear]);

      yields.forEach(yieldData => {
        yearlyYields[yieldData.farm_id] = {
          volume: parseFloat(yieldData.total_volume) || 0
        };
      });
    }

    // Process farms to include product names and yield data
    const processedFarms = farms.map(farm => {
      let productEntries = [];
      try {
        const productIds = JSON.parse(farm.products || '[]');
        productEntries = productIds.map(id => {
          const productName = productMap[id];
          return productName ? `${id}: ${productName}` : null;
        }).filter(Boolean);
      } catch (e) {
        console.error('Error parsing products for farm', farm.id, e);
      }

      return {
        ...farm,
        farmerId: farm.farmer_id,
        products: productEntries,
        area: farm.area ? parseFloat(farm.area) : 0,
        hectare: farm.area ? (parseFloat(farm.area) / 10000).toFixed(2) : 0,
        yield: yearlyYields[farm.id] || {
          volume: 0,
          value: 0
        }
      };
    });

    res.json({
      success: true,
      count: processedFarms.length,
      farms: processedFarms,
      currentYear: currentYear
    });

  } catch (error) {
    console.error('Failed to fetch farms by product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch farms',
      error: {
        code: 'FARMS_BY_PRODUCT_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});














router.post('/products', authenticate, async (req, res) => {
  try {
    const { name, description, sector_id, imageUrl } = req.body;
    const userId = req.user.dbUser.id; // Assuming you want to track who created the product

    // Validate required fields
    if (!name || !description || !sector_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        required: ['name', 'description', 'sector_id']
      });
    }

    // Check if sector exists
    const [sectorCheck] = await pool.query(
      'SELECT sector_id FROM sectors WHERE sector_id = ?',
      [sector_id]
    );

    if (sectorCheck.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sector_id',
        error: {
          code: 'INVALID_SECTOR',
          details: `Sector with ID ${sector_id} not found`
        }
      });
    }

    // Insert new product including optional imageUrl
    const [result] = await pool.query(
      `INSERT INTO farm_products 
   (name, description, sector_id, imgUrl, created_at, updated_at) 
   VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [name, description, sector_id, imageUrl || null]
    );

    // Get the newly created product with sector name
    const [newProduct] = await pool.query(
      `SELECT 
        p.id,
        p.name,
        p.description,
        p.imgUrl,
        p.created_at,
        p.updated_at,
        s.sector_name
      FROM farm_products p
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE p.id = ?`,
      [result.insertId]
    );

    if (newProduct.length === 0) {
      throw new Error('Failed to retrieve created product');
    }

    res.status(201).json({
      success: true,
      product: {
        id: newProduct[0].id,
        name: newProduct[0].name,
        description: newProduct[0].description,
        sector: newProduct[0].sector_name,
        imageUrl: newProduct[0].imgUrl,
        createdAt: newProduct[0].created_at,
        updatedAt: newProduct[0].updated_at
      }
    });

  } catch (error) {
    console.error('Failed to add product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add product',
      error: {
        code: 'PRODUCT_CREATION_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});


router.put('/products/:id', authenticate, async (req, res) => {
  try {
    const productId = req.params.id;
    const { name, description, sector_id, imageUrl } = req.body;
    const userId = req.user.dbUser.id; // Available if you want to track who modified the product

    // Validate required fields
    if (!name || !description || !sector_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        required: ['name', 'description', 'sector_id']
      });
    }

    // Check if product exists
    const [productCheck] = await pool.query(
      'SELECT id FROM farm_products WHERE id = ?',
      [productId]
    );

    if (productCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
        error: {
          code: 'PRODUCT_NOT_FOUND',
          details: `Product with ID ${productId} not found`
        }
      });
    }

    // Check if sector exists
    const [sectorCheck] = await pool.query(
      'SELECT sector_id FROM sectors WHERE sector_id = ?',
      [sector_id]
    );

    if (sectorCheck.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sector_id',
        error: {
          code: 'INVALID_SECTOR',
          details: `Sector with ID ${sector_id} not found`
        }
      });
    }

    // Update the product
    await pool.query(
      `UPDATE farm_products 
       SET 
         name = ?, 
         description = ?, 
         sector_id = ?, 
         imgUrl = ?, 
         updated_at = NOW()
       WHERE id = ?`,
      [name, description, sector_id, imageUrl || null, productId]
    );

    // Get the updated product with sector name
    const [updatedProduct] = await pool.query(
      `SELECT 
        p.id,
        p.name,
        p.description,
        p.imgUrl,
        p.created_at,
        p.updated_at,
        s.sector_name
      FROM farm_products p
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE p.id = ?`,
      [productId]
    );

    if (updatedProduct.length === 0) {
      throw new Error('Failed to retrieve updated product');
    }

    res.status(200).json({
      success: true,
      product: {
        id: updatedProduct[0].id,
        name: updatedProduct[0].name,
        description: updatedProduct[0].description,
        sector: updatedProduct[0].sector_name,
        imageUrl: updatedProduct[0].imgUrl,
        createdAt: updatedProduct[0].created_at,
        updatedAt: updatedProduct[0].updated_at
      }
    });

  } catch (error) {
    console.error('Failed to update product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product',
      error: {
        code: 'PRODUCT_UPDATE_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});








router.delete('/products/:id', authenticate, async (req, res) => {
  try {
    const productId = req.params.id;
    const userId = req.user.dbUser.id;
    const userSectorId = req.user.dbUser.sector_id;

    // First verify the product exists and belongs to the user's sector
    const [productCheck] = await pool.query(
      `SELECT p.id 
       FROM farm_products p
       WHERE p.id = ? 
       ${userSectorId ? 'AND p.sector_id = ?' : ''}`,
      userSectorId ? [productId, userSectorId] : [productId]
    );

    if (productCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or not authorized',
        error: {
          code: 'PRODUCT_NOT_FOUND',
          details: `Product with ID ${productId} not found in your sector`
        }
      });
    }

    // Delete the product
    await pool.query(
      'DELETE FROM farm_products WHERE id = ?',
      [productId]
    );

    res.json({
      success: true,
      message: 'Product deleted successfully',
      deletedId: productId
    });

  } catch (error) {
    console.error('Failed to delete product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete product',
      error: {
        code: 'PRODUCT_DELETION_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});










// GET a specific farmer by ID
router.get('/farmers/:id', authenticate, async (req, res) => {
  try {
    const farmerId = req.params.id;

    // Validate farmer ID
    if (!farmerId || isNaN(farmerId)) {
      return res.status(400).json({
        success: false, 
        message: 'Invalid farmer ID'
      });
    }

    const [farmers] = await pool.query(`
      SELECT 
        f.*,
        s.sector_name as sector,
        s.sector_id as sectorId,
        a.name as association_name,
        a.id as association_id,
        u.status as accountStatus
      FROM farmers f
      LEFT JOIN sectors s ON f.sector_id = s.sector_id 
      LEFT JOIN associations a ON f.assoc_id = a.id
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.id = ?
    `, [farmerId]);

    if (farmers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer not found'
      });
    }

    const farmer = farmers[0];

    res.json({
      success: true,
      farmer: {
        id: farmer.id,
        firstname: farmer.firstname,
        middlename: farmer.middlename || null,
        surname: farmer.surname || null,
        extension: farmer.extension || null,
        name: `${farmer.firstname}${farmer.middlename ? ' ' + farmer.middlename : ''}${farmer.surname ? ' ' + farmer.surname : ''}${farmer.extension ? ' ' + farmer.extension : ''}`,
        email: farmer.email,
        phone: farmer.phone,
        sex: farmer.sex,
        address: farmer.address,
        sector: farmer.sector,
        sectorId: farmer.sectorId ? String(farmer.sectorId) : null,
        imageUrl: farmer.imageUrl,
        barangay: farmer.barangay || null,
        contact: farmer.phone,
        farmName: farmer.farm_name,
        hectare: parseFloat(farmer.total_land_area) || 0,
        createdAt: farmer.created_at,
        updatedAt: farmer.updated_at,
        house_hold_head: farmer.house_hold_head,
        civil_status: farmer.civil_status || null,
        spouse_name: farmer.spouse_name || null,
        religion: farmer.religion || null,
        birthday: farmer.birthday ? new Date(farmer.birthday).toISOString().split('T')[0] : null, // Format as YYYY-MM-DD
        household_num: farmer.household_num,
        male_members_num: farmer.male_members_num || null,
        female_members_num: farmer.female_members_num || null,
        mother_maiden_name: farmer.mother_maiden_name || null,
        person_to_notify: farmer.person_to_notify || null,
        ptn_contact: farmer.ptn_contact || null,
        ptn_relationship: farmer.ptn_relationship || null,
        association: farmer.association_name || null,
        accountStatus: farmer.accountStatus || null // Added user status from users table
      }
    });

  } catch (error) {
    console.error('Failed to fetch farmer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch farmer',
      error: {
        code: 'FARMER_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});





// PUT update farmer
router.put('/farmers/:id', authenticate, async (req, res) => {
  try {
    const farmerId = req.params.id;
    const {
      firstname,
      middlename,
      surname,
      extension,
      email,
      phone,
      address,
      barangay,
      sectorId,
      imageUrl,
      farm_name,
      total_land_area,
      sex,
      house_hold_head,
      civil_status,
      spouse_name,
      religion,
      household_num,
      male_members_num,
      female_members_num,
      mother_maiden_name,
      person_to_notify,
      ptn_contact,
      ptn_relationship,
      accountStatus,
      association,
      birthday // Add birthday field
    } = req.body;

    // Validate required fields
    if (!firstname || !email || !phone || !barangay || !sectorId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        required: ['firstname', 'email', 'phone', 'barangay', 'sectorId']
      });
    }

    // Parse association ID if provided
    let assocId = null;
    if (association && association !== 'N/A') {
      const parts = association.split(':');
      if (parts.length > 0) {
        assocId = parseInt(parts[0].trim()) || null;
      }
    }

    // Parse birthday date if provided
    let birthdayDate = null;
    if (birthday) {
      try {
        // Parse the incoming date string (expecting ISO format: YYYY-MM-DD)
        const parsedDate = new Date(birthday);
        
        // Validate the date
        if (isNaN(parsedDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: 'Invalid birthday date format',
            error: {
              code: 'INVALID_BIRTHDAY',
              details: 'Birthday must be a valid date in format YYYY-MM-DD'
            }
          });
        }

        // Check if date is in the future
        if (parsedDate > new Date()) {
          return res.status(400).json({
            success: false,
            message: 'Birthday cannot be in the future',
            error: {
              code: 'FUTURE_BIRTHDAY',
              details: 'Birthday must be a date in the past'
            }
          });
        }

        // Format as YYYY-MM-DD for MySQL DATE type
        const year = parsedDate.getFullYear();
        const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
        const day = String(parsedDate.getDate()).padStart(2, '0');
        birthdayDate = `${year}-${month}-${day}`;
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: 'Invalid birthday date',
          error: {
            code: 'INVALID_BIRTHDAY',
            details: error.message
          }
        });
      }
    }

    // Check if farmer exists and get user_id
    const [farmerCheck] = await pool.query(
      'SELECT id, user_id FROM farmers WHERE id = ?',
      [farmerId]
    );

    if (farmerCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer not found',
        error: {
          code: 'FARMER_NOT_FOUND',
          details: `Farmer with ID ${farmerId} not found`
        }
      });
    }

    const userId = farmerCheck[0].user_id;

    // Check if email is being used by another farmer
    const [emailCheck] = await pool.query(
      'SELECT id FROM farmers WHERE email = ? AND id != ?',
      [email, farmerId]
    );

    if (emailCheck.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Email already in use by another farmer',
        error: {
          code: 'EMAIL_IN_USE',
          details: `Email ${email} is already registered to another farmer`
        }
      });
    }

    // Construct full name
    const name = `${firstname}${middlename ? ' ' + middlename : ''}${surname ? ' ' + surname : ''}${extension ? ' ' + extension : ''}`;

    // Update farmer - including the birthday column
    await pool.query(
      `UPDATE farmers SET 
        name = ?,
        firstname = ?,
        middlename = ?,
        surname = ?,
        extension = ?,
        email = ?,
        sex = ?,
        phone = ?,
        address = ?,
        barangay = ?,
        sector_id = ?,
        assoc_id = ?,
        imageUrl = ?,
        farm_name = ?,
        total_land_area = ?,
        house_hold_head = ?,
        civil_status = ?,
        spouse_name = ?,
        religion = ?,
        household_num = ?,
        male_members_num = ?,
        female_members_num = ?,
        mother_maiden_name = ?,
        person_to_notify = ?,
        ptn_contact = ?,
        ptn_relationship = ?,
        status = ?,
        birthday = ?,
        updated_at = NOW()
      WHERE id = ?`,
      [
        name,
        firstname,
        middlename || null,
        surname || null,
        extension || null,
        email,
        sex || null,
        phone,
        address || null,
        barangay,
        sectorId,
        assocId,
        imageUrl || null,
        farm_name || null,
        total_land_area || null,
        house_hold_head || null,
        civil_status || null,
        spouse_name || null,
        religion || null,
        household_num || null,
        male_members_num || null,
        female_members_num || null,
        mother_maiden_name || null,
        person_to_notify || null,
        ptn_contact || null,
        ptn_relationship || null,
        accountStatus || null,
        birthdayDate, // Add birthday to the query (already formatted as YYYY-MM-DD)
        farmerId
      ]
    );

    // Update user status if accountStatus is provided and user exists
    if (accountStatus && userId) {
      await pool.query(
        'UPDATE users SET status = ? WHERE id = ?',
        [accountStatus, userId]
      );
    }

    // Get the updated farmer with sector, association, and user info
    const [updatedFarmer] = await pool.query(
      `SELECT 
        f.*,
        s.sector_name as sector,
        s.sector_id as sectorId,
        a.name as association_name,
        a.id as association_id,
        u.status as user_status
      FROM farmers f
      LEFT JOIN sectors s ON f.sector_id = s.sector_id 
      LEFT JOIN associations a ON f.assoc_id = a.id
      LEFT JOIN users u ON f.user_id = u.id
      WHERE f.id = ?`,
      [farmerId]
    );

    const farmer = updatedFarmer[0];

    // Format the response
    res.json({
      success: true,
      farmer: {
        id: farmer.id,
        firstname: farmer.firstname,
        middlename: farmer.middlename || null,
        surname: farmer.surname || null,
        sex: farmer.sex || null,
        extension: farmer.extension || null,
        name: `${farmer.firstname}${farmer.middlename ? ' ' + farmer.middlename : ''}${farmer.surname ? ' ' + farmer.surname : ''}${farmer.extension ? ' ' + farmer.extension : ''}`,
        email: farmer.email,
        phone: farmer.phone,
        address: farmer.address,
        sector: farmer.sector,
        sectorId: farmer.sectorId ? String(farmer.sectorId) : null,
        imageUrl: farmer.imageUrl,
        barangay: farmer.barangay || null,
        contact: farmer.phone,
        farmName: farmer.farm_name,
        hectare: parseFloat(farmer.total_land_area) || 0,
        created_at: farmer.created_at,
        updated_at: farmer.updated_at,
        house_hold_head: farmer.house_hold_head,
        civil_status: farmer.civil_status || null,
        spouse_name: farmer.spouse_name || null,
        religion: farmer.religion || null,
        household_num: farmer.household_num || null,
        male_members_num: farmer.male_members_num || null,
        female_members_num: farmer.female_members_num || null,
        mother_maiden_name: farmer.mother_maiden_name || null,
        person_to_notify: farmer.person_to_notify || null,
        ptn_contact: farmer.ptn_contact || null,
        ptn_relationship: farmer.ptn_relationship || null,
        status: farmer.status || null,
        birthday: farmer.birthday ? farmer.birthday.toISOString().split('T')[0] : null, // Format as YYYY-MM-DD
        association: farmer.association_id ? 
          `${farmer.association_id}: ${farmer.association_name}` : null,
        associationId: farmer.association_id || null,
        user_status: farmer.user_status || null
      }
    });

  } catch (error) {
    console.error('Failed to update farmer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update farmer',
      error: {
        code: 'FARMER_UPDATE_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});








// DELETE farmer
router.delete('/farmers/:id', authenticate, async (req, res) => {
  try {
    const farmerId = req.params.id;

    // Check if farmer exists
    const [farmerCheck] = await pool.query(
      'SELECT id FROM farmers WHERE id = ?',
      [farmerId]
    );

    if (farmerCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer not found',
        error: {
          code: 'FARMER_NOT_FOUND',
          details: `Farmer with ID ${farmerId} not found`
        }
      });
    }

    // Delete the farmer
    await pool.query(
      'DELETE FROM farmers WHERE id = ?',
      [farmerId]
    );

    res.json({
      success: true,
      message: 'Farmer deleted successfully',
      deletedId: farmerId
    });

  } catch (error) {
    console.error('Failed to delete farmer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete farmer',
      error: {
        code: 'FARMER_DELETION_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});






router.get('/user-statistics', async (req, res) => {
  try {
    const { year } = req.query;

    // Helper function to add year filter
    const addYearFilter = (baseQuery, options = {}) => {
      let query = baseQuery;
      const params = [];

      if (year) {
        query += ` WHERE YEAR(${options.dateField || 'created_at'}) = ?`;
        params.push(year);
      }

      return { query, params };
    };

    // 1. Total users count
    const totalUsersQuery = addYearFilter(
      `SELECT COUNT(*) as totalUsers FROM users`
    );
    const [totalUsersResult] = await pool.query(totalUsersQuery.query, totalUsersQuery.params);

    // 2. Users by role
    const rolesQuery = addYearFilter(
      `SELECT role, COUNT(*) as count FROM users GROUP BY role`
    );
    const [rolesResult] = await pool.query(rolesQuery.query, rolesQuery.params);

    // Format roles data
    const roles = rolesResult.reduce((acc, row) => {
      acc[row.role] = row.count;
      return acc;
    }, {});

    // 3. New users this month (if year is current, otherwise count for the selected year)
    let newUsersQuery;
    let newUsersParams = [];

    if (year && year !== new Date().getFullYear().toString()) {
      // If filtering by a past year, count all users from that year
      newUsersQuery = `SELECT COUNT(*) as newUsers FROM users WHERE YEAR(created_at) = ?`;
      newUsersParams = [year];
    } else {
      // If no year filter or current year, count users from the last 30 days
      newUsersQuery = `SELECT COUNT(*) as newUsers FROM users WHERE created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)`;

      if (year) {
        // If current year is selected, ensure we're still within the year
        newUsersQuery += ` AND YEAR(created_at) = ?`;
        newUsersParams = [year];
      }
    }

    const [newUsersResult] = await pool.query(newUsersQuery, newUsersParams);

    // 4. Count inactive users
    const inactiveUsersQuery = addYearFilter(
      `SELECT COUNT(*) as inactiveUsers FROM users WHERE status = 'Inactive'`
    );
    const [inactiveUsersResult] = await pool.query(inactiveUsersQuery.query, inactiveUsersQuery.params);

    // Format the response data
    const responseData = {
      totalUsers: totalUsersResult[0]?.totalUsers || 0,
      inactiveUsers: inactiveUsersResult[0]?.inactiveUsers || 0,
      roles,
      newUsers: newUsersResult[0]?.newUsers || 0,
      year: year || 'all-time'
    };

    res.json({
      success: true,
      statistics: responseData
    });

  } catch (error) {
    console.error('Failed to fetch user statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user statistics',
      error: {
        code: 'USER_STATS_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage || 'No SQL error message'
      }
    });
  }
});



router.get('/sectors/stats', async (req, res) => {
  try {
    // Query to get all sectors with their statistics
    const [sectors] = await pool.query(`
      SELECT 
        s.sector_id,
        s.sector_name,
        COALESCE(SUM(f.area), 0) AS total_land_area,
        COUNT(DISTINCT f.farmer_id) AS total_farmers,
        COALESCE(SUM(fy.volume), 0) AS total_yield_volume,
        COALESCE(SUM(fy.Value), 0) AS total_yield_value
      FROM sectors s
      LEFT JOIN farm_products p ON s.sector_id = p.sector_id
      LEFT JOIN farms f ON JSON_CONTAINS(f.products, CONCAT('"', p.id, '"'), '$')
      LEFT JOIN farmer_yield fy ON fy.product_id = p.id AND fy.farm_id = f.farm_id
      GROUP BY s.sector_id, s.sector_name
      ORDER BY s.sector_name
    `);

    // Additional query to get yield trends by month for each sector
    const [yieldTrends] = await pool.query(`
      SELECT 
        s.sector_id,
        DATE_FORMAT(fy.harvest_date, '%Y-%m') AS month,
        SUM(fy.volume) AS monthly_volume,
        SUM(fy.Value) AS monthly_value
      FROM sectors s
      JOIN farm_products p ON s.sector_id = p.sector_id
      JOIN farmer_yield fy ON fy.product_id = p.id
      WHERE fy.harvest_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH)
      GROUP BY s.sector_id, DATE_FORMAT(fy.harvest_date, '%Y-%m')
      ORDER BY s.sector_id, month
    `);

    // Process the data to include yield trends with each sector
    const result = sectors.map(sector => {
      const trends = yieldTrends
        .filter(trend => trend.sector_id === sector.sector_id)
        .map(trend => ({
          month: trend.month,
          volume: parseFloat(trend.monthly_volume) || 0,
          value: parseFloat(trend.monthly_value) || 0
        }));

      return {
        sectorId: sector.sector_id,
        sectorName: sector.sector_name,
        totalLandArea: parseFloat(sector.total_land_area) || 0,
        totalFarmers: parseInt(sector.total_farmers) || 0,
        totalYieldVolume: parseFloat(sector.total_yield_volume) || 0,
        totalYieldValue: parseFloat(sector.total_yield_value) || 0,
        yieldTrends: trends
      };
    });

    res.json({
      success: true,
      sectors: result
    });
  } catch (error) {
    console.error('Failed to fetch sector statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sector statistics',
      error: {
        code: 'SECTOR_STATS_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});








// Protected route example
router.get('/profile', authenticate, (req, res) => {
  res.json({
    success: true,
    user: req.user.dbUser
  });
});

module.exports = router;