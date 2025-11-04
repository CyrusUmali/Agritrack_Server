// yieldsRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect');

 
  


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


router.get('/farmer-statistics', authenticate,  async (req, res) => {
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

    // Format association as "id: assocname" if both exist
    const association = farmer.association_id && farmer.association_name 
      ? `${farmer.association_id}: ${farmer.association_name}`
      : null;

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
        association: association, // Now formatted as "id: assocname"
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
router.delete('/farmers/:id', authenticate ,  async (req, res) => {
  try {
    const farmerId = req.params.id;

    // Check if farmer exists and get user_id if available
    const [farmerCheck] = await pool.query(
      'SELECT id, user_id, firstname, middlename, surname, extension FROM farmers WHERE id = ?',
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

    const farmer = farmerCheck[0];
    const userId = farmer.user_id;
    const farmerName = `${farmer.firstname || ''} ${farmer.middlename || ''} ${farmer.surname || ''} ${farmer.extension || ''}`.trim();

    // Archive all yield records associated with this farmer
    const [yieldRecords] = await pool.query(
      `SELECT 
        fy.*,
        f.firstname,
        f.middlename,
        f.surname,
        f.extension,
        p.name as product_name,
        farm.farm_name
       FROM farmer_yield fy
       LEFT JOIN farmers f ON fy.farmer_id = f.id
       LEFT JOIN farm_products p ON fy.product_id = p.id
       LEFT JOIN farms farm ON fy.farm_id = farm.farm_id
       WHERE fy.farmer_id = ?`,
      [farmerId]
    );

    if (yieldRecords.length > 0) {
      // Insert yield records into archive table
      for (const yieldRecord of yieldRecords) {
        await pool.query(
          `INSERT INTO yield_archive 
           (yield_id, farmer_id, product_id, harvest_date, farm_id, volume, 
            notes, value, images, status, area_harvested, created_at, updated_at,
            farmer_name, product_name, farm_name, delete_date) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            yieldRecord.id,
            yieldRecord.farmer_id,
            yieldRecord.product_id,
            yieldRecord.harvest_date,
            yieldRecord.farm_id,
            yieldRecord.volume,
            yieldRecord.notes,
            yieldRecord.value,
            yieldRecord.images,
            yieldRecord.status,
            yieldRecord.area_harvested,
            yieldRecord.created_at,
            yieldRecord.updated_at,
            `${yieldRecord.firstname || ''} ${yieldRecord.middlename || ''} ${yieldRecord.surname || ''} ${yieldRecord.extension || ''}`.trim(),
            yieldRecord.product_name,
            yieldRecord.farm_name
          ]
        );
      }

      // Delete the yield records from the main table
      await pool.query(
        'DELETE FROM farmer_yield WHERE farmer_id = ?',
        [farmerId]
      );
    }

    // Delete farms associated with this farmer (no archiving)
    await pool.query(
      'DELETE FROM farms WHERE farmer_id = ?',
      [farmerId]
    );

    // Delete the farmer
    await pool.query(
      'DELETE FROM farmers WHERE id = ?',
      [farmerId]
    );

    // If farmer has an associated user account, delete it too
    if (userId && userId !== 0) {
      try {
        // Get user details including Firebase UID
        const [users] = await pool.query(
          'SELECT firebase_uid FROM users WHERE id = ?',
          [userId]
        );

        if (users.length > 0) {
          const firebaseUid = users[0].firebase_uid;

          // Delete from Firebase Auth
          try {
            await admin.auth().deleteUser(firebaseUid);
          } catch (firebaseError) {
            // If Firebase user not found, proceed with DB deletion
            if (firebaseError.code !== 'auth/user-not-found') {
              throw firebaseError;
            }
            console.warn(`Firebase user ${firebaseUid} not found, but proceeding with DB deletion`);
          }

          // Delete from MySQL users table
          await pool.query(
            'DELETE FROM users WHERE id = ?',
            [userId]
          );
        }
      } catch (userDeletionError) {
        console.error('Error deleting associated user account:', userDeletionError);
        // Continue with the farmer deletion even if user deletion fails
      }
    }

    res.json({
      success: true,
      message: 'Farmer deleted successfully',
      deletedId: farmerId,
      deletedUserId: userId && userId !== 0 ? userId : null,
      archivedYields: yieldRecords.length
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





module.exports = router;