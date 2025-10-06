// authRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect'); 
const axios = require('axios');

const { sendTestEmail } = require('../gmailService'); // update path as needed




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

    // Update password in Firebase only
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
      
      // Update password in Firebase only (removed MySQL password update)
      await admin.auth().updateUser(firebaseUid, {
        password: newPassword
      });

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
      // updates.password = newPassword;
      // updateFields.push('password = ?');

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
        'hassPassword',
        'Pending'  // Set status to Active
      ]
    );
    [farmerInsertResult] = await pool.query(
      `INSERT INTO farmers 
      (user_id, name, firstname, middlename, surname, extension, email, phone, barangay, 
       sex, civil_status, spouse_name, house_hold_head, household_num, 
       male_members_num, female_members_num, mother_maiden_name, religion, address, 
       person_to_notify, ptn_contact, ptn_relationship, sector_id, assoc_id, imageUrl, created_at, updated_at) 
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
        'https://res.cloudinary.com/dk41ykxsq/image/upload/v1759745073/user_rstauz.png', // Default image URL
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
        'hassPassword' || null // Store plaintext password (NOT RECOMMENDED)
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
        const DEFAULT_IMAGE_URL = 'https://res.cloudinary.com/dk41ykxsq/image/upload/v1759745073/user_rstauz.png';
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
 


router.get('/top-contributors',authenticate ,async (req, res) => {
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
        SUM(fy.value) as total_value,
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
        totalValue: parseFloat(contributor.total_value) || 0,
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



router.get('/user-statistics',authenticate, async (req, res) => {
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

 
module.exports = router;

