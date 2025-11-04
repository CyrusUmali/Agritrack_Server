// yieldsRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect');

 



router.get('/yield-data', authenticate ,  async (req, res) => {
    const { assocId, year } = req.query; // Get both from query params

    try {
        let query = `
            SELECT 
                fy.id,
                fy.farmer_id,
                fy.product_id,
                fy.harvest_date,
                fy.created_at,
                fy.updated_at,
                fy.farm_id,
                fy.volume,
                fy.notes,
                fy.Value,
                fy.images,
                fy.area_harvested,
                fy.status,
                f.barangay as farmer_barangay,
                f.assoc_id,
                f.firstname,
                f.middlename,
                f.surname,
                f.extension,
                p.name as product_name,
                p.sector_id,
                p.imgUrl as product_imgUrl,   
                s.sector_name,
                farm.area as farm_area,
                farm.farm_name,
                farm.parentBarangay,
                a.name as association_name
            FROM farmer_yield fy
            LEFT JOIN farmers f ON fy.farmer_id = f.id
            LEFT JOIN farm_products p ON fy.product_id = p.id
            LEFT JOIN sectors s ON p.sector_id = s.sector_id 
            LEFT JOIN farms farm ON fy.farm_id = farm.farm_id
            LEFT JOIN associations a ON f.assoc_id = a.id
            WHERE f.assoc_id = ? AND fy.status = 'Accepted'
        `;

        const queryParams = [assocId];

        // Add year filter if provided
        if (year) {
            query += ` AND YEAR(fy.harvest_date) = ?`;
            queryParams.push(year);
        }

        query += ` ORDER BY fy.harvest_date DESC`;

        const [yields] = await pool.query(query, queryParams);

        res.json({
            success: true,
            yields: yields.map(yieldItem => ({
                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                farmName: yieldItem.farm_name,
                productId: yieldItem.product_id,
                productName: yieldItem.product_name,
                productImage: yieldItem.product_imgUrl,
                harvestDate: yieldItem.harvest_date,
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                farmArea: yieldItem.farm_area ? parseFloat(yieldItem.farm_area) : null,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status || null,
                farmerBarangay: yieldItem.farmer_barangay,
                area_harvested: yieldItem.area_harvested ? parseFloat(yieldItem.area_harvested) : null,
                farmBarangay: yieldItem.parentBarangay,
                sectorId: yieldItem.sector_id,
                sector: yieldItem.sector_name || 'dummy',
                associationId: yieldItem.assoc_id,
                associationName: yieldItem.association_name
            })),
            summary: {
                associationId: assocId,
                associationName: yields.length > 0 ? yields[0].association_name : 'Unknown Association',
                totalYields: yields.length,
                totalVolume: yields.reduce((sum, item) => sum + parseFloat(item.volume), 0),
                totalValue: yields.reduce((sum, item) => sum + (item.Value ? parseFloat(item.Value) : 0), 0),
                totalAreaHarvested: yields.reduce((sum, item) => sum + (item.area_harvested ? parseFloat(item.area_harvested) : 0), 0)
            }
        });
    } catch (error) {
        console.error('Failed to fetch yields by association:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch yields by association',
            error: {
                code: 'YIELD_FETCH_BY_ASSOCIATION_ERROR',
                details: error.message,
                sqlMessage: error.sqlMessage
            }
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
          totalYieldValue: 0,
          totalAreaHarvested: 0,
          totalMetricTons: 0
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
        AVG(fm.area) as avg_farm_size
      FROM farmers f
      LEFT JOIN farms fm ON f.id = fm.farmer_id
      WHERE f.assoc_id IS NOT NULL
      GROUP BY f.assoc_id
    `);

    // Get yield statistics including area harvested and metric tons
    let yieldStatsQuery = `
      SELECT 
        f.assoc_id as associationId,
        COUNT(DISTINCT fy.id) as total_yields,
        SUM(fy.volume) as total_yield_volume,
        SUM(fy.Value) as total_yield_value,
        SUM(fy.area_harvested) as total_area_harvested,
        SUM(fy.volume) / 1000 as total_metric_tons
      FROM farmers f
      JOIN farms fm ON f.id = fm.farmer_id
      JOIN farmer_yield fy ON fm.farm_id = fy.farm_id
      WHERE f.assoc_id IS NOT NULL AND fy.status = 'Accepted'
    `;

    if (year) {
      yieldStatsQuery += ` AND YEAR(fy.harvest_date) = ?`;
    }

    yieldStatsQuery += ` GROUP BY f.assoc_id`;

    const [yieldStats] = year 
      ? await pool.query(yieldStatsQuery, [year])
      : await pool.query(yieldStatsQuery);

    // Get previous year stats for growth calculation if year is provided
    let growthMetricsMap = {};
    if (year) {
      const prevYear = parseInt(year) - 1;
      const [prevYearStats] = await pool.query(`
        SELECT 
          f.assoc_id as associationId,
          SUM(fy.volume) as total_yield_volume,
          SUM(fy.Value) as total_yield_value,
          SUM(fy.area_harvested) as total_area_harvested
        FROM farmers f
        JOIN farms fm ON f.id = fm.farmer_id
        JOIN farmer_yield fy ON fm.farm_id = fy.farm_id
        WHERE f.assoc_id IS NOT NULL AND YEAR(fy.harvest_date) = ? AND fy.status = 'Accepted'
        GROUP BY f.assoc_id
      `, [prevYear]);

      prevYearStats.forEach(row => {
        const currentYieldStats = yieldStats.find(s => s.associationId === row.associationId);
        if (currentYieldStats) {
          const currentVol = currentYieldStats.total_yield_volume || 0;
          const prevVol = row.total_yield_volume || 0;
          const currentVal = currentYieldStats.total_yield_value || 0;
          const prevVal = row.total_yield_value || 0;
          const currentArea = currentYieldStats.total_area_harvested || 0;
          const prevArea = row.total_area_harvested || 0;

          growthMetricsMap[row.associationId] = {
            yieldVolumeGrowth: prevVol ? ((currentVol - prevVol) / prevVol * 100) : 0,
            yieldValueGrowth: prevVal ? ((currentVal - prevVal) / prevVal * 100) : 0,
            areaHarvestedGrowth: prevArea ? ((currentArea - prevArea) / prevArea * 100) : 0
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
        SUM(fy.Value) as total_value,
        SUM(fy.area_harvested) as total_area_harvested,
        SUM(fy.volume) / 1000 as total_metric_tons
      FROM farmers f
      JOIN farms fm ON f.id = fm.farmer_id
      JOIN farmer_yield fy ON fm.farm_id = fy.farm_id
      WHERE f.assoc_id IS NOT NULL AND fy.status = 'Accepted'
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
        totalValue: parseFloat(row.total_value),
        totalAreaHarvested: parseFloat(row.total_area_harvested),
        metricTons: parseFloat(row.total_metric_tons)
      });
    });

    // Enhance associations with stats
    const enhancedAssociations = associations.map(assoc => {
      const stats = associationStats.find(s => s.associationId === assoc.id) || {};
      const yieldStat = yieldStats.find(s => s.associationId === assoc.id) || {};
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
          totalYields: yieldStat.total_yields ? parseInt(yieldStat.total_yields) : 0,
          totalYieldVolume: yieldStat.total_yield_volume ? parseFloat(yieldStat.total_yield_volume) : 0,
          totalYieldValue: yieldStat.total_yield_value ? parseFloat(yieldStat.total_yield_value) : 0,
 totalAreaHarvested: yieldStat.total_area_harvested ? 
    parseFloat(parseFloat(yieldStat.total_area_harvested).toFixed(2)) : 0,
          metricTons: yieldStat.total_metric_tons ? parseFloat(yieldStat.total_metric_tons) : 0,
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
      totalYieldValue: enhancedAssociations.reduce((sum, a) => sum + a.stats.totalYieldValue, 0),
      totalAreaHarvested: enhancedAssociations.reduce((sum, a) => sum + a.stats.totalAreaHarvested, 0),
      totalMetricTons: enhancedAssociations.reduce((sum, a) => sum + a.stats.metricTons, 0)
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
        totalYieldValue: sortedByMembers[0].stats.totalYieldValue,
        totalAreaHarvested: sortedByMembers[0].stats.totalAreaHarvested,
        metricTons: sortedByMembers[0].stats.metricTons
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
 





module.exports = router;