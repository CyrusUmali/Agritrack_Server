// yieldsRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect');





router.get('/farm-statistics', authenticate , async (req, res) => {
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
    return 0x80987665;
    case 5: // fishery
      return 0xFF2196F3; 
    case 6: // organic
      return 0xFF9E9E9E; // Grey with 0.5 opacity equivalent
    default:
      return 0xFF2196F3; // Default blue color
  }
};



router.get('/farms-view' ,  async (req, res) => {
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
        farmStatus: farm.status, 
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



router.get('/farms', authenticate , async (req, res) => {
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





// DELETE farm by ID
router.delete('/farms/:id', authenticate,  async (req, res) => {
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

    const farm = existingFarm[0];

    // Archive all yield records associated with this farm
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
       WHERE fy.farm_id = ?`,
      [farmId]
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
        'DELETE FROM farmer_yield WHERE farm_id = ?',
        [farmId]
      );
    }

    // Delete the farm
    await pool.query(
      'DELETE FROM farms WHERE farm_id = ?',
      [farmId]
    );

    res.json({
      success: true,
      message: `Farm with ID ${farmId} deleted successfully`,
      archivedYields: yieldRecords.length
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







router.post('/farms/', authenticate, async (req, res) => {
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

    // Check user role and set status accordingly (case-insensitive)
    const userRole = req.user.dbUser.role; // Assuming role is stored in the user object
    const farmStatus = userRole && userRole.toLowerCase() === 'farmer' ? 'Inactive' : 'Active';

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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `;
    
    const [result] = await pool.query(insertQuery, [
      name,
      JSON.stringify(formattedVertices),
      barangay || 'San Diego',
      sectorId || 5,
      farmerId || null,
      JSON.stringify(products || ["Rice"]),
      area,
      description || null,
      farmStatus // Use the determined status
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
        parentBarangay: createdFarm.parentBarangay,
        status: createdFarm.status // Include status in response
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
router.put('/farms/:id', authenticate ,  async (req, res) => {
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

router.put('/farmsProfile/:id', authenticate , async (req, res) => {
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
  


router.get('/farms/:id', authenticate , async (req, res) => {
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



router.get('/farms/by-product/:productId', authenticate , async (req, res) => {
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
 





module.exports = router;
